const fetch = require("node-fetch");
const axios = require("axios");
const cheerio = require("cheerio");

const links = process.argv.slice(2);

(async () => {
  const blogs = [];
  for (const link of links) {
    try {
      const res = await axios.get(link),
        $ = cheerio.load(res.data),
        title = $("title").first().text() ?? undefined,
        keywords = $('meta[name="keywords"]').attr("content") ?? undefined,
        desc = $('meta[name="description"]').attr("content") ?? undefined;
      let about, now, feed, news, hn;

      $("link, a, button").each((i, x) => {
        let url = new URL($(x).attr("href"), link);
        if (url.pathname === "/about") about = url.href;
        if (url.pathname === "/now") now = url.href;
        if (
          url.pathname.match(
            /(\/index.xml|\/rss\.xml|\/feed\.xml|\/rss|\/feed|\.atom)$/
          )
        )
          feed = url.href;
      });

      try {
        const alg = await fetch(
          `https://hn.algolia.com/api/v1/search` +
            `?tags=story` +
            `&restrictSearchableAttributes=url` +
            `&query=${encodeURIComponent(link.replace(/^https?:\/\//, ""))}`
        );
        const data = await alg.json();
        hn = data?.hits
          ?.map(hit => ({
            created_at: hit.created_at,
            title: hit.title,
            url: hit.url,
            points: hit.points,
            comments: hit.num_comments,
            id: hit.objectID,
          }))
          ?.filter(hit => hit.points >= 10 || hit.comments >= 5);
        if (!hn.length) hn = undefined;
      } catch (err) {
        console.error(`Error: ${err}`);
      }

      blogs.push({
        url: link,
        title,
        about,
        now,
        feed,
        news,
        keywords,
        desc,
        hn,
      });
    } catch (error) {
      console.error(`Error: ${error} for url: ${link}`);
    }
  }

  console.log(JSON.stringify(blogs, null, 2));
})();
