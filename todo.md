- [ ] You: rotate the Cloudflare Pages deploy hook for blogs.hn. The old URL sits in the public repo's git history (`.github/workflows/deploy.yml`), so anyone can trigger builds and spend the 500-a-month build quota.
  1. In Cloudflare Pages, blogs.hn, Settings, Builds, Deploy hooks: delete the old hook and create one for branch main.
  2. On pc, put the new URL in `BLOGS_DEPLOY_HOOK` in `/home/taylor/Developer/blogs.hn/.env.deploy`. Then `sudo systemctl start blogs-deploy` must exit 0.
  3. Asked 2026-11-23. You rotate it.

- [ ] Visitors browse blogs by 1-3 topic tags drawn from natural clusters of their posts, and the category strip returns.
  Decision: approved (you, 2026-11-23).
  1. Embed each post's title and summary from shelob's `feed_item` (`title`, `raw`), not refetched feeds, with nomic-embed-text on pc's llama-cpp-embed. Store vectors in `vectors.tsv` (feed, post url, published_at, 768 numbers at 4 decimals), gitignored on pc: at about 3 KB a post it runs to hundreds of MB (you, 2026-11-23).
  2. Embed each blog's title, desc, and /about text as one extra point; posts outweigh it.
  3. Cluster post vectors (HDBSCAN or k-means over UMAP), not blog vectors. Ask vixing's clustering lane before writing a second one; it already clusters nomic vectors.
  4. Name each cluster once with Gemma on pc from its 20 central post titles, then review the names by hand. Freeze names and centroids in a committed file.
  5. A blog's tags are the clusters holding at least 20% of its posts, at most 3, strongest first. Weekly refreshes assign new posts to frozen centroids; reclustering is a deliberate run.
  6. Replace `category` with `tags` in blogs.json, build.js, and refresh.ts, then restore the strip at the top.
