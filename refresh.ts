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

export type Blog = { url: string; hn?: Hn[] } & {
  [K in (typeof FILLABLE)[number]]?: string;
};

export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};

export const shardOf = (url: string): number => fnv1a(url) % CYCLE;

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export const decodeEntities = (s: string): string =>
  s.replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi,
    (_, hex, dec, name) =>
      name ? ENT[name.toLowerCase()] : cp(parseInt(hex ?? dec, hex ? 16 : 10)),
  );

const cp = (n: number): string => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

const JUNK = /^(just a moment|attention required|access denied|checking your browser|please wait|verifying you are human|403 forbidden|404)/i;

export const clean = (s?: string): string | undefined => {
  if (!s) return undefined;
  const t = decodeEntities(s)
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    // deno-lint-ignore no-control-regex
    .replace(/[<>\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300)
    .trim();
  return !t || JUNK.test(t) ? undefined : t;
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

const GH_DENY = new Set("about apps blog collections contact customer-stories enterprise events explore features join login marketplace notifications orgs pricing readme security settings site sponsors team topics trending".split(" "));
const X_DENY = new Set("explore hashtag home i intent login messages notifications privacy search settings share signup tos".split(" "));
const MASTO_HOSTS = new Set("mastodon.social mstdn.social fosstodon.org hachyderm.io infosec.exchange mas.to mastodon.online chaos.social indieweb.social techhub.social".split(" "));
const RELME_DENY = new Set("medium.com youtube.com threads.net tiktok.com instagram.com facebook.com linkedin.com twitch.tv twitter.com x.com bsky.app github.com".split(" "));

export type Socials = { github?: string; bluesky?: string; x?: string; mastodon?: string };

export const extractSocials = (links: Link[], selfHost = ""): Socials => {
  const found: Record<keyof Socials, Map<string, string>> = {
    github: new Map(),
    bluesky: new Map(),
    x: new Map(),
    mastodon: new Map(),
  };
  for (const { href, rel } of links) {
    const host = stripWww(href.hostname);
    const path = href.pathname.replace(/\/$/, "");
    const seg = path.split("/").filter(Boolean);
    if (
      host === "github.com" &&
      seg.length === 1 &&
      /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(seg[0]) &&
      !GH_DENY.has(seg[0].toLowerCase())
    )
      found.github.set(seg[0].toLowerCase(), `https://github.com/${seg[0]}`);
    if (
      (host === "x.com" || host === "twitter.com") &&
      seg.length === 1 &&
      /^\w{1,15}$/.test(seg[0]) &&
      !X_DENY.has(seg[0].toLowerCase())
    )
      found.x.set(seg[0].toLowerCase(), `https://x.com/${seg[0]}`);
    if (host === "bsky.app" && seg.length === 2 && seg[0] === "profile")
      found.bluesky.set(seg[1].toLowerCase(), `https://bsky.app/profile/${seg[1]}`);
    if (
      /^\/(@[^/]+|users\/[^/]+)$/.test(path) &&
      host !== selfHost &&
      ((rel.split(/\s+/).includes("me") && !RELME_DENY.has(host)) ||
        MASTO_HOSTS.has(host))
    )
      found.mastodon.set(host + path.toLowerCase(), href.origin + path);
  }
  const one = (m: Map<string, string>) =>
    m.size === 1 ? m.values().next().value : undefined;
  return {
    github: one(found.github),
    bluesky: one(found.bluesky),
    x: one(found.x),
    mastodon: one(found.mastodon),
  };
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
      title: hit.title,
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

type Counters = { filled: number; pageOk: number; pageFail: number; hnOk: number; hnFail: number };

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
  if (html !== undefined) {
    const links = extractLinks(html, blog.url);
    const host = stripWww(new URL(blog.url).hostname);
    const own = links.filter((l) => stripWww(l.href.hostname) === host);
    c.filled += fillMissing(blog, {
      title: extractTitle(html),
      desc: extractDesc(html),
      keywords: clean(extractMeta(html, "keywords")),
      about: extractPage(own, "about"),
      now: extractPage(own, "now"),
      feed: extractFeed(links, own),
      ...extractSocials(links, host),
    });
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
    console.log(JSON.stringify(entries, null, 2));
    summary(`${urls.length} urls: `);
    if (c.pageOk + c.hnOk === 0) Deno.exit(1);
  } else {
    const raw = await Deno.readTextFile("blogs.json");
    const blogs: Blog[] = JSON.parse(raw);
    if (!Array.isArray(blogs)) throw new Error("blogs.json: expected a top-level array");
    blogs.forEach((b, i) => {
      if (typeof b?.url !== "string")
        throw new Error(`blogs.json[${i}]: missing url: ${JSON.stringify(b)?.slice(0, 100)}`);
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
    const out = JSON.stringify(blogs, null, 2) + "\n";
    if (out !== raw) await Deno.writeTextFile("blogs.json", out);
    summary(`${targets.length} blogs (shard ${today}/${CYCLE}): `);
  }
}
