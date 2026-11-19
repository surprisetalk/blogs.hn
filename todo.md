- [ ] The site rebuilds at least every 3 hours, so "The site rebuilt within 3 hours." scores 1.0. Cause: the `schedule` cron in `.github/workflows/deploy.yml` (`0 * * * *`) fires 3 to 4 times a day, not hourly, because GitHub delays and drops scheduled runs. The last gaps between runs are 9 h, 7 h and 6 h.
  1. Add a pc systemd timer `blogs-deploy` in `/etc/nixos/flake.nix` (repo `surprisetalk/pc`), next to `blogs-refresh`. It runs `curl -fsS -m 30 -X POST "$BLOGS_DEPLOY_HOOK"` every hour. It fails loudly on a non-2xx answer.
  2. Move the Cloudflare deploy-hook URL out of `deploy.yml` into an env file on pc, mode 0600. The URL is a secret and sits in a public repo today. Rotate the hook in the Cloudflare Pages settings.
  3. Delete `.github/workflows/deploy.yml`, so one trigger remains. Tradeoff: if pc is down, the site stops rebuilding, and the status check shows it.
  4. Run `deno task status`. The condition must score at least 1.0 within 3 hours of the timer's first run.

- [ ] Visitors browse blogs by category and nearby city.
  Decision: bucket "maintain" in the projects strategy (~/Documents/tasks/todo.md, projects entry, 27 Oct). People use it, and it needs a few hours a year, so you keep it (you, 27 Oct).
  1. Split blogs.json into append-only blogs.tsv, hn.tsv, rss.tsv, as the todo says, and update build.js and refresh.ts.
  2. Compute blog similarity with embeddings from the existing ideas.tsv embeddings script, then group by category.
- [ ] add closest major city for each blog. grab from github?
- [ ] blog categories and similarities via vector embeddings
- [ ] change to append-based: blogs.tsv, hn.tsv, rss.tsv