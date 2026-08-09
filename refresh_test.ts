// deno test --allow-read=blogs.json
import {
  Blog,
  clean,
  CYCLE,
  decodeEntities,
  extractDesc,
  extractFeed,
  extractLinks,
  extractMeta,
  extractPage,
  extractSocials,
  extractTitle,
  fillMissing,
  fnv1a,
  githubFromUrl,
  Hn,
  mergeHn,
  sameSite,
  shardOf,
  stripWww,
} from "./refresh.ts";

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
  assertEquals(clean(extractMeta(HOMEPAGE, "keywords")), "systems, programming", "keywords");
  assertEquals(extractPage(own, "about"), "https://example.com/about/", "about");
  assertEquals(extractPage(own, "now"), "https://www.example.com/now", "now");
  assertEquals(extractFeed(links, own), "https://example.com/atom.xml", "feed");
  const posts = links.find((l) => l.href.pathname === "/posts");
  assertEquals(posts?.href.search, "?a=1&b=2", "entity-decoded href query");
  assert(!links.some((l) => l.href.hostname === "github.com" && l.href.pathname === "/ghost"), "commented-out link skipped");
  assert(!links.some((l) => l.href.pathname === "/spoof"), "data-href not treated as href");
  const s = extractSocials(links, "example.com", HOMEPAGE);
  assertEquals(s.github, "https://github.com/Foo", "github");
  assertEquals(s.x, "https://x.com/foo", "x");
  assertEquals(s.bluesky, "https://bsky.app/profile/foo.example.com", "bluesky");
  assertEquals(s.mastodon, "https://hachyderm.io/@foo", "mastodon (self-host rel=me excluded)");
});

Deno.test("socials: ambiguity and decoys", () => {
  const two = extractLinks(
    `<a href="https://github.com/alice"></a><a href="https://github.com/bob"></a>`,
    BASE,
  );
  assertEquals(extractSocials(two).github, undefined, "two github users -> unset");
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
  assertEquals(extractSocials(dupes).x, "https://x.com/foo", "twitter+x same user -> one match");
  const instance = extractLinks(`<a href="https://fosstodon.org/@foo"></a>`, BASE);
  assertEquals(extractSocials(instance).mastodon, "https://fosstodon.org/@foo", "known instance without rel=me");
  const prefixed = extractLinks(`<a href="https://mastodon.gamedev.place/@foo"></a>`, BASE);
  assertEquals(extractSocials(prefixed).mastodon, "https://mastodon.gamedev.place/@foo", "mastodon.* prefix rule");
  const mstdn = extractLinks(`<a href="https://mstdn.io/@foo"></a>`, BASE);
  assertEquals(extractSocials(mstdn).mastodon, "https://mstdn.io/@foo", "mstdn.* prefix rule");
  const unknown = extractLinks(`<a href="https://randomsite.io/@foo"></a>`, BASE);
  assertEquals(extractSocials(unknown).mastodon, undefined, "unknown host still needs rel=me");
  const feedDecoy = extractLinks(
    `<a rel="alternate" type="application/rss+xml" href="https://other.com/feed.xml"></a>`,
    BASE,
  );
  assertEquals(extractFeed(feedDecoy, []), undefined, "rel=alternate anchors ignored; only <link> counts");
});

Deno.test("socials: tier resolution", () => {
  const meVsPlain = extractLinks(
    `<a rel="me" href="https://github.com/author"></a>
     <a href="https://github.com/friend"></a>
     <a href="https://github.com/other"></a>`,
    BASE,
  );
  assertEquals(extractSocials(meVsPlain).github, "https://github.com/author", "rel=me beats ambiguous anchors");
  const twoMe = extractLinks(
    `<a rel="me" href="https://github.com/one"></a><a rel="me" href="https://github.com/two"></a>`,
    BASE,
  );
  assertEquals(extractSocials(twoMe).github, undefined, "two rel=me claims -> unset");
  const metaOnly = `<meta name="twitter:creator" content="@bar">`;
  assertEquals(extractSocials([], "", metaOnly).x, "https://x.com/bar", "twitter:creator meta alone");
  const metaVsAnchors = extractLinks(
    `<a href="https://x.com/alice"></a><a href="https://x.com/bob"></a>`,
    BASE,
  );
  assertEquals(extractSocials(metaVsAnchors, "", metaOnly).x, "https://x.com/bar", "meta beats ambiguous anchors");
  const meX = extractLinks(`<a rel="me" href="https://x.com/carol"></a>`, BASE);
  assertEquals(extractSocials(meX, "", metaOnly).x, "https://x.com/carol", "rel=me beats meta");
  assertEquals(extractSocials([], "", `<meta name="twitter:site" content="https://twitter.com/Baz">`).x, "https://x.com/Baz", "twitter:site url form");
  assertEquals(extractSocials([], "", `<meta name="twitter:creator" content="@intent">`).x, undefined, "denylist applies to meta");
  const meMasto = extractLinks(
    `<a rel="me" href="https://weird.example/@foo"></a><a href="https://fosstodon.org/@foo"></a>`,
    BASE,
  );
  assertEquals(extractSocials(meMasto).mastodon, "https://weird.example/@foo", "mastodon rel=me beats instance anchor");
});

Deno.test("githubFromUrl", () => {
  assertEquals(githubFromUrl("https://foo.github.io"), "https://github.com/foo");
  assertEquals(githubFromUrl("https://Foo-Bar.github.io/blog"), "https://github.com/foo-bar");
  assertEquals(githubFromUrl("https://example.com"), undefined);
  assertEquals(githubFromUrl("https://a.b.github.io"), undefined, "nested subdomain rejected");
  assertEquals(githubFromUrl("https://github.io"), undefined);
});

Deno.test("clean: junk and markup", () => {
  assertEquals(clean("Just a moment..."), undefined, "challenge title dropped");
  assertEquals(clean("  Attention Required! | Cloudflare "), undefined);
  assertEquals(clean("<script>alert(1)</script>Cool blog"), "alert(1) Cool blog", "tags stripped");
  assertEquals(clean("a < b > c"), "a b c", "stray angle brackets stripped");
  assertEquals(clean(""), undefined);
  assertEquals(clean("x".repeat(400))?.length, 300, "capped");
  assertEquals(decodeEntities("&amp;lt;"), "&lt;", "no double decode (named)");
  assertEquals(decodeEntities("&#38;lt;"), "&lt;", "no double decode (numeric)");
});

Deno.test("fnv1a vectors + sameSite", () => {
  assertEquals(fnv1a(""), 0x811c9dc5);
  assertEquals(fnv1a("a"), 0xe40c292c);
  assertEquals(fnv1a("foobar"), 0xbf9cf968);
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
  assertEquals(mergeHn([hn("1")], []).map((h) => h.id), ["1"], "algolia miss keeps curated");
  assertEquals(mergeHn([hn("1", 10)], [hn("1", 99)])[0].points, 99, "refreshes points");
  assertEquals(mergeHn([hn("1")], [hn("2")]).map((h) => h.id), ["1", "2"], "union, old order first");
});

Deno.test("fillMissing: never overwrites", () => {
  const blog: Blog = { url: "https://example.com", title: "Curated", desc: "" };
  const n = fillMissing(blog, { title: "Scraped", desc: "New", feed: "https://example.com/rss", about: undefined });
  assertEquals(blog.title, "Curated", "existing value kept");
  assertEquals(blog.desc, "New", "empty string counts as missing");
  assertEquals(blog.feed, "https://example.com/rss", "missing key filled");
  assertEquals(n, 2, "fill count");
  assert(!("about" in blog), "undefined fill values skipped");
});

const raw = await Deno.readTextFile("blogs.json");
const blogs: Blog[] = JSON.parse(raw);

Deno.test("blogs.json: structure", () => {
  assert(Array.isArray(blogs) && blogs.length > 2000, "array of blogs");
  const KEYS = new Set(["url", "title", "desc", "keywords", "about", "now", "feed", "github", "bluesky", "x", "mastodon", "hn"]);
  const URL_KEYS = new Set(["url", "about", "now", "feed", "github", "bluesky", "x", "mastodon"]);
  const HN_KEYS = ["created_at", "title", "url", "points", "comments", "id"];
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  const seen = new Set<string>();
  for (const blog of blogs) {
    const where = JSON.stringify(blog.url ?? blog);
    assert(typeof blog.url === "string" && blog.url.startsWith("https://"), `bad url: ${where}`);
    const u = new URL(blog.url);
    const norm = stripWww(u.hostname) + u.pathname.replace(/\/$/, "");
    assert(!seen.has(norm), `duplicate blog: ${where}`);
    seen.add(norm);
    for (const [k, v] of Object.entries(blog)) {
      assert(KEYS.has(k), `unknown field ${JSON.stringify(k)} in ${where}`);
      if (k === "hn") {
        assert(Array.isArray(v), `hn not an array in ${where}`);
        for (const item of v as Record<string, unknown>[]) {
          for (const hk of HN_KEYS) {
            const isNum = hk === "points" || hk === "comments";
            assert(
              isNum ? typeof item[hk] === "number" : typeof item[hk] === "string",
              `bad hn.${hk} in ${where}: ${JSON.stringify(item)}`,
            );
          }
          assert(ISO.test(item.created_at as string), `bad hn.created_at in ${where}: ${item.created_at}`);
          assert(/^https?:\/\//.test(item.url as string), `bad hn.url in ${where}: ${item.url}`);
        }
      } else {
        assert(typeof v === "string" && v.trim().length, `bad ${k} in ${where}`);
        if (URL_KEYS.has(k)) assert(/^https?:\/\//.test(v as string), `bad ${k} scheme in ${where}: ${v}`);
      }
    }
  }
});

Deno.test("blogs.json: shard distribution is even-ish", () => {
  const counts = new Array(CYCLE).fill(0);
  for (const blog of blogs) counts[shardOf(blog.url)]++;
  const avg = blogs.length / CYCLE;
  for (const [shard, n] of counts.entries())
    assert(n > avg / 2 && n < avg * 2, `shard ${shard} has ${n} blogs (avg ${avg.toFixed(0)})`);
});

// Contributor PRs may hand-format entries; the daily job renormalizes.
const isPr =
  Deno.permissions.querySync({ name: "env", variable: "GITHUB_EVENT_NAME" }).state === "granted" &&
  Deno.env.get("GITHUB_EVENT_NAME") === "pull_request";

Deno.test({ name: "blogs.json: byte-stable serialization", ignore: isPr }, () => {
  const out = JSON.stringify(blogs, null, 2) + "\n";
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
