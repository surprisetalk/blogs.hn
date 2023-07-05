const fs = require("fs");
const process = require("child_process");

process.execSync("mkdir -p dist");
process.execSync("cp style.css dist/style.css");

const template = fs.readFileSync("./template.html", "utf-8");

const blogs = require("./blogs.json");

const sum = xs => (xs ?? []).reduce((a, b) => a + b, 0);
blogs.sort(
  (a, b) =>
    (sum(b?.hn?.map(x => x.points + x.comments)) ?? 0) -
    (sum(a?.hn?.map(x => x.points + x.comments)) ?? 0)
);

let index = "";
for (const blog of blogs) {
  if (!blog.url) continue;
  const link = blog.url.replace(/^https?:\/\//, "");
  index += `<div>`;
  index += `<h2><a href="${blog.url}">${link}</a></h2>`;
  if (blog.title) index += `<h3>${blog.title}</h3>`;
  if (blog.desc) index += `<p>${blog.desc}</p>`;
  if (blog.hn) {
    index += `<table>`;
    for (const story of blog.hn)
      index += `
        <tr>
          <td><a href="https://news.ycombinator.com/item?id=${story.id}">${story.comments}</a></td>
          <td>${story.points}</td>
          <td><a href="${story.url}">${story.title}</a></td>
        </tr>
      `;
    index += `</table>`;
  }
  index += `</div>`;
}

fs.writeFileSync("./dist/index.html", template.replace("{{main}}", index));
