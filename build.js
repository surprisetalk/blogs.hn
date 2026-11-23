const fs = require("fs");
const process = require("child_process");

process.execSync("mkdir -p dist");
process.execSync("cp style.css dist/style.css");

const raw = fs.readFileSync("./template.html", "utf-8");
// A formatter once rewrote the slot as {{ body }}, and replace() then built pages with no body.
// status.ts reads the stamp from this exact meta tag.
for (const slot of ["{{body}}", '<meta name="built" content="{{built}}" />']) {
  const n = raw.split(slot).length - 1;
  if (n !== 1) {
    throw new Error(
      `build.js: expected template.html to hold exactly one ${slot} slot. Received ${n}. Fix: restore ${slot} in template.html, and keep the file out of deno fmt.`,
    );
  }
}
// status.ts reads this stamp to tell whether pc's blogs-deploy timer still runs.
const template = raw.replace("{{built}}", new Date().toISOString());

const esc = (unsafe) => {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return c;
    }
  });
};

const allBlogs = require("./blogs.json");
if (!Array.isArray(allBlogs)) {
  throw new Error(
    `build.js: expected blogs.json to hold an array, received ${typeof allBlogs}. Fix: restore blogs.json from main.`,
  );
}
allBlogs.forEach((blog, i) => {
  if (typeof blog !== "object" || blog === null || Array.isArray(blog)) {
    throw new Error(
      `build.js: expected blogs.json[${i}] to be an object, received ${
        JSON.stringify(blog)
      }. Fix: run refresh.ts --fmt and check the entry.`,
    );
  }
});

// The directory holds far more blogs than belong on one page. Show the best
// PAGE_SIZE of them; the full list lives in blogs.json and the OPML export.
const PAGE_SIZE = 1000;
const STORIES_PER_BLOG = 10;
const YEAR = 31557600000;

// Years since the newest post. Null when there is no feed or no dated entries.
const idleYears = (blog) =>
  blog.active_at ? (Date.now() - Date.parse(blog.active_at)) / YEAR : null;

// To earn a spot a blog must be followable (a feed), demonstrably alive, and
// say something about itself. Anything that fails is still in blogs.json.
const qualifies = (blog) => {
  const idle = idleYears(blog);
  return (
    !!blog.url &&
    !!blog.title &&
    !!blog.feed &&
    idle !== null &&
    idle <= 2 &&
    ((blog.desc || "").length > 40 || (blog.hn || []).length > 0)
  );
};

const quality = (blog) => {
  const idle = idleYears(blog);
  const hn = blog.hn || [];
  const best = hn.reduce((m, h) => Math.max(m, h.points), 0);
  return (
    (idle < 0.25 ? 3 : idle < 1 ? 2 : 1) +
    Math.min(hn.length, 3) +
    (best >= 100 ? 2 : best >= 30 ? 1 : 0) +
    ((blog.desc || "").length > 40) +
    !!blog.about +
    !!blog.now +
    // Posts at least monthly.
    (blog.cadence !== undefined && blog.cadence <= 31)
  );
};

for (const blog of allBlogs) {
  blog.title = (blog.title || "").trim();
  blog.desc = (blog.desc || "").trim();
}

// Weighted sample without replacement (Efraimidis-Spirakis): a blog's chance
// of being drawn is proportional to its quality, so the page leans good
// without becoming the same thousand blogs every build. The site rebuilds every
// 2 hours, so the tail gets its turn.
const sample = (pool) => {
  const blogs = pool
    .map((blog) => ({
      blog,
      key: Math.random() ** (1 / Math.max(1, quality(blog))),
    }))
    .sort((a, b) => b.key - a.key)
    .slice(0, PAGE_SIZE)
    .map((x) => x.blog);
  // Sampling leaves the list ordered by key, which tracks quality. Shuffle so
  // the page does not silently rank its own contents.
  for (let i = blogs.length; --i > 0;) {
    const j = Math.floor(Math.random() * (i + 1));
    [blogs[i], blogs[j]] = [blogs[j], blogs[i]];
  }
  return blogs;
};

const qualified = allBlogs.filter(qualifies);
if (qualified.length === 0) {
  throw new Error(
    `build.js: expected blogs on the front page, received 0 of ${allBlogs.length} in blogs.json. Fix: check qualifies(); a stale refresh ages every active_at past two years.`,
  );
}

// Each tag names a file under dist/c/, so it must be a plain slug.
const tags = new Map();
for (const blog of qualified) {
  if (blog.tags === undefined) continue;
  if (
    !Array.isArray(blog.tags) ||
    !blog.tags.every((t) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t))
  ) {
    throw new Error(
      `build.js: expected ${blog.url} to have an array of lowercase-hyphen tags, received ${
        JSON.stringify(blog.tags)
      }. Fix: run refresh.ts --fmt, which drops malformed tags.`,
    );
  }
  for (const t of blog.tags) {
    if (!tags.has(t)) tags.set(t, []);
    tags.get(t).push(blog);
  }
}

// "Zürich, CH" lives at /city/zurich-ch.
const slug = (city) =>
  city.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// NOTE: Cities whose names fold to one slug ("Belém, BR" and "Belem, BR") share one page under both names. Alternative: fail the build. One blog in a small town then stops every deploy.
const cities = new Map();
for (const blog of qualified) {
  if (blog.city === undefined) continue;
  const s = typeof blog.city === "string" ? slug(blog.city) : "";
  if (!s) {
    throw new Error(
      `build.js: expected ${blog.url} to have a city with letters or digits, received ${
        JSON.stringify(blog.city)
      }. Fix: run refresh.ts --fmt, then check cities.tsv.`,
    );
  }
  if (!cities.has(s)) cities.set(s, { names: new Set(), blogs: [] });
  cities.get(s).names.add(blog.city);
  cities.get(s).blogs.push(blog);
}
for (const c of cities.values()) c.name = [...c.names].sort().join(" / ");

// Every page lists every tag, busiest first, so a visitor moves between them without going back.
const nav = (current) =>
  `<nav class="small">${
    [...tags].sort((a, b) =>
      b[1].length - a[1].length || a[0].localeCompare(b[0])
    )
      .map(([t, pool]) =>
        t === current
          ? `<strong>${t}</strong> ${pool.length}`
          : `<a href="/c/${t}">${t}</a> ${pool.length}`
      ).join(" • ")
  }</nav>`;

// A city page names itself above its listing.
const heading = (name) =>
  `<nav class="small"><strong>${esc(name)}</strong></nav>`;

const card = (blog) => {
  let index = "";
  const link = blog.url
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9]/g, (c) => `<wbr/>${esc(c)}`);
  index += `<div class="blog">`;
  index += `<h2><a href="${esc(blog.url)}">${link}</a></h2>`;
  const linkTitles = [
    "about",
    "now",
    "feed",
    "github",
    "bluesky",
    "x",
    "mastodon",
  ];
  const links = [
    blog.about,
    blog.now,
    blog.feed,
    blog.github,
    blog.bluesky,
    blog.x,
    blog.mastodon,
  ]
    .map((x, i) => x && `<a href="${esc(x)}">${linkTitles[i]}</a>`)
    .concat(
      ...(blog.tags ?? []).map((t) => `<a href="/c/${t}">#${t}</a>`),
      blog.city &&
        `<a href="/city/${slug(blog.city)}">${esc(blog.city)}</a>`,
    )
    .filter((x) => x)
    .join(" • ");

  const title_ = [esc(blog.title), links].filter((x) => x).join(` • `);
  if (title_) index += `<p><strong>${title_}</strong></p>`;
  if (blog.desc) index += `<p class="small"><em>${esc(blog.desc)}</em></p>`;
  if (blog.hn) {
    index += `<table>`;
    const stories = blog.hn
      .slice()
      .sort((a, b) => b.points - a.points)
      .slice(0, STORIES_PER_BLOG);
    for (const { id, comments, created_at, points, url, title } of stories) {
      index += `
        <tr>
          <td>${points}</td>
          <td><a href="https://news.ycombinator.com/item?id=${
        esc(id)
      }">${comments}</a></td>
          <td>${esc(created_at.slice(0, 4))}</td>
          <td><a href="${esc(url)}">${esc(title)}</a></td>
        </tr>
      `;
    }
    index += `</table>`;
  }
  index += `</div>`;
  return index;
};

const script = `
  <script>
    function shuffle () {
      const main = document.querySelector("main");
      const temp = main.cloneNode(true);
      for (let i = temp.children.length + 1; i--; )
        temp.appendChild(temp.children[Math.random() * i |0]);
      main.parentNode.replaceChild(temp, main);
    }
    const x = document.getElementById('shuffle').style.display = 'initial';

    const openLinksInNewTab = window.location.search.substring(1).split("&").includes("newTab"); 
    const anchorTarget = openLinksInNewTab ? "_blank" : "_self";
    const links = document.getElementById("index").getElementsByTagName("a");
    for (let i = 0; i < links.length; i++) {
        links[i].target = anchorTarget;
    }
  </script>
`;

// The script sits after main, because shuffle() reorders every child of main.
const listing = (head, pool) =>
  // A function, because a string replacement reads $` and $& in blog titles as patterns.
  template.replace(
    "{{body}}",
    () =>
      `${head}<main id="index">${
        sample(pool).map(card).join("")
      }</main>${script}`,
  );

fs.writeFileSync("./dist/index.html", listing(nav(), qualified));
// A tag or city that empties must lose its page.
process.execSync("rm -rf dist/c dist/city && mkdir -p dist/c dist/city");
for (const [t, pool] of tags) {
  fs.writeFileSync(`./dist/c/${t}.html`, listing(nav(t), pool));
}
for (const [s, { name, blogs }] of cities) {
  fs.writeFileSync(
    `./dist/city/${s}.html`,
    listing(nav() + heading(name), blogs),
  );
}

const about = `
  <div>
    <h2>hello world,</h2>
    <p><a href="/">blogs.hn</a> is a directory of tech sites, primarily sourced from <a href="https://news.ycombinator.com">HackerNews</a>.</p>
    <p>To submit/update a blog, <a href="https://github.com/surprisetalk/blogs.hn/blob/main/blogs.json">edit blogs.json in a pull-request</a>.</p>
    <p>If you like sites with RSS feeds, consider checking out <a href="https://ooh.directory">ooh.directory</a>. If you don't have an RSS reader, I highly recommend <a href="https://reederapp.com">Reeder 5</a>.</p>
    <p>Cities come from GitHub profiles, <a href="https://nownownow.com">nownownow.com</a>, and <a href="https://www.geonames.org">GeoNames</a> (CC BY 4.0).</p>
    <p>You can import all the RSS feeds via <a href="/blogs.hn.opml" download>this OPML file</a>.</p>
    <p>And if you aren't already, <em>you should</em> <a href="https://www.benkuhn.net/writing/">write things on the internet</a>. All you need is <a href="https://github.com/surprisetalk/worstpress">worstpress</a> and some markdown files! You can <a href="mailto:hello@taylor.town">email me</a> if you need help getting started.</p>
    <p>Every blog is a window into a skull. Don't be afraid to ask questions and kindle friendships! Remember to be kind, courteous, and succinct.</p>
    <p>Thanks for stopping by.</p>
    <br/>
    <p style="padding-left: 1rem;">🐸 <a href="https://taylor.town"><strong>Taylor Troesh</strong></a></p>
  </div>
`;

fs.writeFileSync(
  "./dist/about.html",
  template.replace("{{body}}", () => `<main id="about">${about}</main>`),
);

fs.writeFileSync(
  "./dist/blogs.hn.opml",
  `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>blogs.hn</title>
  </head>
  <body>
${
    allBlogs
      .filter((blog) => blog.title && blog.feed && blog.url)
      .map((blog) =>
        `<outline type="rss" text="${esc(blog.title.trim())}" title="${
          esc(blog.title.trim())
        }" htmlUrl="${esc(blog.url.trim())}" xmlUrl="${
          esc(blog.feed.trim())
        }" />`.replace(
          /\s+/gi,
          " ",
        )
      )
      .join("\n")
  }
  </body>
</opml>`,
  "utf-8",
);

fs.writeFileSync(
  "./dist/_headers",
  ["/*.opml", "  Content-Type: text/xml"].join("\n"),
  "utf-8",
);
