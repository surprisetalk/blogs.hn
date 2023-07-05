const fs = require("fs");
const process = require("child_process");

process.execSync("mkdir -p dist");
process.execSync("cp style.css dist/style.css");

const template = fs.readFileSync("./template.html", "utf-8");

const blogs = require("./blogs.json");

const sum = xs => (xs ?? []).reduce((a, b) => a + b, 0);
blogs.sort(() => Math.random() - 0.5);
// blogs.sort((a, b) => (sum(b?.hn?.map(x => x.points + x.comments)) ?? 0) - (sum(a?.hn?.map(x => x.points + x.comments)) ?? 0));

let index = "";
for (const blog of blogs) {
  if (!blog.url) continue;
  const link = blog.url.replace(/^https?:\/\//, "");
  index += `<div class="blog">`;
  index += `<h2><a href="${blog.url}">${link}</a></h2>`;
  const linkTitles = ["about", "now", "feed", "news"];
  const links = [blog.about, blog.now, blog.feed, blog.news]
    .map((x, i) => x && `<a href=${x}>${linkTitles[i]}</a>`)
    .filter(x => x)
    .join(" • ");
  const subtitle = [blog.title, links].filter(x => x).join(" • ");
  if (subtitle) index += `<h3>${subtitle}</h3>`;
  if (blog.desc) index += `<p>${blog.desc}</p>`;
  if (blog.hn) {
    index += `<table>`;
    for (const { id, comments, created_at, points, url, title } of blog.hn)
      index += `
        <tr>
          <td>${points}</td>
          <td><a href="https://news.ycombinator.com/item?id=${id}">${comments}</a></td>
          <td>${created_at.slice(0, 4)}</td>
          <td><a href="${url}">${title}</a></td>
        </tr>
      `;
    index += `</table>`;
  }
  index += `</div>`;
  // TODO: shuffle, [] rss only, [search]
}

fs.writeFileSync("./dist/index.html", template.replace("{{main}}", index));
