- [ ] You: rotate the Cloudflare Pages deploy hook for blogs.hn. The old URL sits in the public repo's git history (`.github/workflows/deploy.yml`), so anyone can trigger builds and spend the 500-a-month build quota.
  1. In Cloudflare Pages, blogs.hn, Settings, Builds, Deploy hooks: delete the old hook and create one for branch main.
  2. On pc, put the new URL in `BLOGS_DEPLOY_HOOK` in `/home/taylor/Developer/blogs.hn/.env`. Then `sudo systemctl start blogs-deploy` must exit 0.
  3. Asked 2026-11-23. You rotate it.

- [ ] Visitors browse blogs by nearby city.
  Decision: bucket "maintain" in the projects strategy (~/Documents/tasks/todo.md, projects entry, 27 Oct). People use it, and it needs a few hours a year, so you keep it (you, 27 Oct).
  Decision: blogs.json stays one file; no split into blogs.tsv, hn.tsv, rss.tsv (you, 2026-11-23).
  1. Add the closest major city for each blog. Source: the location field of the blog's GitHub profile ("grab from github?"). A blog without a `github` field gets no city.
  2. Build a page per city at `/city/<slug>`, as build.js does for `/c/<category>`.
