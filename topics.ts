// deno task topics: tag every blog in blogs.json with 1 to 3 topics from topics.json, from its post titles.
// Without topics.json, it first fits the topics and names them with Gemma. Review the names, then commit topics.json.
// Delete topics.json to fit again. Only a deliberate run changes tags; refresh.ts keeps them as they are.

import { findAll, removeElement, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import {
  type Blog,
  feedItemPart,
  normalize,
  publishedAt,
  readFeedItem,
  type Store,
  storeFromEnv,
  TAG,
} from "./refresh.ts";

// pc's llama-cpp-embed serves nomic-embed-text-v1.5 (768 dimensions) here.
const EMBED = "http://127.0.0.1:8081/v1/embeddings";
// pc's llama-cpp serves Gemma here.
const CHAT = "http://127.0.0.1:8080/v1/chat/completions";
const DIM = 768;
// llama-cpp-embed runs 4 slots; one request of 32 texts keeps them busy.
const EMBED_BATCH = 32;
const TIMEOUT = 60_000;
// nomic-embed-text trains to 2048 tokens. 2000 characters stay under that.
const EMBED_CHARS = 2000;
// NOTE: A blog's newest 50 posts speak for it. Alternative: every post. A blog with 1,700 posts then outweighs 100 small blogs in the fit.
const POSTS_PER_BLOG = 50;
// A topic tags a blog when it holds this share of the blog's points. The strongest topic always tags it.
const TAG_SHARE = 0.2;
const MAX_TAGS = 3;
// NOTE: 40 topics. Alternative: HDBSCAN finds its own count, but it needs a Python stack, and it calls most short titles noise.
const TOPICS = 40;
const KMEANS_ITERS = 100;
// k-means stops when fewer than this share of points change topic in one pass.
const KMEANS_SETTLED = 0.001;
// Titles nearest a centroid that Gemma reads to name its topic.
const NAMING_TITLES = 20;
// Titles topics.json keeps per topic, for review.
const EXAMPLES = 8;
const VECTORS = "vectors.tsv";
const TOPICS_FILE = "topics.json";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// llama-server answers HTTP 400 to a lone surrogate, so repair scraped text and cut by code point.
const clip = (s: string) =>
  [...s.replace(/\s+/g, " ").trim().toWellFormed()].slice(0, EMBED_CHARS)
    .join("");

// One extra point per blog, for blogs with few posts. The title alone ("Home") says nothing, so it needs a desc, keywords, or HN titles.
export const blogText = (b: Blog): string | undefined => {
  const hn = (b.hn ?? []).slice().sort((x, y) => y.points - x.points)
    .slice(0, 5).map((h) => h.title);
  const about = [b.desc, b.keywords, ...hn].filter((x) => x);
  return about.length ? clip([b.title, ...about].join("\n")) : undefined;
};

// nomic-embed-text needs a task prefix on every input. "clustering: " is its prefix for grouping texts.
export const embed = async (
  texts: string[],
  endpoint = EMBED,
): Promise<Float32Array[]> => {
  let body: unknown;
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: texts.map((t) => "clustering: " + t) }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    body = await res.json();
  } catch (err) {
    throw new Error(
      `embed: expected ${texts.length} embeddings from ${endpoint} within ${TIMEOUT} ms, received ${
        msg(err)
      }. Fix: systemctl status llama-cpp-embed on pc.`,
    );
  }
  const data = (body as { data?: unknown })?.data;
  const vs = (Array.isArray(data) ? data : []).map((d, i) => {
    const { index, embedding: v } = (d ?? {}) as {
      index?: unknown;
      embedding?: unknown;
    };
    if (index !== i || !Array.isArray(v) || v.length !== DIM) return;
    if (!v.every((x) => typeof x === "number")) return;
    return unit(Float32Array.from(v));
  });
  if (vs.length !== texts.length || vs.some((v) => v === undefined)) {
    throw new Error(
      `embed: expected {data: [{index, embedding}]} with ${texts.length} ${DIM}-number vectors in input order, each of finite nonzero length, from ${endpoint}, received ${
        JSON.stringify(body).slice(0, 200)
      }. Fix: check that llama-cpp-embed on pc still serves nomic-embed-text-v1.5.`,
    );
  }
  return vs as Float32Array[];
};

// Undefined for a vector of zero or infinite length.
const unit = (v: Float32Array) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (!(n > 0 && isFinite(n))) return undefined;
  return v.map((x) => x / n);
};

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

const nearest = (v: Float32Array, centroids: Float32Array[]) => {
  let best = 0, bestSim = -Infinity;
  for (let k = 0; k < centroids.length; k++) {
    const s = dot(v, centroids[k]);
    if (s > bestSim) [best, bestSim] = [k, s];
  }
  return best;
};

// part and row locate the post's raw item in feed_item, for its body.
type Post = {
  feed: string;
  title: string;
  t: number;
  part: string;
  row: number;
};

// A post's vector is keyed by its feed and title, so a fixed date does not embed it again.
const postKey = (p: Post) => `${p.feed}\t${p.title}`;

// The newest POSTS_PER_BLOG titled, dated posts of each feed, one per title.
export const loadPosts = async (
  store: Store,
  feeds: Set<string>,
): Promise<Map<string, Post[]>> => {
  const all = new Map<string, Map<string, Post>>();
  await readFeedItem(
    store,
    ["feed", "title", "published_at"],
    (rows, url, part) => {
      for (const [row, r] of rows.entries()) {
        if (typeof r.feed !== "string" || !feeds.has(r.feed)) continue;
        if (r.title !== null && typeof r.title !== "string") {
          throw new Error(
            `${url}: expected a feed_item title as a string or null, received ${typeof r
              .title}. Fix: check shelob's feed_item schema.`,
          );
        }
        const t = publishedAt(r, url);
        const title = r.title === null ? "" : clip(r.title);
        if (t === null || !title) continue;
        const byTitle = all.get(r.feed) ?? new Map<string, Post>();
        if ((byTitle.get(title)?.t ?? -Infinity) < t) {
          byTitle.set(title, { feed: r.feed, title, t, part, row });
        }
        all.set(r.feed, byTitle);
      }
    },
  );
  // Without this check, a wrong bucket or a change in feed URL form strips the tags of every blog, and the run still exits 0.
  if (all.size < feeds.size / 2) {
    throw new Error(
      `feed_item: expected posts for at least half of the ${feeds.size} feeds in blogs.json, received posts for ${all.size}. Fix: check SHELOB_BUCKET, and compare blogs.json feed URLs with feed_item.feed.`,
    );
  }
  return new Map(
    [...all].map(([feed, byTitle]) => [
      feed,
      [...byTitle.values()].sort((a, b) => b.t - a.t).slice(0, POSTS_PER_BLOG),
    ]),
  );
};

// vectors.tsv: feed, title, and 768 comma-joined numbers per line. A crash can leave a cut last line; loading drops it.
const VECTOR_CUT = 64 * 1024;

export const loadVectors = async (
  path = VECTORS,
): Promise<Map<string, Float32Array>> => {
  const out = new Map<string, Float32Array>();
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true, write: true });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return out;
    throw err;
  }
  try {
    const { size } = await file.stat();
    if (size) {
      const n = Math.min(size, VECTOR_CUT);
      await file.seek(size - n, Deno.SeekMode.Start);
      const tail = new Uint8Array(n);
      for (let got = 0; got < n;) {
        const r = await file.read(tail.subarray(got));
        if (r === null) break;
        got += r;
      }
      if (tail[n - 1] !== 10) {
        const cut = tail.lastIndexOf(10);
        if (cut < 0 && size > n) {
          throw new Error(
            `${path}: expected a newline in its last ${VECTOR_CUT} bytes, received none. Fix: delete ${path}; the next run embeds every post again.`,
          );
        }
        await file.truncate(size - n + cut + 1);
        console.error(`${path}: dropped a cut last line from a crashed run`);
      }
    }
  } finally {
    file.close();
  }
  let carry = "";
  let line = 0;
  const take = (s: string) => {
    line++;
    const f = s.split("\t");
    const nums = f[2]?.split(",").map(Number) ?? [];
    const v = nums.length === DIM && nums.every(isFinite)
      ? unit(Float32Array.from(nums))
      : undefined;
    if (f.length !== 3 || !f[0] || !f[1] || !v) {
      throw new Error(
        `${path}:${line}: expected feed, title, and ${DIM} comma-joined numbers, received ${
          JSON.stringify(s.slice(0, 120))
        }. Fix: delete ${path}; the next run embeds every post again.`,
      );
    }
    out.set(`${f[0]}\t${f[1]}`, v);
  };
  const stream = (await Deno.open(path)).readable.pipeThrough(
    new TextDecoderStream(),
  );
  for await (const chunk of stream) {
    const parts = (carry + chunk).split("\n");
    carry = parts.pop()!;
    for (const p of parts) take(p);
  }
  if (carry) take(carry);
  return out;
};

// The visible text of an HTML fragment. htmlparser2 decodes entities and tolerates broken markup.
export const htmlText = (html: string) => {
  const doc = parseDocument(html);
  for (
    const el of findAll(
      (e) => e.name === "script" || e.name === "style",
      doc.children,
    )
  ) {
    removeElement(el);
  }
  return textContent(doc);
};

// shelob stores gofeed's item as JSON: content holds the full post when the feed carries it, description the summary.
// hyparquet decodes a JSON-typed column to an object; a plain string column (the test fixture) holds the same JSON as text.
export const postBody = (item: unknown, where: string) => {
  let raw = item;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${where}: expected feed_item raw as a gofeed item object, received ${
        JSON.stringify(item)?.slice(0, 120)
      }. Fix: check shelob's feed_item schema.`,
    );
  }
  const { content, description } = raw as Record<string, unknown>;
  const html = [content, description].find((x) =>
    typeof x === "string" && x.trim()
  ) as string | undefined;
  return html === undefined ? "" : htmlText(html);
};

// Rows decoded per raw read. A part's raw chunk can hold 125,000 blog rows, which overflow 3 GB decoded at once.
const RAW_WINDOW = 2000;

// Each post's title and body, in windows of at most RAW_WINDOW rows, read from the raw column of only the row groups that hold them.
// The parts carry no offset index, so hyparquet fetches a row group's whole raw chunk for any read; the file keeps the last chunk it fetched.
async function* postTexts(store: Store, part: string, posts: Post[]) {
  const remote = await feedItemPart(store, part);
  let kept: { start: number; end: number; bytes: ArrayBuffer } | undefined;
  const file = {
    byteLength: remote.byteLength,
    slice: async (start: number, end = remote.byteLength) => {
      if (!kept || start < kept.start || end > kept.end) {
        kept = { start, end, bytes: await remote.slice(start, end) };
      }
      return kept.bytes.slice(start - kept.start, end - kept.start);
    },
  };
  const metadata = await parquetMetadataAsync(file);
  const sorted = posts.slice().sort((a, b) => a.row - b.row);
  let start = 0;
  for (const group of metadata.row_groups) {
    const end = start + Number(group.num_rows);
    const inside = sorted.filter((p) => p.row >= start && p.row < end);
    for (let i = 0; i < inside.length;) {
      const rowStart = inside[i].row;
      const window = [];
      while (i < inside.length && inside[i].row < rowStart + RAW_WINDOW) {
        window.push(inside[i++]);
      }
      const rowEnd = window.at(-1)!.row + 1;
      const rows = await parquetReadObjects({
        file,
        metadata,
        columns: ["raw"],
        rowStart,
        rowEnd,
        compressors,
      });
      yield window.map((p) => ({
        post: p,
        text: clip(
          `${p.title}\n${
            postBody(rows[p.row - rowStart]?.raw, `${remote.url} row ${p.row}`)
          }`,
        ),
      }));
    }
    start = end;
  }
}

// Embeds the title and body of each post that vectors.tsv lacks, one feed_item part at a time,
// and appends each batch as it lands, so a crash keeps the work done.
export const embedMissing = async (
  store: Store,
  posts: Post[],
  cache: Map<string, Float32Array>,
  path = VECTORS,
  endpoint = EMBED,
): Promise<number> => {
  const missing = [...new Map(posts.map((p) => [postKey(p), p])).values()]
    .filter((p) => !cache.has(postKey(p)));
  let done = 0;
  for (const [part, inPart] of Map.groupBy(missing, (p) => p.part)) {
    for await (const texts of postTexts(store, part, inPart)) {
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const batch = texts.slice(i, i + EMBED_BATCH);
        const vs = await embed(batch.map((t) => t.text), endpoint);
        await Deno.writeTextFile(
          path,
          batch.map(({ post }, j) =>
            `${postKey(post)}\t${
              Array.from(vs[j], (x) => x.toFixed(4)).join(",")
            }\n`
          ).join(""),
          { append: true },
        );
        batch.forEach(({ post }, j) => cache.set(postKey(post), vs[j]));
        done += batch.length;
      }
      console.error(`embedded ${done} of ${missing.length} posts`);
    }
  }
  return done;
};

// A seeded generator, so a refit over the same vectors gives the same topics.
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Spherical k-means with k-means++ seeds: points and centroids are unit vectors, and similarity is the dot product.
export const kmeans = (points: Float32Array[], k: number, seed = 1) => {
  if (points.length < k) {
    throw new Error(
      `kmeans: expected at least ${k} points, received ${points.length}. Fix: check that vectors.tsv holds the posts.`,
    );
  }
  const rand = mulberry32(seed);
  const centroids = [points[Math.floor(rand() * points.length)]];
  const far = new Float64Array(points.length).fill(Infinity);
  while (centroids.length < k) {
    let total = 0;
    for (let i = 0; i < points.length; i++) {
      far[i] = Math.min(far[i], 1 - dot(points[i], centroids.at(-1)!));
      total += far[i];
    }
    let r = rand() * total, i = 0;
    while (i < points.length - 1 && (r -= far[i]) > 0) i++;
    centroids.push(points[i]);
  }
  const assign = new Int32Array(points.length).fill(-1);
  for (let iter = 0;; iter++) {
    if (iter === KMEANS_ITERS) {
      throw new Error(
        `kmeans: expected fewer than ${
          KMEANS_SETTLED * 100
        }% of points to change topic within ${KMEANS_ITERS} passes, received more. Fix: raise KMEANS_ITERS in topics.ts.`,
      );
    }
    let moved = 0;
    for (let i = 0; i < points.length; i++) {
      const c = nearest(points[i], centroids);
      if (c !== assign[i]) [assign[i], moved] = [c, moved + 1];
    }
    const sums = centroids.map(() => new Float32Array(DIM));
    const sizes = new Int32Array(k);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]];
      for (let d = 0; d < DIM; d++) s[d] += points[i][d];
      sizes[assign[i]]++;
    }
    for (let c = 0; c < k; c++) {
      // An empty topic restarts on the point that sits worst in its own topic.
      if (sizes[c] === 0) {
        let worst = 0, worstSim = Infinity;
        for (let i = 0; i < points.length; i++) {
          const s = dot(points[i], centroids[assign[i]]);
          if (s < worstSim) [worst, worstSim] = [i, s];
        }
        centroids[c] = points[worst];
        moved++;
      } else centroids[c] = unit(sums[c]) ?? centroids[c];
    }
    console.error(`kmeans pass ${iter + 1}: ${moved} points moved`);
    if (moved < KMEANS_SETTLED * points.length) return { centroids, assign };
  }
};

type Topic = {
  name: string;
  posts: number;
  examples: string[];
  centroid: number[];
};

// Topic names become tags and file names under dist/c/, so each is a unique slug.
export const loadTopics = (json: string, source = TOPICS_FILE) => {
  const topics: unknown = JSON.parse(json);
  const fail = (what: string) => {
    throw new Error(
      `${source}: expected an array of {name, posts, examples, centroid} with unique lowercase-hyphen names and ${DIM}-number centroids, received ${what}. Fix: edit ${source}, or delete it to fit again.`,
    );
  };
  if (!Array.isArray(topics) || !topics.length) return fail("no array");
  const names = new Set<string>();
  return topics.map((t, i) => {
    const { name, centroid } = (t ?? {}) as Partial<Topic>;
    if (typeof name !== "string" || !TAG.test(name)) {
      return fail(`[${i}].name ${JSON.stringify(name)}`);
    }
    if (names.has(name)) return fail(`"${name}" twice`);
    names.add(name);
    const v = Array.isArray(centroid) && centroid.length === DIM &&
        centroid.every((x) => typeof x === "number")
      ? unit(Float32Array.from(centroid))
      : undefined;
    if (!v) return fail(`[${i}].centroid of the wrong shape`);
    return { name, centroid: v };
  });
};

// Each point votes for its nearest topic. Returns the count of blogs tagged.
export const tagBlogs = (
  blogs: Blog[],
  points: Map<Blog, Float32Array[]>,
  topics: { name: string; centroid: Float32Array }[],
) => {
  const centroids = topics.map((t) => t.centroid);
  let n = 0;
  for (const blog of blogs) {
    const vs = points.get(blog) ?? [];
    if (!vs.length) {
      delete blog.tags;
      continue;
    }
    const votes = new Map<number, number>();
    for (const v of vs) {
      const c = nearest(v, centroids);
      votes.set(c, (votes.get(c) ?? 0) + 1);
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    blog.tags = ranked
      .filter(([, count], i) => i === 0 || count >= TAG_SHARE * vs.length)
      .slice(0, MAX_TAGS)
      .map(([c]) => topics[c].name);
    n++;
  }
  return n;
};

if (import.meta.main) {
  const blogs: Blog[] = JSON.parse(await Deno.readTextFile("blogs.json"));
  const feeds = new Set(blogs.flatMap((b) => (b.feed ? [b.feed] : [])));
  const store = storeFromEnv();
  const posts = await loadPosts(store, feeds);
  const cache = await loadVectors();
  const all = [...posts.values()].flat();
  console.error(
    `${posts.size} feeds, ${all.length} posts, ${cache.size} cached vectors`,
  );
  console.error(`${await embedMissing(store, all, cache)} posts embedded`);

  let topicsJson: string;
  try {
    topicsJson = await Deno.readTextFile(TOPICS_FILE);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    const keys = [...new Set(all.map(postKey))];
    const vs = keys.map((k) => cache.get(k)!);
    const { centroids, assign } = kmeans(vs, TOPICS);
    const topics: Topic[] = [];
    for (const [c, centroid] of centroids.entries()) {
      const members = keys.flatMap((k, i) =>
        assign[i] === c
          ? [{ title: k.split("\t")[1], sim: dot(vs[i], centroid) }]
          : []
      ).sort((a, b) => b.sim - a.sim);
      const near = [...new Set(members.map((m) => m.title))];
      // Gemma names a topic from the titles nearest its centroid.
      let text: unknown;
      let name: string;
      try {
        const res = await fetch(CHAT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{
              role: "user",
              content: `Blog post titles from one topic:\n${
                near.slice(0, NAMING_TITLES).map((t) => `- ${t}`).join("\n")
              }\nName the topic as one lowercase tag of 1 to 3 words joined by hyphens, like web-development or cooking.`,
            }],
            temperature: 0,
            max_tokens: 40,
            // Gemma reasons by default and spends hundreds of tokens before a short answer.
            chat_template_kwargs: { enable_thinking: false },
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "out",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    tag: {
                      type: "string",
                      pattern: "^[a-z0-9]+(-[a-z0-9]+){0,2}$",
                    },
                  },
                  required: ["tag"],
                  additionalProperties: false,
                },
              },
            },
          }),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = (await res.json()).choices?.[0]?.message?.content;
        const tag = JSON.parse(String(text)).tag;
        if (typeof tag !== "string" || !TAG.test(tag)) {
          throw new Error("no tag");
        }
        name = tag;
      } catch (err) {
        throw new Error(
          `topic ${
            c + 1
          } name: expected {"tag": "a-lowercase-tag"} from ${CHAT} within ${TIMEOUT} ms, received ${
            msg(err)
          }: ${
            String(JSON.stringify(text)).slice(0, 200)
          }. Fix: systemctl status llama-cpp on pc.`,
        );
      }
      topics.push({
        name,
        posts: members.length,
        examples: near.slice(0, EXAMPLES),
        centroid: Array.from(centroid, (x) => Number(x.toFixed(4))),
      });
      console.error(
        `topic ${c + 1}: ${topics.at(-1)!.name} (${members.length})`,
      );
    }
    topics.sort((a, b) => b.posts - a.posts);
    topicsJson = JSON.stringify(topics, null, 1) + "\n";
    await Deno.writeTextFile(TOPICS_FILE, topicsJson);
  }
  const topics = loadTopics(topicsJson);

  const descs = new Map<Blog, Float32Array>();
  const withText = blogs.flatMap((blog) => {
    const text = blogText(blog);
    return text === undefined ? [] : [{ blog, text }];
  });
  for (let i = 0; i < withText.length; i += EMBED_BATCH) {
    const batch = withText.slice(i, i + EMBED_BATCH);
    const vs = await embed(batch.map((b) => b.text));
    batch.forEach((b, j) => descs.set(b.blog, vs[j]));
  }
  const points = new Map(blogs.map((b) => [
    b,
    [
      ...(posts.get(b.feed ?? "") ?? []).map((p) => cache.get(postKey(p))!),
      ...(descs.has(b) ? [descs.get(b)!] : []),
    ],
  ]));
  console.error(`${tagBlogs(blogs, points, topics)} blogs tagged`);
  await Deno.writeTextFile(
    "blogs.json",
    JSON.stringify(blogs.map(normalize), null, 2) + "\n",
  );
}
