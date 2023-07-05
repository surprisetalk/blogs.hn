const fs = require("fs");
const process = require("child_process");

process.execSync("mkdir -p dist");
process.execSync("cp style.css dist/style.css");

const template = fs.readFileSync("./template.html");

const blogs = require("./blogs.json");
const index = "<h1>hello world</h1>";
fs.writeFileSync("./dist/index.html", template.replace("{{main}}", index));
