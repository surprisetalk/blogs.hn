- [ ] You: rotate the Cloudflare Pages deploy hook for blogs.hn. The old URL sits in the public repo's git history (`.github/workflows/deploy.yml`), so anyone can trigger builds and spend the 500-a-month build quota.
  1. In Cloudflare Pages, blogs.hn, Settings, Builds, Deploy hooks: delete the old hook and create one for branch main.
  2. On pc, put the new URL in `BLOGS_DEPLOY_HOOK` in `/home/taylor/Developer/blogs.hn/.env.deploy`. Then `sudo systemctl start blogs-deploy` must exit 0.
  3. Asked 2026-11-23. You rotate it.
