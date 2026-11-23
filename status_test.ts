import { ageS, FEED_SKEW_S, page, SKEW_S } from "./status.ts";
import { statsOf } from "./refresh.ts";

// Runs the real status command against production. Offline, every condition scores 0, and the test still holds.
Deno.test("status grades five conditions and exits 1 exactly when one is below 1.0", async () => {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-net=blogs.hn,api.github.com,raw.githubusercontent.com",
      "status.ts",
    ],
    cwd: import.meta.dirname,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const err = new TextDecoder().decode(stderr);
  const json: Record<string, Record<string, number>> = JSON.parse(
    new TextDecoder().decode(stdout),
  );
  const keys = Object.keys(json).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify([
      "A refresh ran in the last 8 days.",
      "No pull request waits over 14 days.",
      "The front page lists 1000 blogs.",
      "The site rebuilt within 3 hours.",
      "blogs.hn loads in under 1 s.",
    ])
  ) throw new Error(`unexpected conditions: ${keys}\n${err}`);
  const scores = Object.values(json).map((c) => c["0"]);
  if (!scores.every((x) => Number.isFinite(x) && x >= 0)) {
    throw new Error(`expected finite scores >= 0, received ${scores}\n${err}`);
  }
  const want = scores.some((x) => x < 1) ? 1 : 0;
  if (code !== want) {
    throw new Error(`expected exit ${want}, received ${code}\n${err}`);
  }
});

Deno.test("build.js output carries what status reads, keeps $ patterns literal, and lists each tag and city", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const f of ["build.js", "template.html", "style.css"]) {
      await Deno.copyFile(`${import.meta.dirname}/${f}`, `${dir}/${f}`);
    }
    // A real HN title: String.replace read "$`" as "the text before the match".
    const title = "Why do regexes use `$` and `^` as $& anchors?";
    await Deno.writeTextFile(
      `${dir}/blogs.json`,
      JSON.stringify([{
        url: "https://example.com",
        title: "Example",
        tags: ["ai"],
        city: "Zürich, CH",
        desc: "A description long enough to qualify for the front page.",
        feed: "https://example.com/feed.xml",
        active_at: new Date().toISOString(),
        hn: [{
          id: "1",
          title,
          url: "https://example.com/a",
          points: 1,
          comments: 1,
          created_at: "2020-01-01T00:00:00.000Z",
        }],
      }, {
        // Its city folds to the same slug as the first blog's.
        url: "https://example.org",
        title: "Example",
        desc: "A description long enough to qualify for the front page.",
        feed: "https://example.org/feed.xml",
        active_at: new Date().toISOString(),
        city: "Zurich, CH",
      }]),
    );
    const { code, stderr } = await new Deno.Command("node", {
      args: ["build.js"],
      cwd: dir,
      stderr: "piped",
    }).output();
    if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
    const html = await Deno.readTextFile(`${dir}/dist/index.html`);
    const p = page(html);
    if (p.blogs !== 2) throw new Error(`expected 2 blogs, received ${p.blogs}`);
    if (p.built === undefined || ageS(p.built, "built", SKEW_S) > 60) {
      throw new Error(`expected a fresh build stamp, received ${p.built}`);
    }
    if (html.split("<!doctype html>").length !== 2) {
      throw new Error(
        "expected one <!doctype html>, received a pasted template",
      );
    }
    if (!html.includes(title.replace("&", "&amp;"))) {
      throw new Error(
        `expected the title verbatim, received a page without it`,
      );
    }
    if (!html.includes('<a href="/c/ai">#ai</a>')) {
      throw new Error("expected the card to link /c/ai");
    }
    if (!html.includes('<nav class="small"><a href="/c/ai">ai</a> 1</nav>')) {
      throw new Error("expected the strip to link /c/ai with its count");
    }
    const ai = await Deno.readTextFile(`${dir}/dist/c/ai.html`);
    if (page(ai).blogs !== 1 || !ai.includes("<strong>ai</strong>")) {
      throw new Error("expected dist/c/ai.html to list the blog and mark ai");
    }
    const zurich = await Deno.readTextFile(`${dir}/dist/city/zurich-ch.html`);
    if (page(zurich).blogs !== 2 || !html.includes('href="/city/zurich-ch"')) {
      throw new Error("expected the card to link dist/city/zurich-ch.html");
    }
    if (!zurich.includes("<strong>Zurich, CH / Zürich, CH</strong>")) {
      throw new Error("expected the city page to name both spellings");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// refresh.ts admits feed dates up to a day ahead, for feeds with a wrong time zone.
Deno.test("status accepts an active_at that refresh.ts writes from a feed dated 2 h ahead", () => {
  const stats = statsOf([Date.now() + 2 * 3_600_000]);
  if (!stats) throw new Error("expected statsOf to keep a date 2 h ahead");
  ageS(stats.active_at, "active_at", FEED_SKEW_S);
});
