// deno task status: grades production blogs.hn for snitch. Exits 1 when a condition scores below 1.0.

const SITE = "https://blogs.hn";
const BLOGS_JSON =
  "https://raw.githubusercontent.com/surprisetalk/blogs.hn/main/blogs.json";
const PULLS =
  "https://api.github.com/repos/surprisetalk/blogs.hn/pulls?state=open&sort=created&direction=asc&per_page=1";
const TIMEOUT_MS = 15_000;
const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;
// PAGE_SIZE in build.js.
export const PAGE_SIZE = 1000;
// pc's blogs-deploy timer fires the Cloudflare deploy hook every 2 hours. Three hours allows one slow Cloudflare build.
// This also catches a build.js crash and an exhausted Cloudflare build quota.
const BUILT_LIMIT_S = 3 * HOUR_S;
// REVIEW: Date the last refresh by the 100th-newest post in blogs.json. A refresh puts hundreds of blogs within a week, and contributors add a few per week, so their new entries cannot pass it alone. Alternative: refresh.ts writes a refreshed_at stamp. It is exact but adds a field that every PR can conflict on.
const REFRESH_RANK = 100;
// REVIEW: pc's blogs-refresh timer runs weekly, and the 100th-newest post trails a refresh by about half a day. So the limit is 8 days, not 7, and a 7-day limit fails for hours before each run. Alternative: keep 7 days and run the timer twice a week. It doubles the homepage and HN traffic.
const REFRESH_LIMIT_S = 8 * DAY_S;
// Clock skew between this host and the source.
export const SKEW_S = 300;
// refresh.ts statsOf admits feed dates up to a day ahead, for feeds with a wrong time zone.
export const FEED_SKEW_S = DAY_S;

// A condition scores 1.0 at the minimum passing grade. A limit over an age scores 1.0 at the limit.
const within = (limitS: number, ageS: number) => limitS / Math.max(ageS, 1);

export const ageS = (iso: string, source: string, skewS: number) => {
  const t = /^\d{4}-\d{2}-\d{2}T/.test(iso) ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) {
    throw new Error(
      `${source}: expected an ISO date, received ${JSON.stringify(iso)}.`,
    );
  }
  const age = (Date.now() - t) / 1000;
  if (age < -skewS) {
    throw new Error(
      `${source}: expected a date in the past, received ${iso}, ${
        Math.round(-age)
      } s ahead. Fix: check this host's clock, then the source.`,
    );
  }
  return age;
};

// The build stamp and the blog count, both from build.js output.
export const page = (html: string) => ({
  blogs: html.split('<div class="blog">').length - 1,
  built: html.match(/<meta name="built" content="([^"]+)"/)?.[1],
});

const get = async (url: string, method = "GET") => {
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { method, signal: AbortSignal.timeout(TIMEOUT_MS) });
    body = await res.text();
  } catch (e) {
    throw new Error(
      `${method} ${url}: expected a complete response within ${TIMEOUT_MS} ms, received ${e}. Fix: check this host's network, then the URL.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${url}: expected HTTP 200, received ${res.status}. Fix: ${
        url.startsWith("https://api.github.com/") && res.status === 403
          ? "wait an hour; 403 means the unauthenticated rate limit."
          : "open the URL."
      }`,
    );
  }
  return body;
};

const getJson = async (url: string): Promise<unknown> => {
  const body = await get(url);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(
      `${url}: expected JSON, received ${body.length} bytes that fail to parse: ${e}.`,
    );
  }
};

const site = async () => {
  // Deno's first fetch spends about 1 s on its own DNS and TLS setup. Warm the connection, then time the page.
  await get(SITE, "HEAD");
  const start = performance.now();
  const html = await get(SITE);
  return { ms: performance.now() - start, ...page(html) };
};

const builtAgeS = (built: string | undefined) => {
  if (built === undefined) {
    throw new Error(
      `${SITE}: expected <meta name="built">, received none. Fix: check that Cloudflare Pages builds main with build.js.`,
    );
  }
  return ageS(built, `${SITE} <meta name="built">`, SKEW_S);
};

const refreshAgeS = async () => {
  const blogs = await getJson(BLOGS_JSON);
  if (!Array.isArray(blogs)) {
    throw new Error(
      `${BLOGS_JSON}: expected an array, received ${typeof blogs}.`,
    );
  }
  const ages = blogs.flatMap((b: unknown, i) => {
    if (typeof b !== "object" || b === null || Array.isArray(b)) {
      throw new Error(
        `${BLOGS_JSON}[${i}]: expected an object, received ${
          JSON.stringify(b)
        }.`,
      );
    }
    const a = (b as { active_at?: unknown }).active_at;
    if (a === undefined) return [];
    if (typeof a !== "string") {
      throw new Error(
        `${BLOGS_JSON}[${i}].active_at: expected a string, received ${
          JSON.stringify(a)
        }.`,
      );
    }
    return [ageS(a, `${BLOGS_JSON}[${i}].active_at`, FEED_SKEW_S)];
  }).sort((x, y) => x - y);
  if (ages.length < REFRESH_RANK) {
    throw new Error(
      `${BLOGS_JSON}: expected at least ${REFRESH_RANK} blogs with active_at, received ${ages.length}.`,
    );
  }
  return ages[REFRESH_RANK - 1];
};

const oldestPrAgeS = async () => {
  const pulls = await getJson(PULLS);
  if (!Array.isArray(pulls)) {
    throw new Error(`${PULLS}: expected an array, received ${typeof pulls}.`);
  }
  if (pulls.length === 0) return 0;
  const first: unknown = pulls[0];
  const created = typeof first === "object" && first !== null
    ? (first as { created_at?: unknown }).created_at
    : undefined;
  if (typeof created !== "string") {
    throw new Error(
      `${PULLS}: expected [0].created_at as a string, received ${
        JSON.stringify(first)
      }.`,
    );
  }
  return ageS(created, `${PULLS} [0].created_at`, SKEW_S);
};

// A failed check scores 0 and says why on stderr, so the other conditions still report.
const orZero = async <T>(f: () => T | Promise<T>) => {
  try {
    return await f();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return null;
  }
};

if (import.meta.main) {
  // The homepage goes first, so the 8 MB blogs.json download does not slow its timing.
  const s = await orZero(site);
  const [refresh, pr] = await Promise.all([
    orZero(refreshAgeS),
    orZero(oldestPrAgeS),
  ]);
  const built = s === null ? null : await orZero(() => builtAgeS(s.built));
  const conditions: Record<string, { "0": number }> = {
    "blogs.hn loads in under 1 s.": { "0": s ? 1000 / Math.max(s.ms, 1) : 0 },
    [`The front page lists ${PAGE_SIZE} blogs.`]: {
      // More than PAGE_SIZE means build.js repeats blogs.
      "0": s && s.blogs <= PAGE_SIZE ? s.blogs / PAGE_SIZE : 0,
    },
    "The site rebuilt within 3 hours.": {
      "0": built === null ? 0 : within(BUILT_LIMIT_S, built),
    },
    "A refresh ran in the last 8 days.": {
      "0": refresh === null ? 0 : within(REFRESH_LIMIT_S, refresh),
    },
    "No pull request waits over 14 days.": {
      "0": pr === null ? 0 : within(14 * DAY_S, pr),
    },
  };
  console.log(JSON.stringify(conditions, null, 1));
  if (Object.values(conditions).some((c) => c["0"] < 1)) Deno.exit(1);
}
