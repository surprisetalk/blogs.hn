// deno run --allow-net --allow-read=blogs.json --allow-write=blogs.json refresh.ts
//   (no args)     refresh today's shard of blogs.json in place
//   --all         refresh every blog
//   --fmt         reserialize blogs.json, no network
//   <url>...      print fresh entries for new blogs to stdout

export const CYCLE = 14;
const CONCURRENCY = 8;
const TIMEOUT = 10_000;
const MAX_HTML = 512 * 1024;
const UA = "blogs.hn-bot/1 (+https://blogs.hn)";

export type Hn = {
  created_at: string;
  title: string;
  url: string;
  points: number;
  comments: number;
  id: string;
};

export const FILLABLE = [
  "title",
  "desc",
  "keywords",
  "about",
  "now",
  "feed",
  "github",
  "bluesky",
  "x",
  "mastodon",
] as const;

// Derived from the feed, not scraped: active_at is the newest post date,
// posts is how many dated entries the feed carries, and cadence is the median
// gap between consecutive posts in days. Median rather than mean so one
// six-year hiatus does not describe a weekly blog as dormant.
export type Blog = { url: string; hn?: Hn[]; active_at?: string; posts?: number; cadence?: number } & {
  [K in (typeof FILLABLE)[number]]?: string;
};

export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

export const shardOf = (url: string): number => fnv1a(url) % CYCLE;

const ENT: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“",
  rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•", deg: "°",
  times: "×", copy: "©", reg: "®", trade: "™",
};

export const decodeEntities = (s: string): string =>
  s.replace(
    new RegExp(`&(?:#x([0-9a-f]+)|#(\\d+)|(${Object.keys(ENT).join("|")}));`, "gi"),
    (_, hex, dec, name) =>
      name ? ENT[name.toLowerCase()] : cp(parseInt(hex ?? dec, hex ? 16 : 10)),
  );

const cp = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

// Bot-blocks, plus unedited theme/host boilerplate that describes the
// generator instead of the blog.
const JUNK =
  /^(just a moment|attention required|access denied|checking your browser|please wait|verifying you are human|403 forbidden|404|example domain|a blog powered by hashnode|examplesite description|description will go into a meta tag|a minimal, responsive and feature-rich jekyll theme|minimal hugo blog theme|jekyll twitter bootstrap is a jekyll theme|front page content this website is powered by gitlab pages|what.s a website description like you doing)/i;

export const clean = (s?: string): string | undefined => {
  if (!s) return undefined;
  const t = decodeEntities(s)
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    // deno-lint-ignore no-control-regex
    .replace(/[<>\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .replace(/[\ud800-\udbff]$/, "")
    .trim();
  // Requires a letter, a digit, or an emoji: "..." and "…" are theme filler,
  // but a wall of frogs is a real description.
  return !t || JUNK.test(t) || !/[\p{L}\p{N}\p{So}]/u.test(t) ? undefined : t;
};

export type Link = { tag: string; href: URL; rel: string; type: string };

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(
    new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"),
  );
  return m && decodeEntities(m[2] ?? m[3] ?? m[4]) || undefined;
};

export const extractLinks = (html: string, base: string): Link[] => {
  const links: Link[] = [];
  const visible = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const [tag, name] of visible.matchAll(/<(a|link)\b[^>]*>/gi)) {
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      const url = new URL(href, base);
      url.hash = "";
      if (url.protocol === "http:" || url.protocol === "https:")
        links.push({
          tag: name.toLowerCase(),
          href: url,
          rel: (attr(tag, "rel") ?? "").toLowerCase(),
          type: (attr(tag, "type") ?? "").toLowerCase(),
        });
    } catch {
      // unparseable href
    }
  }
  return links;
};

export const extractTitle = (html: string): string | undefined =>
  clean(html.match(/<title[^>]*>([^<]*)/i)?.[1]);

export const extractMeta = (html: string, key: string): string | undefined => {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi))
    if ((attr(tag, "name") ?? attr(tag, "property"))?.toLowerCase() === key)
      return attr(tag, "content");
};

export const extractDesc = (html: string): string | undefined =>
  clean(extractMeta(html, "description") ?? extractMeta(html, "og:description"));

const FEED_PATH = /(\/index\.xml|\/rss\.xml|\/feed\.xml|\/atom\.xml|\/rss|\/feed|\.atom)$/;

export const extractFeed = (all: Link[], own: Link[]): string | undefined => {
  const alt = all.find(
    (l) =>
      l.tag === "link" &&
      l.rel.split(/\s+/).includes("alternate") &&
      /application\/(rss|atom)\+xml/.test(l.type),
  );
  return (alt ?? own.find((l) => FEED_PATH.test(l.href.pathname)))?.href.href;
};

export const extractPage = (own: Link[], name: string): string | undefined =>
  own.find((l) => l.href.pathname.replace(/\/$/, "") === `/${name}`)?.href.href;

export const stripWww = (host: string): string =>
  host.toLowerCase().replace(/^(www|mobile)\./, "");

export const sameSite = (a: string, b: string): boolean => {
  const [x, y] = [stripWww(a), stripWww(b)];
  return x === y || x.endsWith("." + y) || y.endsWith("." + x);
};

// panr authors a popular Hugo theme; ghost/svbtle/tumblr are host platforms.
// Their links ride along in footers and get mistaken for the blog's author.
const GH_DENY = new Set("about apps blog collections contact customer-stories enterprise events explore features join login marketplace notifications orgs panr pricing readme security settings site sponsors team topics trending".split(" "));
const X_DENY = new Set("explore ghost hashtag home i intent login messages notifications panr privacy search settings share signup svbtle tos tumblr".split(" "));
// mastodon.* and mstdn.* hosts match by prefix; this list is the rest.
const MASTO_HOSTS = new Set("fosstodon.org hachyderm.io infosec.exchange mas.to chaos.social indieweb.social techhub.social mathstodon.xyz sigmoid.social functional.cafe merveilles.town octodon.social social.coop scholar.social fediscience.org hci.social discuss.systems types.pl ruby.social phpc.social front-end.social social.tchncs.de tech.lgbt universeodon.com masto.ai c.im toot.community social.vivaldi.net metalhead.club social.linux.pizza mamot.fr norden.social troet.cafe det.social aus.social mastodonapp.uk tilde.zone vis.social peoplemaking.games gamedev.lgbt pawoo.net".split(" "));
const isMastoInstance = (host: string): boolean =>
  MASTO_HOSTS.has(host) || /^(mastodon|mstdn)\./.test(host);
const RELME_DENY = new Set("medium.com youtube.com threads.net tiktok.com instagram.com facebook.com linkedin.com twitch.tv twitter.com x.com bsky.app github.com".split(" "));

export type Socials = { github?: string; bluesky?: string; x?: string; mastodon?: string };

export const githubFromUrl = (url: string): string | undefined => {
  const m = stripWww(new URL(url).hostname).match(
    /^([a-z\d](?:[a-z\d-]*[a-z\d])?)\.github\.io$/,
  );
  return m ? `https://github.com/${m[1]}` : undefined;
};

const xHandle = (s?: string): string | undefined => {
  if (!s) return undefined;
  const h = s.trim()
    .replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?]/)[0];
  return /^\w{1,15}$/.test(h) && !X_DENY.has(h.toLowerCase()) ? h : undefined;
};

// Candidates are tiered by author intent: rel="me" identity claims beat
// twitter:creator/site meta, which beat plain anchors (could link anyone).
// Within the winning tier, exactly one distinct profile must remain.
type Tiers = { me: Map<string, string>; meta: Map<string, string>; plain: Map<string, string> };

export const extractSocials = (links: Link[], selfHost = "", html = ""): Socials => {
  const tiers = (): Tiers => ({ me: new Map(), meta: new Map(), plain: new Map() });
  const found: Record<keyof Socials, Tiers> = {
    github: tiers(),
    bluesky: tiers(),
    x: tiers(),
    mastodon: tiers(),
  };
  for (const { href, rel } of links) {
    const me = rel.split(/\s+/).includes("me");
    const host = stripWww(href.hostname);
    const path = href.pathname.replace(/\/$/, "");
    const seg = path.split("/").filter(Boolean);
    const put = (net: keyof Socials, key: string, url: string) =>
      found[net][me ? "me" : "plain"].set(key.toLowerCase(), url);
    if (
      host === "github.com" &&
      seg.length === 1 &&
      /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(seg[0]) &&
      !GH_DENY.has(seg[0].toLowerCase())
    )
      put("github", seg[0], `https://github.com/${seg[0]}`);
    if (
      (host === "x.com" || host === "twitter.com") &&
      seg.length === 1 &&
      /^\w{1,15}$/.test(seg[0]) &&
      !X_DENY.has(seg[0].toLowerCase())
    )
      put("x", seg[0], `https://x.com/${seg[0]}`);
    if (host === "bsky.app" && seg.length === 2 && seg[0] === "profile")
      put("bluesky", seg[1], `https://bsky.app/profile/${seg[1]}`);
    if (/^\/(@[^/]+|users\/[^/]+)$/.test(path) && host !== selfHost) {
      if (me && !RELME_DENY.has(host))
        found.mastodon.me.set(host + path.toLowerCase(), href.origin + path);
      else if (!me && isMastoInstance(host))
        found.mastodon.plain.set(host + path.toLowerCase(), href.origin + path);
    }
  }
  const creator = xHandle(extractMeta(html, "twitter:creator") ?? extractMeta(html, "twitter:site"));
  if (creator) found.x.meta.set(creator.toLowerCase(), `https://x.com/${creator}`);
  const one = (t: Tiers) => {
    for (const m of [t.me, t.meta, t.plain])
      if (m.size) return m.size === 1 ? m.values().next().value : undefined;
  };
  return {
    github: one(found.github),
    bluesky: one(found.bluesky),
    x: one(found.x),
    mastodon: one(found.mastodon),
  };
};

// Platforms where a blog's feed legitimately lives off-site (a custom domain
// fronting a newsletter). Everything else off-site is a build artifact, a
// placeholder, or somebody else's blog.
const FEED_HOSTS = "feedburner.com feedpress.me buttondown.email buttondown.com substack.com beehiiv.com ghost.io blogspot.com wordpress.com micro.blog bearblog.dev write.as tumblr.com".split(" ");

const isFeedHost = (host: string): boolean =>
  FEED_HOSTS.some((f) => host === f || host.endsWith("." + f));

const KEYS = ["url", "title", "desc", "keywords", "about", "now", "feed", "active_at", "posts", "cadence", "github", "bluesky", "x", "mastodon", "hn"] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const canonUrl = (raw: string): string => {
  const u = new URL(raw.trim());
  return (u.origin + u.pathname).replace(/\/+$/, "") + u.search;
};

// Round-trips a stored handle through the extractor so saved socials obey
// the same rules as scraped ones. rel=me because a stored value is a claim.
const canonSocial = (net: keyof Socials, raw: string, selfHost: string): string | undefined => {
  try {
    return extractSocials([{ tag: "a", href: new URL(raw), rel: "me", type: "" }], selfHost)[net];
  } catch {
    return undefined;
  }
};

// The single gate every blog passes before it is written. Refresh fills
// fields optimistically; this is what decides they are allowed to stay.
export const normalize = (blog: Blog): Blog => {
  const url = canonUrl(blog.url);
  const host = stripWww(new URL(url).hostname);
  const out: Blog = { url };
  const parse = (raw: string): URL | undefined => {
    try {
      return new URL(raw);
    } catch {
      return undefined;
    }
  };
  const onSite = (raw: string): boolean => {
    const u = parse(raw);
    return !!u && sameSite(u.hostname, host);
  };
  // extractPage only ever returns links whose host matches exactly, so
  // anything looser is stale. It is how medium.com/about ends up filed
  // under a dozen *.medium.com blogs.
  const sameHost = (raw: string): boolean => {
    const u = parse(raw);
    return !!u && stripWww(u.hostname) === host;
  };
  const feedOk = (raw: string): boolean => {
    const u = parse(raw);
    return !!u && canonUrl(raw) !== url &&
      (sameSite(u.hostname, host) || isFeedHost(stripWww(u.hostname)));
  };
  for (const key of KEYS) {
    if (key === "url") continue;
    if (key === "hn") {
      const hn = (blog.hn ?? [])
        .filter((h) => onSite(h.url))
        .map((h) => ({ ...h, title: h.title.replace(/\s+/g, " ").trim() }));
      if (hn.length) out.hn = hn;
      continue;
    }
    // Activity stats describe the stored feed. Without one they cannot be
    // refreshed or checked, so they do not get to outlive it.
    if (key === "active_at" || key === "posts" || key === "cadence") {
      const v = blog[key];
      if (!out.feed) continue;
      if (key === "active_at") {
        if (typeof v === "string" && ISO.test(v) && !isNaN(Date.parse(v))) out.active_at = v;
      } else if (typeof v === "number" && isFinite(v) && v >= 0) {
        out[key] = v;
      }
      continue;
    }
    const raw = blog[key];
    if (typeof raw !== "string") continue;
    const val = key === "title" || key === "desc" || key === "keywords"
      ? clean(raw)
      : key === "about" || key === "now"
      ? (sameHost(raw) ? raw : undefined)
      : key === "feed"
      ? (feedOk(raw) ? raw : undefined)
      : canonSocial(key, raw, host);
    if (!val) continue;
    // KEYS puts title first, so out.title is settled by now. A desc that only
    // repeats it renders as the same line twice.
    if (key === "desc" && val.toLowerCase() === out.title?.toLowerCase()) continue;
    out[key] = val;
  }
  return out;
};

export const fetchHtml = async (url: string): Promise<string> => {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/text\/html|application\/xhtml/.test(type))
    throw new Error(`content-type ${type}`);
  if (!sameSite(new URL(res.url).hostname, new URL(url).hostname))
    throw new Error(`redirected to ${res.url}`);
  if (body.includes("�")) throw new Error("mojibake");
  return body.slice(0, MAX_HTML);
};

// Entry dates only. A channel-level <lastBuildDate> ticks every time the
// generator runs, so it says nothing about whether anyone is still writing.
export const feedDates = (xml: string): number[] => {
  const out: number[] = [];
  const now = Date.now();
  for (const m of xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi)) {
    const block = m[2];
    const raw = block.match(/<(?:pubDate|published|dc:date)>([^<]+)</i)?.[1] ??
      block.match(/<updated>([^<]+)</i)?.[1];
    const t = raw && Date.parse(raw.trim());
    // Clock-skewed and placeholder dates are worse than no date at all.
    if (t && !isNaN(t) && t > Date.UTC(1990, 0, 1) && t < now + 86_400_000) out.push(t);
  }
  return out.sort((a, b) => b - a);
};

export type FeedStats = { active_at: string; posts: number; cadence?: number };

export const feedStats = (xml: string): FeedStats | undefined => {
  const dates = feedDates(xml);
  if (!dates.length) return undefined;
  const gaps = dates.slice(1).map((t, i) => (dates[i] - t) / 86_400_000).sort((a, b) => a - b);
  const mid = gaps.length && (gaps.length % 2
    ? gaps[(gaps.length - 1) / 2]
    : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2);
  return {
    active_at: new Date(dates[0]).toISOString().replace(/\.\d+Z$/, "Z"),
    posts: dates.length,
    ...(gaps.length ? { cadence: Math.round(mid as number * 10) / 10 } : {}),
  };
};

export const fetchFeed = async (url: string): Promise<FeedStats | undefined> => {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}`);
  return feedStats(body.slice(0, MAX_HTML));
};

export const fetchHn = async (blogUrl: string): Promise<Hn[]> => {
  const res = await fetch(
    `https://hn.algolia.com/api/v1/search` +
      `?tags=story` +
      `&restrictSearchableAttributes=url` +
      `&query=${encodeURIComponent(blogUrl.replace(/^https?:\/\//, ""))}`,
    { signal: AbortSignal.timeout(TIMEOUT) },
  );
  if (!res.ok) throw new Error(`hn.algolia.com ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.hits))
    throw new Error(`hn.algolia.com: no hits array: ${JSON.stringify(data).slice(0, 200)}`);
  const blogHost = new URL(blogUrl).hostname;
  const hits: Hn[] = [];
  for (const hit of data.hits) {
    if (typeof hit.url !== "string") continue;
    let host;
    try {
      host = new URL(hit.url).hostname;
    } catch {
      continue;
    }
    if (!sameSite(host, blogHost)) continue;
    if ((hit.points ?? 0) < 10 && (hit.num_comments ?? 0) < 5) continue;
    if (
      typeof hit.created_at !== "string" ||
      typeof hit.title !== "string" ||
      typeof hit.objectID !== "string"
    )
      throw new Error(`hn.algolia.com: unexpected hit shape: ${JSON.stringify(hit).slice(0, 200)}`);
    hits.push({
      created_at: hit.created_at,
      title: hit.title.trim(),
      url: hit.url,
      points: hit.points ?? 0,
      comments: hit.num_comments ?? 0,
      id: hit.objectID,
    });
  }
  return hits;
};

// Union by story id: hand-curated stories survive, points/comments refresh.
export const mergeHn = (oldHn: Hn[] | undefined, newHn: Hn[]): Hn[] => {
  const byId = new Map((oldHn ?? []).map((h) => [h.id, h]));
  for (const h of newHn) byId.set(h.id, h);
  return [...byId.values()];
};

export const fillMissing = (
  blog: Blog,
  fill: { [K in (typeof FILLABLE)[number]]?: string },
): number => {
  let n = 0;
  for (const k of FILLABLE)
    if (fill[k] && !blog[k]) {
      blog[k] = fill[k];
      n++;
    }
  return n;
};

type Counters = { filled: number; pageOk: number; pageFail: number; hnOk: number; hnFail: number; feedOk?: number; feedFail?: number };

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Only the fetches are guarded: a broken extractor must crash the run, not
// masquerade as 160 dead websites.
export const enrich = async (blog: Blog, c: Counters): Promise<void> => {
  let html: string | undefined;
  try {
    html = await fetchHtml(blog.url);
    c.pageOk++;
  } catch (err) {
    c.pageFail++;
    console.error(`${blog.url}: ${msg(err)}`);
  }
  const host = stripWww(new URL(blog.url).hostname);
  c.filled += fillMissing(blog, { github: githubFromUrl(blog.url) });
  if (html !== undefined) {
    const links = extractLinks(html, blog.url);
    const own = links.filter((l) => stripWww(l.href.hostname) === host);
    c.filled += fillMissing(blog, {
      title: extractTitle(html),
      desc: extractDesc(html),
      keywords: clean(extractMeta(html, "keywords")),
      about: extractPage(own, "about"),
      now: extractPage(own, "now"),
      feed: extractFeed(links, own),
      ...extractSocials(links, host, html),
    });
  }
  // People often keep social links on /about instead of the homepage.
  if (!(blog.github || blog.bluesky || blog.x || blog.mastodon) && blog.about) {
    try {
      const aboutHtml = await fetchHtml(blog.about);
      c.filled += fillMissing(blog, {
        ...extractSocials(extractLinks(aboutHtml, blog.about), host, aboutHtml),
      });
    } catch (err) {
      console.error(`${blog.about}: ${msg(err)}`);
    }
  }
  // Unlike scraped fields, activity is live data: it overwrites every run,
  // the same way HN points do.
  if (blog.feed) {
    try {
      const stats = await fetchFeed(blog.feed);
      if (stats) Object.assign(blog, stats);
      c.feedOk = (c.feedOk ?? 0) + 1;
    } catch (err) {
      c.feedFail = (c.feedFail ?? 0) + 1;
      console.error(`${blog.feed} feed: ${msg(err)}`);
    }
  }
  try {
    const merged = mergeHn(blog.hn, await fetchHn(blog.url));
    if (merged.length || "hn" in blog) blog.hn = merged;
    c.hnOk++;
  } catch (err) {
    c.hnFail++;
    console.error(`${blog.url} hn: ${msg(err)}`);
  }
};

const pool = async <T>(items: T[], n: number, fn: (item: T) => Promise<void>) => {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
};

if (import.meta.main) {
  const c: Counters = { filled: 0, pageOk: 0, pageFail: 0, hnOk: 0, hnFail: 0 };
  const summary = (prefix: string) =>
    console.error(
      `${prefix}${c.filled} fields filled, ` +
        `${c.pageOk} pages ok, ${c.pageFail} pages failed, ` +
        `${c.feedOk ?? 0} feeds ok, ${c.feedFail ?? 0} feeds failed, ` +
        `${c.hnOk} hn ok, ${c.hnFail} hn failed`,
    );
  const urls = Deno.args.filter((a) => !a.startsWith("--"));
  if (urls.length) {
    const entries: Blog[] = [];
    for (const url of urls) {
      const blog: Blog = { url };
      await enrich(blog, c);
      entries.push(blog);
    }
    console.log(JSON.stringify(entries.map(normalize), null, 2));
    summary(`${urls.length} urls: `);
    if (c.pageOk + c.hnOk === 0) Deno.exit(1);
  } else {
    const raw = await Deno.readTextFile("blogs.json");
    const blogs: Blog[] = JSON.parse(raw);
    if (!Array.isArray(blogs)) throw new Error("blogs.json: expected a top-level array");
    blogs.forEach((b, i) => {
      if (typeof b?.url !== "string")
        throw new Error(`blogs.json[${i}]: missing url: ${JSON.stringify(b)?.slice(0, 100)}`);
      try {
        new URL(b.url);
      } catch {
        throw new Error(`blogs.json[${i}]: unparseable url: ${JSON.stringify(b.url)}`);
      }
    });
    const today = Math.floor(Date.now() / 86_400_000) % CYCLE;
    const targets = Deno.args.includes("--fmt")
      ? []
      : Deno.args.includes("--all")
      ? blogs
      : blogs.filter((b) => shardOf(b.url) === today);
    await pool(targets, CONCURRENCY, (b) => enrich(b, c));
    if (targets.length && (c.pageOk === 0 || c.hnOk === 0))
      throw new Error(
        `systemic failure (${c.pageOk}/${targets.length} pages, ${c.hnOk}/${targets.length} hn); ` +
          `refusing to write blogs.json`,
      );
    const out = JSON.stringify(blogs.map(normalize), null, 2) + "\n";
    if (out !== raw) await Deno.writeTextFile("blogs.json", out);
    summary(`${targets.length} blogs (shard ${today}/${CYCLE}): `);
  }
}
