# [blogs.hn](https://blogs.hn)

[blogs.hn](https://blogs.hn) is for _personal_ blogs! Non-technical blogs are
okay too, but remember that the community is mostly folks from
[HackerNews](https://news.ycombinator.com).

## Adding Blogs

This repo comes with a helper script `refresh.ts` to automatically grab blog
info from a URL. But feel free to manually add/edit information to `blogs.json`!

1. Run the script ([deno](https://deno.com)):

```bash
deno run --allow-net refresh.ts "https://taylor.town" "https://gwern.net"
```

2. Clean the output:

```json
[
  {
    "url": "https://taylor.town",
    "title": "Taylor Troesh",
    "desc": "🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸",
    "about": "https://taylor.town/about",
    "now": "https://taylor.town/now",
    "feed": "https://taylor.town/feed.xml",
    "active_at": "2026-08-01T10:00:00Z",
    "posts": 42,
    "cadence": 9.5,
    "hn": [
      {
        "created_at": "2023-04-04T11:42:33.000Z",
        "title": "How to be a -10x Engineer",
        "url": "https://taylor.town/-10x",
        "points": 875,
        "comments": 494,
        "id": "35438068"
      }
    ]
  },
  {
    "url": "https://gwern.net",
    "title": "Essays · Gwern.net",
    "desc": "Personal website of Gwern Branwen (writer, self-experimenter, and programmer): topics: psychology, statistics, technology, deep learning, anime. This index page is a categorized list of Gwern.net pages.",
    "keywords": "meta",
    "about": "https://gwern.net/about",
    "feed": "https://gwern.substack.com/feed",
    "hn": [
      {
        "created_at": "2019-01-21T12:08:15.000Z",
        "title": "On whether changes in bedroom CO2 levels affect sleep quality",
        "url": "https://www.gwern.net/zeo/CO2",
        "points": 576,
        "comments": 306,
        "id": "18959796"
      }
    ]
  }
]
```

3. Add to
   [blogs.json](https://github.com/surprisetalk/blogs.hn/blob/main/blogs.json)
   in a pull request. To prevent merge conflicts, please don't append to the top
   or bottom!

Run `refresh.ts` without URLs to refresh every blog in `blogs.json` in place:

```bash
deno run --env-file=.env --allow-env=SHELOB_ACCOUNT_ID,SHELOB_ACCESS_KEY_ID,SHELOB_SECRET_ACCESS_KEY,SHELOB_BUCKET --allow-net --allow-read=blogs.json,.env --allow-write=blogs.json refresh.ts
```

The full refresh reads each blog's `active_at`, `posts`, and `cadence` from
shelob's `feed_item` table (a read-only R2 bucket) and fetches no known feed.
`posts` counts every dated item shelob has seen; an undated item is ignored.
`.env` (git-ignored) needs `SHELOB_ACCOUNT_ID`, `SHELOB_ACCESS_KEY_ID`,
`SHELOB_SECRET_ACCESS_KEY`, and `SHELOB_BUCKET`. A blog whose feed has no rows
there keeps its stats, but the run fails when no blog feed has rows, when the
table is over 48 hours old, or when the rows read differ from the manifest's
count. A feed found by the scrape in a full run gets its stats once shelob has
fetched it. Adding blogs by URL needs no keys.

The full refresh also sets each blog's `category`, one of `CATEGORIES` in
`refresh.ts`. It embeds the blog's title, desc, keywords, and top HackerNews
titles with nomic-embed-text on pc's `llama-cpp-embed` (`127.0.0.1:8081`), and
picks the nearest category description. A blog with only a title gets none. The
run fails when the embedder does not answer. The category overwrites every run,
as activity stats do.

`city`, such as `San Jose, US` or `Portland, Maine, US`, is curated. It was
filled once from GitHub profile locations and nownownow.com, then checked by
hand, and no refresh changes it. Add or fix it in a pull request as `City, CC`,
with the ISO country code. A town takes its nearby big city: Brooklyn is
`New York City, US`.

It fills in missing fields (title, desc, feed, about, now, and
github/bluesky/x/mastodon profiles found on the blog's homepage or /about page)
and updates HackerNews stories. It never overwrites existing values, so
hand-curated edits are safe.

Every write also normalizes the whole file: fields are sorted, text is trimmed,
and anything that cannot be attributed to the blog is dropped (off-site /about
and /now links, feeds belonging to somebody else, HackerNews stories pointing at
another domain). CI rejects a pull request whose `blogs.json` is not normalized.
Normalize it by hand with:

```bash
deno run --allow-read=blogs.json --allow-write=blogs.json refresh.ts --fmt
```

Run `git config core.hooksPath .githooks` once per clone, and every commit runs
the same checks as CI.

## Status

`deno task status` grades production blogs.hn and exits 1 when any condition
scores below 1.0. A monitor runs it every hour. The `blogs-deploy` timer on pc
(`flake.nix` in surprisetalk/pc) POSTs the Cloudflare Pages deploy hook every 2
hours. The hook URL is a secret in `.env.deploy`. `deno task check` runs the
formatter, linter, typechecker, and tests.

## Activity

`active_at`, `posts`, and `cadence` are read from the blog's feed: the date of
the newest post, how many dated entries the feed carries, and the median days
between posts. They refresh on every run rather than being filled once, and they
are dropped if the feed goes away. Blogs that advertise no feed get the
conventional paths (`/feed.xml`, `/index.xml`, `/feeds/posts/default`, …) probed
before we give up.

## What the site shows

`blogs.json` is the whole directory, and the
[OPML export](https://blogs.hn/blogs.hn.opml) carries every feed in it. The
front page is smaller on purpose: a blog is eligible only if it has a feed, has
posted within two years, and says something about itself, and the page then
draws a weighted random sample of 1000 from that pool — better blogs are
likelier to appear, but the page rebuilds every 2 hours, so the rest get their
turn. Being left off the page is not a judgement on a blog; it usually means we
could not find a feed.

Each category gets a page at `/c/<category>` with the same eligibility and
sample. Every page starts with a line of links to every category. Each city gets
a page at `/city/<city>`, and `/cities` lists them all, busiest first.
