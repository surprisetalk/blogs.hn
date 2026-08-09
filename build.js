const fs = require("fs");
const process = require("child_process");

process.execSync("mkdir -p dist");
process.execSync("cp style.css dist/style.css");

const template = fs.readFileSync("./template.html", "utf-8");

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

const blogs = require("./blogs.json");

blogs.sort(() => Math.random() - 0.5);

let index = "";
for (const blog of blogs) {
  blog.title = (blog.title || "").trim();
  blog.desc = (blog.desc || "").trim();
  if (!blog.url) continue;
  if (
    3 >
    0 +
      !!blog.title +
      ((blog.desc || "").length > 40) +
      !!blog.about +
      !!blog.now +
      !!blog.feed +
      3 * ((blog.hn || []).length > 1)
  )
    continue;
  const link = blog.url
    .replace(/^https?:\/\//, "")
    .replace(/[^A-Za-z0-9]/g, (c) => `<wbr/>${esc(c)}`);
  index += `<div class="blog">`;
  index += `<h2><a href="${esc(blog.url)}">${link}</a></h2>`;
  const linkTitles = ["about", "now", "feed", "github", "bluesky", "x", "mastodon"];
  const links = [blog.about, blog.now, blog.feed, blog.github, blog.bluesky, blog.x, blog.mastodon]
    .map((x, i) => x && `<a href="${esc(x)}">${linkTitles[i]}</a>`)
    .filter((x) => x)
    .join(" • ");

  const title_ = [esc(blog.title), links].filter((x) => x).join(` • `);
  if (title_) index += `<p><strong>${title_}</strong></p>`;
  if (blog.desc) index += `<p class="small"><em>${esc(blog.desc)}</em></p>`;
  if (blog.hn) {
    index += `<table>`;
    for (const { id, comments, created_at, points, url, title } of blog.hn)
      index += `
        <tr>
          <td>${points}</td>
          <td><a href="https://news.ycombinator.com/item?id=${esc(id)}">${comments}</a></td>
          <td>${esc(created_at.slice(0, 4))}</td>
          <td><a href="${esc(url)}">${esc(title)}</a></td>
        </tr>
      `;
    index += `</table>`;
  }
  index += `</div>`;
}

index += `
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

fs.writeFileSync(
  "./dist/index.html",
  template.replace("{{body}}", `<main id="index">${index}</main>`),
);

const about = `
  <div>
    <h2>hello world,</h2>
    <p><a href="/">blogs.hn</a> is a directory of tech sites, primarily sourced from <a href="https://news.ycombinator.com">HackerNews</a>.</p>
    <p>To submit/update a blog, <a href="https://github.com/surprisetalk/blogs.hn/blob/main/blogs.json">edit blogs.json in a pull-request</a>.</p>
    <p>If you like sites with RSS feeds, consider checking out <a href="https://ooh.directory">ooh.directory</a>. If you don't have an RSS reader, I highly recommend <a href="https://reederapp.com">Reeder 5</a>.</p>
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
  template.replace("{{body}}", `<main id="about">${about}</main>`),
);

fs.writeFileSync(
  "./dist/blogs.hn.opml",
  `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>blogs.hn</title>
  </head>
  <body>
${blogs
  .filter((blog) => blog.title && blog.feed && blog.url)
  .map((blog) =>
    `<outline type="rss" text="${esc(blog.title.trim())}" title="${esc(blog.title.trim())}" htmlUrl="${esc(blog.url.trim())}" xmlUrl="${esc(blog.feed.trim())}" />`.replace(
      /\s+/gi,
      " ",
    ),
  )
  .join("\n")}
  </body>
</opml>`,
  "utf-8",
);

fs.writeFileSync(
  "./dist/_headers",
  ["/*.opml", "  Content-Type: text/xml"].join("\n"),
  "utf-8",
);
