// deno test --allow-read=blogs.json,fixtures --allow-net=127.0.0.1 --allow-env=SHELOB_ACCOUNT_ID
import {
  Blog,
  canonUrl,
  CITY,
  clean,
  decodeEntities,
  enrich,
  extractDesc,
  extractFeed,
  extractLinks,
  extractMeta,
  extractPage,
  extractSocials,
  extractTitle,
  feedStats,
  fillMissing,
  githubFromUrl,
  Hn,
  loadFeedTimes,
  mergeHn,
  normalize,
  sameSite,
  statsOf,
  Store,
  storeFromEnv,
  stripWww,
} from "./refresh.ts";
import {
  blogText,
  embed,
  embedMissing,
  htmlText,
  kmeans,
  loadPosts,
  loadTopics,
  loadVectors,
  postBody,
  tagBlogs,
} from "./topics.ts";

const assertEquals = (got: unknown, want: unknown, msg = "") => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg}\n  want: ${w}\n  got:  ${g}`);
};
const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

const BASE = "https://example.com/";
const HOMEPAGE = `<!doctype html>
<html><head>
<title>Foo &amp; Bar &#8212; notes</title>
<meta content="Systems &amp; stuff" name="description">
<meta name="keywords" content="systems, programming">
<meta name="twitter:creator" content="@foo">
<link rel="alternate" type="application/atom+xml" href="/atom.xml">
</head><body>
<a href="/about/">about</a>
<a href="https://www.example.com/now">now</a>
<a href="/posts?a=1&amp;b=2">posts</a>
<a data-href="https://github.com/spoof" href="HTTPS://WWW.GITHUB.COM/Foo">github</a>
<a href="https://github.com/Foo/some-repo">repo</a>
<a href="https://github.com/sponsors">sponsors</a>
<a href="https://twitter.com/Foo?ref_src=twsrc">tw</a>
<a href="https://x.com/foo">x</a>
<a href="https://x.com/intent/follow?screen_name=foo">follow</a>
<a href="https://bsky.app/profile/foo.example.com">bsky</a>
<a rel="me" href="https://hachyderm.io/@foo">mastodon</a>
<a rel="me" href="https://medium.com/@foo">medium</a>
<a rel="me" href="https://example.com/@foo">self-rel-me</a>
<a href="mailto:foo@example.com">mail</a>
<a href="javascript:void(0)">js</a>
<!-- <a href="https://github.com/ghost">commented out</a> -->
</body></html>`;

Deno.test("extractors on kitchen-sink homepage", () => {
  const links = extractLinks(HOMEPAGE, BASE);
  const own = links.filter((l) => stripWww(l.href.hostname) === "example.com");
  assertEquals(extractTitle(HOMEPAGE), "Foo & Bar — notes", "title");
  assertEquals(extractDesc(HOMEPAGE), "Systems & stuff", "desc");
  assertEquals(
    clean(extractMeta(HOMEPAGE, "keywords")),
    "systems, programming",
    "keywords",
  );
  assertEquals(
    extractPage(own, "about"),
    "https://example.com/about/",
    "about",
  );
  assertEquals(extractPage(own, "now"), "https://www.example.com/now", "now");
  assertEquals(extractFeed(links, own), "https://example.com/atom.xml", "feed");
  const posts = links.find((l) => l.href.pathname === "/posts");
  assertEquals(posts?.href.search, "?a=1&b=2", "entity-decoded href query");
  assert(
    !links.some((l) =>
      l.href.hostname === "github.com" && l.href.pathname === "/ghost"
    ),
    "commented-out link skipped",
  );
  assert(
    !links.some((l) => l.href.pathname === "/spoof"),
    "data-href not treated as href",
  );
  const s = extractSocials(links, "example.com", HOMEPAGE);
  assertEquals(s.github, "https://github.com/Foo", "github");
  assertEquals(s.x, "https://x.com/foo", "x");
  assertEquals(
    s.bluesky,
    "https://bsky.app/profile/foo.example.com",
    "bluesky",
  );
  assertEquals(
    s.mastodon,
    "https://hachyderm.io/@foo",
    "mastodon (self-host rel=me excluded)",
  );
});

Deno.test("socials: ambiguity and decoys", () => {
  const two = extractLinks(
    `<a href="https://github.com/alice"></a><a href="https://github.com/bob"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(two).github,
    undefined,
    "two github users -> unset",
  );
  const decoys = extractLinks(
    `<a href="https://someblog.io/@stranger"></a>
     <a rel="me" href="https://medium.com/@foo"></a>
     <a href="https://x.com/i/flow/login"></a>
     <a href="https://x.com/home"></a>
     <a href="https://x.com/i"></a>
     <a href="https://twitter.com/intent"></a>
     <a href="https://github.com/features"></a>
     <a href="https://github.com/sponsors"></a>
     <a href="https://github.com/about"></a>`,
    BASE,
  );
  assertEquals(extractSocials(decoys), {}, "all decoys rejected");
  const dupes = extractLinks(
    `<a href="https://twitter.com/Foo"></a><a href="https://x.com/foo/"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(dupes).x,
    "https://x.com/foo",
    "twitter+x same user -> one match",
  );
  const instance = extractLinks(
    `<a href="https://fosstodon.org/@foo"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(instance).mastodon,
    "https://fosstodon.org/@foo",
    "known instance without rel=me",
  );
  const prefixed = extractLinks(
    `<a href="https://mastodon.gamedev.place/@foo"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(prefixed).mastodon,
    "https://mastodon.gamedev.place/@foo",
    "mastodon.* prefix rule",
  );
  const mstdn = extractLinks(`<a href="https://mstdn.io/@foo"></a>`, BASE);
  assertEquals(
    extractSocials(mstdn).mastodon,
    "https://mstdn.io/@foo",
    "mstdn.* prefix rule",
  );
  const unknown = extractLinks(
    `<a href="https://randomsite.io/@foo"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(unknown).mastodon,
    undefined,
    "unknown host still needs rel=me",
  );
  const feedDecoy = extractLinks(
    `<a rel="alternate" type="application/rss+xml" href="https://other.com/feed.xml"></a>`,
    BASE,
  );
  assertEquals(
    extractFeed(feedDecoy, []),
    undefined,
    "rel=alternate anchors ignored; only <link> counts",
  );
});

Deno.test("socials: tier resolution", () => {
  const meVsPlain = extractLinks(
    `<a rel="me" href="https://github.com/author"></a>
     <a href="https://github.com/friend"></a>
     <a href="https://github.com/other"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(meVsPlain).github,
    "https://github.com/author",
    "rel=me beats ambiguous anchors",
  );
  const twoMe = extractLinks(
    `<a rel="me" href="https://github.com/one"></a><a rel="me" href="https://github.com/two"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(twoMe).github,
    undefined,
    "two rel=me claims -> unset",
  );
  const metaOnly = `<meta name="twitter:creator" content="@bar">`;
  assertEquals(
    extractSocials([], "", metaOnly).x,
    "https://x.com/bar",
    "twitter:creator meta alone",
  );
  const metaVsAnchors = extractLinks(
    `<a href="https://x.com/alice"></a><a href="https://x.com/bob"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(metaVsAnchors, "", metaOnly).x,
    "https://x.com/bar",
    "meta beats ambiguous anchors",
  );
  const meX = extractLinks(`<a rel="me" href="https://x.com/carol"></a>`, BASE);
  assertEquals(
    extractSocials(meX, "", metaOnly).x,
    "https://x.com/carol",
    "rel=me beats meta",
  );
  assertEquals(
    extractSocials(
      [],
      "",
      `<meta name="twitter:site" content="https://twitter.com/Baz">`,
    ).x,
    "https://x.com/Baz",
    "twitter:site url form",
  );
  assertEquals(
    extractSocials([], "", `<meta name="twitter:creator" content="@intent">`).x,
    undefined,
    "denylist applies to meta",
  );
  const meMasto = extractLinks(
    `<a rel="me" href="https://weird.example/@foo"></a><a href="https://fosstodon.org/@foo"></a>`,
    BASE,
  );
  assertEquals(
    extractSocials(meMasto).mastodon,
    "https://weird.example/@foo",
    "mastodon rel=me beats instance anchor",
  );
});

Deno.test("githubFromUrl", () => {
  assertEquals(
    githubFromUrl("https://foo.github.io"),
    "https://github.com/foo",
  );
  assertEquals(
    githubFromUrl("https://Foo-Bar.github.io/blog"),
    "https://github.com/foo-bar",
  );
  assertEquals(githubFromUrl("https://example.com"), undefined);
  assertEquals(
    githubFromUrl("https://a.b.github.io"),
    undefined,
    "nested subdomain rejected",
  );
  assertEquals(githubFromUrl("https://github.io"), undefined);
});

Deno.test("clean: junk and markup", () => {
  assertEquals(clean("Just a moment..."), undefined, "challenge title dropped");
  assertEquals(clean("  Attention Required! | Cloudflare "), undefined);
  assertEquals(
    clean("<script>alert(1)</script>Cool blog"),
    "Cool blog",
    "script body dropped with its tags",
  );
  assertEquals(clean("a < b > c"), "a b c", "stray angle brackets stripped");
  assertEquals(clean(""), undefined);
  assertEquals(clean("x".repeat(400))?.length, 300, "capped");
  assert(
    !/[\ud800-\udbff]$/.test(clean("x".repeat(299) + "🐸")!),
    "cap never splits a surrogate pair",
  );
  assertEquals(
    clean("A blog powered by Hashnode"),
    undefined,
    "host boilerplate dropped",
  );
  assertEquals(
    clean("ExampleSite description"),
    undefined,
    "theme boilerplate dropped",
  );
  assertEquals(clean("..."), undefined, "punctuation-only filler dropped");
  assertEquals(clean("&hellip;"), undefined, "...even once decoded");
  assertEquals(clean("🐸🐸🐸"), "🐸🐸🐸", "emoji are real content");
  assertEquals(
    clean("Posts &mdash; defn.io"),
    "Posts — defn.io",
    "common entities decoded",
  );
  assertEquals(clean("Julio Merino&rsquo;s blog"), "Julio Merino’s blog");
  assertEquals(decodeEntities("&amp;lt;"), "&lt;", "no double decode (named)");
  assertEquals(
    decodeEntities("&#38;lt;"),
    "&lt;",
    "no double decode (numeric)",
  );
});

// Bear Blog (and similar) themes sometimes dump their own unrendered
// machinery into the description meta tag instead of rendering it. These are
// real strings pulled from blogs.json before the fix.
Deno.test("clean: theme/template leakage", () => {
  assertEquals(
    clean("<style>body{color:red}</style>Cool blog"),
    "Cool blog",
    "style body dropped with its tags",
  );
  assertEquals(
    clean("<!-- nav --> Real content here"),
    "Real content here",
    "intact HTML comment dropped",
  );
  assertEquals(
    clean(
      "!-- Google tag (gtag.js) -- window.dataLayer = window.dataLayer || [];",
    ),
    undefined,
    "comment/script residue with no real content left",
  );
  assertEquals(
    clean(
      "˚ ✦ foolishly impractical, especially in the pursuit of ideals ✦ ˚ status (all) {{ posts|limit:5 }}",
    ),
    "˚ ✦ foolishly impractical, especially in the pursuit of ideals ✦ ˚ status (all)",
    "unrendered {{ liquid }} tag cut, real tagline kept",
  );
  assertEquals(
    clean("{{ posts }}..."),
    undefined,
    "pure template leakage, nothing to keep",
  );
  assertEquals(
    clean("{% for post in paginator.posts %} {{ post.title }}"),
    undefined,
    "unrendered {% jekyll %} block tag, not just {{ liquid }}",
  );
  assertEquals(
    clean(
      'Hi, Reader! Welcome to my blog, where I write about: div class="row" style="display: flex;"',
    ),
    "Hi, Reader! Welcome to my blog, where I write about:",
    "leaked bare tag+attrs cut, real intro kept",
  );
  assertEquals(
    clean('img src="https://example.com/a.jpg" alt="me"'),
    undefined,
    "leaked bare tag+attrs with nothing else",
  );
  assertEquals(
    clean(
      "window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);}",
    ),
    undefined,
    "GA snippet with no prose",
  );
  assertEquals(
    clean("Some homepage text......"),
    undefined,
    "Bear Blog's own unedited placeholder",
  );
  assertEquals(
    clean("Prove you're a human"),
    undefined,
    "bot-challenge title variant",
  );
  assertEquals(
    clean("35d43639-cd65-4101-afe6-7597c890a7dc Welcome to my blog!"),
    "Welcome to my blog!",
    "leaked UUID token stripped, real text kept",
  );
  assertEquals(
    clean("Thoughts on life -- and everything else"),
    "Thoughts on life -- and everything else",
    "a plain double-hyphen is not a comment marker",
  );
  assertEquals(
    clean("A class act, this one"),
    "A class act, this one",
    "the word class alone is not a leaked attribute",
  );
});

Deno.test("canonUrl", () => {
  assertEquals(
    canonUrl("https://Foo.COM"),
    "https://foo.com",
    "host lowercased, no bare slash",
  );
  assertEquals(canonUrl("https://foo.com/"), "https://foo.com");
  assertEquals(
    canonUrl("https://foo.com/blog/"),
    "https://foo.com/blog",
    "trailing slash dropped",
  );
  assertEquals(
    canonUrl("  https://foo.com/blog#x  "),
    "https://foo.com/blog",
    "trimmed, fragment dropped",
  );
  assertEquals(
    canonUrl("https://foo.com/f?format=xml"),
    "https://foo.com/f?format=xml",
    "query kept",
  );
});

Deno.test("normalize: drops what it cannot attribute to the blog", () => {
  const keep = normalize({
    url: "https://Foo.com/",
    title: " Foo  blog\t",
    desc: "A blog powered by Hashnode",
    about: "https://www.foo.com/about",
    now: "https://elsewhere.com/now",
    feed: "https://feeds.feedburner.com/foo",
    github: "https://github.com/panr",
    x: "https://twitter.com/Foo",
    hn: [{ ...hn("1"), url: "https://foo.com/p" }, hn("2")],
  });
  assertEquals(
    keep,
    {
      url: "https://foo.com",
      title: "Foo blog",
      about: "https://www.foo.com/about",
      feed: "https://feeds.feedburner.com/foo",
      x: "https://x.com/Foo",
      hn: [{ ...hn("1"), url: "https://foo.com/p" }],
    },
    "boilerplate desc, off-site now, theme-author github, off-site story all dropped",
  );
  assertEquals(
    Object.keys(
      normalize({ url: "https://a.com", hn: [], feed: "https://a.com" }),
    ),
    ["url"],
    "empty hn and self-referential feed dropped",
  );
  assertEquals(
    normalize({ url: "https://a.com", now: "https://www.a.com/now" }).now,
    "https://www.a.com/now",
    "www counts as the same host",
  );
  assertEquals(
    normalize({
      url: "https://x.medium.com",
      about: "https://medium.com/about",
    }).about,
    undefined,
    "platform about page is not the author's",
  );
  assertEquals(
    normalize({
      url: "https://a.com",
      hn: [{ ...hn("1"), url: "https://blog.a.com/p" }],
    }).hn?.length,
    1,
    "stories may live on a subdomain",
  );
  assertEquals(
    normalize({
      url: "https://a.com",
      title: "Julia Evans",
      desc: "julia evans",
    }).desc,
    undefined,
    "desc echoing the title dropped",
  );
  assertEquals(
    normalize({ url: "https://a.com", desc: "Julia Evans" }).desc,
    "Julia Evans",
    "desc kept when there is no title",
  );
  assertEquals(
    normalize({
      url: "https://gwern.net",
      feed: "https://gwern.substack.com/feed",
    }).feed,
    "https://gwern.substack.com/feed",
    "newsletter platform feed kept",
  );
  assertEquals(
    normalize({
      url: "https://a.com",
      feed: "https://somebodyelse.dev/rss.xml",
    }).feed,
    undefined,
    "unattributable feed dropped",
  );
  const hnTitle = normalize({
    url: "https://example.com",
    hn: [{ ...hn("1"), title: "a  b\n c" }],
  }).hn![0].title;
  assertEquals(hnTitle, "a b c", "story titles collapsed");
});

Deno.test("normalize: canonical key order and idempotence", () => {
  const messy: Blog = {
    hn: [hn("1")],
    x: "https://x.com/foo",
    url: "https://example.com",
    desc: "d",
    title: "t",
  };
  assertEquals(Object.keys(normalize(messy)), [
    "url",
    "title",
    "desc",
    "x",
    "hn",
  ], "fields sorted");
  const once = normalize(messy);
  assertEquals(normalize(once), once, "normalize is a fixed point");
});

Deno.test("feedStats: entry dates only, median cadence", () => {
  const rss =
    `<rss><channel><lastBuildDate>Sun, 09 Aug 2026 00:00:00 GMT</lastBuildDate>
    <item><pubDate>Sat, 01 Aug 2026 10:00:00 GMT</pubDate></item>
    <item><pubDate>Sat, 25 Jul 2026 10:00:00 GMT</pubDate></item>
    <item><pubDate>Sat, 11 Jul 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  assertEquals(feedStats(rss), {
    active_at: "2026-08-01T10:00:00Z",
    posts: 3,
    cadence: 10.5,
  }, "gaps of 7 and 14 days -> median 10.5");
  const atom = `<feed><updated>2026-08-09T00:00:00Z</updated>
    <entry><published>2026-08-05T00:00:00Z</published><updated>2026-08-08T00:00:00Z</updated></entry>
    <entry><updated>2026-08-01T00:00:00Z</updated></entry></feed>`;
  const a = feedStats(atom)!;
  assertEquals(
    a.active_at,
    "2026-08-05T00:00:00Z",
    "published beats updated; channel <updated> ignored",
  );
  assertEquals(a.posts, 2);
  assertEquals(
    feedStats(
      "<rss><channel><lastBuildDate>Sun, 09 Aug 2026 00:00:00 GMT</lastBuildDate></channel></rss>",
    ),
    undefined,
    "a generator timestamp is not a post",
  );
  assertEquals(
    feedStats(
      `<item><pubDate>1970-01-01</pubDate></item><item><pubDate>2099-01-01</pubDate></item>`,
    ),
    undefined,
    "placeholder and future dates dropped",
  );
  assertEquals(
    feedStats(`<item><pubDate>Sat, 01 Aug 2026 10:00:00 GMT</pubDate></item>`),
    { active_at: "2026-08-01T10:00:00Z", posts: 1 },
    "one post has no cadence",
  );
  // Plenty of feeds list oldest first; the newest post must win regardless.
  const ascending = `<feed>
    <entry><updated>2009-02-10T00:00:00Z</updated></entry>
    <entry><updated>2026-08-06T00:00:00Z</updated></entry></feed>`;
  assertEquals(
    feedStats(ascending)?.active_at,
    "2026-08-06T00:00:00Z",
    "oldest-first feeds still date to the newest entry",
  );
});

Deno.test("normalize: activity stats are tied to the feed", () => {
  const withFeed = normalize({
    url: "https://a.com",
    feed: "https://a.com/rss",
    active_at: "2026-08-01T10:00:00Z",
    posts: 12,
    cadence: 9.5,
  });
  assertEquals(withFeed.active_at, "2026-08-01T10:00:00Z");
  assertEquals([withFeed.posts, withFeed.cadence], [12, 9.5]);
  const noFeed = normalize({
    url: "https://a.com",
    active_at: "2026-08-01T10:00:00Z",
    posts: 12,
  });
  assertEquals(
    [noFeed.active_at, noFeed.posts],
    [undefined, undefined],
    "no feed -> stats cannot be refreshed, so they are dropped",
  );
  const bad = normalize(
    {
      url: "https://a.com",
      feed: "https://a.com/rss",
      active_at: "last tuesday",
      posts: -1,
      cadence: NaN,
    } as never,
  );
  assertEquals([bad.active_at, bad.posts, bad.cadence], [
    undefined,
    undefined,
    undefined,
  ], "malformed stats rejected");
  assertEquals(
    Object.keys(
      normalize({
        url: "https://a.com",
        cadence: 0,
        posts: 1,
        feed: "https://a.com/rss",
        title: "t",
      }),
    ),
    ["url", "title", "feed", "posts", "cadence"],
    "canonical order",
  );
});

Deno.test("sameSite", () => {
  assert(sameSite("www.taylor.town", "taylor.town"), "www stripped");
  assert(sameSite("blog.example.com", "example.com"), "subdomain matches");
  assert(!sameSite("example.com", "example.org"), "different sites");
  assert(!sameSite("notexample.com", "example.com"), "suffix needs a dot");
});

const hn = (id: string, points = 50): Hn => ({
  created_at: "2024-01-01T00:00:00Z",
  title: "t",
  url: "https://example.com/p",
  points,
  comments: 1,
  id,
});

Deno.test("mergeHn: union by id, refresh in place, curated stories survive", () => {
  assertEquals(mergeHn(undefined, []), [], "empty");
  assertEquals(
    mergeHn([hn("1")], []).map((h) => h.id),
    ["1"],
    "algolia miss keeps curated",
  );
  assertEquals(
    mergeHn([hn("1", 10)], [hn("1", 99)])[0].points,
    99,
    "refreshes points",
  );
  assertEquals(
    mergeHn([hn("1")], [hn("2")]).map((h) => h.id),
    ["1", "2"],
    "union, old order first",
  );
});

Deno.test("fillMissing: never overwrites", () => {
  const blog: Blog = { url: "https://example.com", title: "Curated", desc: "" };
  const n = fillMissing(blog, {
    title: "Scraped",
    desc: "New",
    feed: "https://example.com/rss",
    about: undefined,
  });
  assertEquals(blog.title, "Curated", "existing value kept");
  assertEquals(blog.desc, "New", "empty string counts as missing");
  assertEquals(blog.feed, "https://example.com/rss", "missing key filled");
  assertEquals(n, 2, "fill count");
  assert(!("about" in blog), "undefined fill values skipped");
});

const raw = await Deno.readTextFile("blogs.json");
const blogs: Blog[] = JSON.parse(raw);

Deno.test("blogs.json: structure", async () => {
  const topicNames = new Set(
    blogs.some((b: Blog) => b.tags)
      ? loadTopics(await Deno.readTextFile("topics.json")).map((t) => t.name)
      : [],
  );
  assert(Array.isArray(blogs) && blogs.length > 2000, "array of blogs");
  const KEYS = new Set([
    "url",
    "title",
    "desc",
    "keywords",
    "tags",
    "city",
    "about",
    "now",
    "feed",
    "active_at",
    "posts",
    "cadence",
    "github",
    "bluesky",
    "x",
    "mastodon",
    "hn",
  ]);
  const NUM_KEYS = new Set(["posts", "cadence"]);
  const URL_KEYS = new Set([
    "url",
    "about",
    "now",
    "feed",
    "github",
    "bluesky",
    "x",
    "mastodon",
  ]);
  const HN_KEYS = ["created_at", "title", "url", "points", "comments", "id"];
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const seen = new Map<string, number>();
  for (const [i, blog] of blogs.entries()) {
    const where = JSON.stringify(blog.url ?? blog);
    assert(
      typeof blog.url === "string" && blog.url.startsWith("https://"),
      `bad url: ${where}`,
    );
    const u = new URL(blog.url);
    const norm = stripWww(u.hostname) + u.pathname.replace(/\/$/, "");
    // A clean git merge can add a second copy of a blog that main already has.
    assert(
      !seen.has(norm),
      `duplicate blog: blogs.json[${
        seen.get(norm)
      }] and blogs.json[${i}] both resolve to ${JSON.stringify(norm)}.\n` +
        `  Expected one entry per blog. Merge the fields into one entry, delete the other, then run:\n` +
        `  deno run --allow-read=blogs.json --allow-write=blogs.json refresh.ts --fmt`,
    );
    seen.set(norm, i);
    for (const [k, v] of Object.entries(blog)) {
      assert(KEYS.has(k), `unknown field ${JSON.stringify(k)} in ${where}`);
      if (k === "hn") {
        assert(Array.isArray(v), `hn not an array in ${where}`);
        for (const item of v as Record<string, unknown>[]) {
          for (const hk of HN_KEYS) {
            const isNum = hk === "points" || hk === "comments";
            assert(
              isNum
                ? typeof item[hk] === "number"
                : typeof item[hk] === "string",
              `bad hn.${hk} in ${where}: ${JSON.stringify(item)}`,
            );
          }
          assert(
            ISO.test(item.created_at as string),
            `bad hn.created_at in ${where}: ${item.created_at}`,
          );
          assert(
            /^https?:\/\//.test(item.url as string),
            `bad hn.url in ${where}: ${item.url}`,
          );
        }
      } else if (NUM_KEYS.has(k)) {
        assert(
          typeof v === "number" && isFinite(v) && v >= 0,
          `bad ${k} in ${where}: ${v}`,
        );
        assert(blog.feed, `${k} without a feed in ${where}`);
      } else if (k === "tags") {
        assert(
          Array.isArray(v) && v.length &&
            v.every((t) => typeof t === "string" && topicNames.has(t)),
          `tags not in topics.json in ${where}: ${JSON.stringify(v)}`,
        );
      } else if (k === "city") {
        assert(
          typeof v === "string" && CITY.test(v),
          `bad city in ${where}: ${v}`,
        );
      } else if (k === "active_at") {
        assert(
          typeof v === "string" && ISO.test(v),
          `bad active_at in ${where}: ${v}`,
        );
        assert(blog.feed, `active_at without a feed in ${where}`);
      } else {
        assert(
          typeof v === "string" && v.trim().length,
          `bad ${k} in ${where}`,
        );
        if (URL_KEYS.has(k)) {
          assert(
            /^https?:\/\//.test(v as string),
            `bad ${k} scheme in ${where}: ${v}`,
          );
        }
      }
    }
  }
});

Deno.test("blogs.json: byte-stable serialization", () => {
  const out = JSON.stringify(blogs.map(normalize), null, 2) + "\n";
  if (out !== raw) {
    let i = 0;
    while (raw[i] === out[i]) i++;
    const line = raw.slice(0, i).split("\n").length;
    const at = Math.max(0, i - 20);
    throw new Error(
      `blogs.json is not normalized at line ${line}:\n` +
        `  file:   ${JSON.stringify(raw.slice(at, i + 40))}\n` +
        `  expect: ${JSON.stringify(out.slice(at, i + 40))}\n` +
        `run: deno run --allow-read=blogs.json --allow-write=blogs.json refresh.ts --fmt`,
    );
  }
});

const FIXTURE_ROWS = 7;
const FEED_A = "https://a.example/feed.xml";
const FEED_B = "https://b.example/rss";

// A fake R2 that serves the fixture part under each key in `parts`.
const withStore = async (
  o: { parts?: string[]; ranges?: number; builtAt?: string; rows?: number },
  fn: (store: Store, seen: string[]) => Promise<void>,
) => {
  const part = await Deno.readFile("fixtures/feed_item.parquet");
  const parts = o.parts ?? ["table/feed_item/t/part-0.parquet"];
  const seen: string[] = [];
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    const path = new URL(req.url).pathname;
    seen.push(
      `${req.method} ${path} ${
        req.headers.get("authorization")?.slice(0, 16)
      } ${req.headers.get("range") ?? ""}`,
    );
    if (path === "/bkt/table/feed_item.json") {
      return Response.json({
        table: "feed_item",
        rows: o.rows ?? FIXTURE_ROWS * parts.length,
        parts,
        built_at: o.builtAt ?? new Date().toISOString(),
      });
    }
    if (!parts.some((k) => path === "/bkt/" + k)) {
      return new Response("no", { status: 404 });
    }
    const m = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (!m) {
      return new Response(null, {
        headers: { "content-length": String(part.length) },
      });
    }
    const body = part.slice(Number(m[1]), Number(m[2]) + 1);
    return new Response(body, {
      status: o.ranges ?? 206,
      headers: { "content-length": String(body.length) },
    });
  });
  try {
    await fn({
      endpoint: `http://127.0.0.1:${server.addr.port}`,
      accessKeyId: "k",
      secretAccessKey: "s",
      bucket: "bkt",
    }, seen);
  } finally {
    await server.shutdown();
  }
};

const failsWith = async (p: Promise<unknown>, ...parts: string[]) => {
  const err = await p.then(() => "", (e) => String(e.message));
  assert(
    parts.every((x) => err.includes(x)),
    `expected an error with ${JSON.stringify(parts)}, got: ${err}`,
  );
};

Deno.test("loadFeedTimes: signed range reads of every part, then stats", async () => {
  await withStore({
    parts: [
      "table/feed_item/t/part-0.parquet",
      "table/feed_item/t/part-1.parquet",
    ],
  }, async (store, seen) => {
    const times = await loadFeedTimes(
      store,
      new Set([FEED_A, FEED_B, "https://none.example/rss"]),
    );
    assertEquals(
      [...times.keys()].sort(),
      [FEED_A, FEED_B],
      "other feeds and unwanted feeds dropped",
    );
    assertEquals(
      statsOf(times.get(FEED_A)!)?.posts,
      6,
      "the same part twice doubles the dated items: null dates dropped, 1970 left to statsOf",
    );
    assertEquals(statsOf(times.get(FEED_B)!), {
      active_at: "2026-06-01T00:00:00Z",
      posts: 2,
      cadence: 0,
    });
    assertEquals(
      seen.every((l) => l.includes("AWS4-HMAC-SHA256")),
      true,
      "every request is signed",
    );
    assertEquals(
      seen.some((l) => / bytes=\d+-\d+$/.test(l)),
      true,
      "the parquet read uses ranges",
    );
  });
});

Deno.test("loadFeedTimes: a bad store crashes with expected and received", async () => {
  await withStore({}, async (store) => {
    await failsWith(
      loadFeedTimes({ ...store, bucket: "nope" }, new Set([FEED_A])),
      "Expected: http 200",
      "Received: http 404",
    );
    await failsWith(
      loadFeedTimes(store, new Set(["https://none.example/rss"])),
      "No feed_item row matches",
      "none in",
    );
  });
  await withStore({ ranges: 200 }, async (store) => {
    await failsWith(
      loadFeedTimes(store, new Set([FEED_A])),
      "Expected: http 206",
      "Received: http 200",
    );
  });
  await withStore({
    builtAt: new Date(Date.now() - 49 * 3_600_000).toISOString(),
  }, async (store) => {
    await failsWith(
      loadFeedTimes(store, new Set([FEED_A])),
      "stale",
      "built_at",
    );
  });
  await withStore({ rows: FIXTURE_ROWS + 1 }, async (store) => {
    await failsWith(
      loadFeedTimes(store, new Set([FEED_A])),
      "partial feed_item table",
      `${FIXTURE_ROWS + 1} rows`,
    );
  });
});

Deno.test("enrich: a known feed is never fetched, a new feed waits for the store", async () => {
  const requested: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    return Promise.resolve(
      new Response(
        url.includes("hn.algolia.com")
          ? '{"hits":[]}'
          : "<html><title>t</title></html>",
        { status: url.includes("/feed.xml") ? 404 : 200 },
      ),
    );
  };
  try {
    const c = {
      filled: 0,
      pageOk: 0,
      pageFail: 0,
      hnOk: 0,
      hnFail: 0,
      feedOk: 0,
      feedUnseen: 0,
      categorized: 0,
    };
    const day = 86_400_000, t0 = Date.now() - 10 * day;
    const times = new Map([[FEED_A, [t0, t0 + 2 * day, t0 + 4 * day]]]);
    const known: Blog = {
      url: "https://a.example/",
      feed: FEED_A,
      cadence: 99,
    };
    const bare: Blog = { url: "https://bare.example/" };
    await enrich(known, c, times);
    await enrich(bare, c, times);
    assertEquals(
      [known.posts, known.cadence],
      [3, 2],
      "stats come from the store and replace the old cadence",
    );
    assertEquals(
      requested.includes(FEED_A),
      false,
      "the known feed is never requested",
    );
    assertEquals(
      requested.includes("https://bare.example/feed.xml"),
      true,
      "a blog with no feed still probes for one",
    );
    assertEquals([c.feedOk, c.feedUnseen], [1, 0]);
    await enrich(
      { url: "https://c.example/", feed: "https://c.example/rss" },
      c,
      times,
    );
    assertEquals(
      c.feedUnseen,
      1,
      "a feed with no rows in the store is counted",
    );
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("storeFromEnv: a missing variable names itself and the fix", () => {
  const was = Deno.env.get("SHELOB_ACCOUNT_ID");
  Deno.env.delete("SHELOB_ACCOUNT_ID");
  try {
    let msg = "";
    try {
      storeFromEnv();
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(
      msg.startsWith("SHELOB_ACCOUNT_ID is not set") &&
        msg.includes("copy SHELOB_ACCOUNT_ID into .env"),
      "names the variable and the fix: " + msg,
    );
  } finally {
    if (was !== undefined) Deno.env.set("SHELOB_ACCOUNT_ID", was);
  }
});

// A fake llama-cpp-embed: a bag of hashed words, so texts that share words sit near each other.
const withEmbedder = async (
  reply: ((input: string[]) => unknown) | undefined,
  fn: (endpoint: string, calls: string[][]) => Promise<void>,
) => {
  const calls: string[][] = [];
  const STOP = new Set(["clustering", "a", "and"]);
  const bag = (t: string) => {
    const v = Array(768).fill(0);
    for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) {
      if (STOP.has(w)) continue;
      let h = 0;
      for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 767;
      v[h]++;
    }
    v[767] = 0.01;
    return v;
  };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req) => {
      const { input } = await req.json();
      calls.push(input);
      if (input.some((t: string) => !t.isWellFormed())) {
        return new Response(
          "surrogate U+D800..U+DBFF must be followed by U+DC00..U+DFFF",
          { status: 400 },
        );
      }
      return Response.json(
        reply ? reply(input) : {
          data: input.map((t: string, index: number) => ({
            index,
            embedding: bag(t),
          })),
        },
      );
    },
  );
  try {
    await fn(`http://127.0.0.1:${server.addr.port}/v1/embeddings`, calls);
  } finally {
    await server.shutdown();
  }
};

const wrongReplies: ((input: string[]) => unknown)[] = [
  // too short
  (input) => ({
    data: input.map((_, index) => ({ index, embedding: [1, 2, 3] })),
  }),
  // infinite length
  (input) => ({
    data: input.map((_, index) => ({
      index,
      embedding: Array(768).fill(1e308),
    })),
  }),
  // out of order
  (input) => ({
    data: input.map((_, index) => ({
      index: input.length - 1 - index,
      embedding: Array(768).fill(1),
    })),
  }),
];

Deno.test("embed: a wrong reply crashes with expected and received", async () => {
  for (const reply of wrongReplies) {
    await withEmbedder(reply, (endpoint) =>
      failsWith(
        embed(["a", "b"], endpoint),
        "768-number vectors in input order",
        "received",
        "llama-cpp-embed",
      ));
  }
  await failsWith(
    embed(["a"], "http://127.0.0.1:9/v1/embeddings"),
    "expected 1 embeddings",
    "systemctl status llama-cpp-embed",
  );
});

Deno.test("topics: posts and bodies from feed_item; vectors.tsv resumes and drops a cut line", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/vectors.tsv`;
  try {
    await withStore(
      {},
      (store) =>
        withEmbedder(undefined, async (endpoint, calls) => {
          const posts = await loadPosts(store, new Set([FEED_A, FEED_B]));
          // The undated row is out; the 1970 row is dated.
          assertEquals(posts.get(FEED_A)!.map((p) => p.title), [
            "one",
            "two",
            "three",
            "zero",
          ]);
          const all = [...posts.values()].flat();
          let cache = await loadVectors(path);
          assertEquals(
            await embedMissing(store, all, cache, path, endpoint),
            5,
            "first run",
          );
          assert(
            calls.flat().every((t) => t.startsWith("clustering: ")),
            "task prefix",
          );
          await Deno.writeTextFile(path, `${FEED_A}\tcut\t0.1,0.2`, {
            append: true,
          });
          cache = await loadVectors(path);
          assertEquals(cache.size, 5, "the cut line is dropped");
          assert(
            (await Deno.readTextFile(path)).endsWith("\n"),
            "and the file repaired",
          );
          assertEquals(
            await embedMissing(store, all, cache, path, endpoint),
            0,
            "rerun",
          );
        }),
    );
    await Deno.writeTextFile(path, "x\ty\t1,2\n");
    await failsWith(
      loadVectors(path),
      "vectors.tsv:1",
      "768 comma-joined numbers",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("postBody: content over description, as text; a non-object crashes", () => {
  assertEquals(
    postBody({
      content: "<p>Hi &amp; <b>bye</b></p><script>x()</script>",
      description: "no",
    }, "w"),
    "Hi & bye",
  );
  assertEquals(
    postBody(JSON.stringify({ description: "<i>sum</i>" }), "w"),
    "sum",
  );
  assertEquals(postBody({}, "w"), "");
  assertEquals(htmlText("a<style>p{}</style>b"), "ab");
  let err = "";
  try {
    postBody(5, "part row 3");
  } catch (e) {
    err = String(e);
  }
  assert(err.includes("part row 3") && err.includes("gofeed item"), err);
});

const basis = (i: number, jitter = 0) => {
  const v = new Float32Array(768);
  v[i] = 1;
  v[767] = jitter;
  const n = Math.hypot(1, jitter);
  return v.map((x) => x / n);
};

Deno.test("kmeans: finds separate groups, the same way each run", () => {
  const points = [0, 1, 2].flatMap((g) =>
    Array.from({ length: 20 }, (_, i) => basis(g, i / 100))
  );
  const a = kmeans(points, 3);
  const b = kmeans(points, 3);
  assertEquals(Array.from(a.assign), Array.from(b.assign), "deterministic");
  for (const g of [0, 1, 2]) {
    assertEquals(
      new Set(a.assign.slice(g * 20, g * 20 + 20)).size,
      1,
      `group ${g}`,
    );
  }
  assertEquals(new Set(a.assign).size, 3, "three topics");
});

Deno.test("tagBlogs: the strongest topic, others at 20%, at most 3; none without points", () => {
  const topics = ["a", "b", "c", "d"].map((name, i) => ({
    name,
    centroid: basis(i),
  }));
  const blog = (url: string) => ({ url, tags: ["stale"] });
  const [x, y, z, w] = [
    blog("https://x"),
    blog("https://y"),
    blog("https://z"),
    blog("https://w"),
  ];
  const pts = (counts: number[]) =>
    counts.flatMap((n, i) => Array.from({ length: n }, () => basis(i)));
  const n = tagBlogs(
    [x, y, z, w],
    new Map([
      [x, pts([6, 3, 1])],
      [y, pts([3, 3, 2, 2])],
      [z, pts([1, 1, 1, 1, 0])],
    ]),
    topics,
  );
  assertEquals(n, 3);
  assertEquals([x.tags, y.tags, z.tags, w.tags], [["a", "b"], ["a", "b", "c"], [
    "a",
    "b",
    "c",
  ], undefined]);
});

Deno.test("loadTopics: unique slug names and 768-number centroids", () => {
  const t = (name: string) => ({
    name,
    posts: 1,
    examples: [],
    centroid: Array.from(basis(0)),
  });
  assertEquals(loadTopics(JSON.stringify([t("a"), t("b-c")])).length, 2);
  for (
    const bad of [[t("a"), t("a")], [t("Bad Name")], [{
      ...t("a"),
      centroid: [1],
    }], []]
  ) {
    let err = "";
    try {
      loadTopics(JSON.stringify(bad));
    } catch (e) {
      err = String(e);
    }
    assert(err.includes("topics.json: expected"), err);
  }
});

Deno.test("blogText: a blog needs more than a title, and its text stays well formed", () => {
  assertEquals(blogText({ url: "https://a", title: "Home" }), undefined);
  assertEquals(blogText({ url: "https://a", desc: "x\ud800y" }), "x\ufffdy");
  assertEquals(
    [
      ...blogText({
        url: "https://a",
        title: "x".repeat(1998),
        desc: "😀 music",
      })!,
    ].length,
    2000,
  );
});
