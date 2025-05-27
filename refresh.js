const blogs = require("./blogs.json");

(async () => {
  for (const i in blogs) {
    try {
      const blog = blogs[i];
      const alg = await fetch(
        `https://hn.algolia.com/api/v1/search` +
          `?tags=story` +
          `&restrictSearchableAttributes=url` +
          `&query=${encodeURIComponent(blog.url.replace(/^https?:\/\//, ""))}`,
      );
      const data = await alg.json();
      const hn = data?.hits
        ?.map((hit) => ({
          created_at: hit.created_at,
          title: hit.title,
          url: hit.url,
          points: hit.points,
          comments: hit.num_comments,
          id: hit.objectID,
        }))
        ?.filter((hit) => hit.points >= 10 || hit.comments >= 5);
      if ((hn?.length ?? 0) >= (blog.hn?.length ?? 0)) blogs[i].hn = hn;
    } catch (err) {
      console.error(`Error: ${err}`);
    }
  }
  console.log(JSON.stringify(blogs, null, 2));
})();
