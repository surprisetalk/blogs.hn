- [ ] A refresh reads feed stats from shelob's feed_item table and fetches no known feed.
  1. On pc, tag `pc-shelob-refresh` in ~/Developer/blogs.hn holds 2 unpushed commits from 7 Nov. Cherry-pick them onto main.
  2. Resolve conflicts: take their refresh.ts, refresh_test.ts, and readme text, then run `deno fmt`. Merge their deno.json imports and test permissions into `deno task check`.
  3. Review the design, run `deno task check`, and push. Then delete the tag.
- [ ] Visitors browse blogs by category and nearby city.
  Decision: bucket "maintain" in the projects strategy (~/Documents/tasks/todo.md, projects entry, 27 Oct). People use it, and it needs a few hours a year, so you keep it (you, 27 Oct).
  1. Split blogs.json into append-only blogs.tsv, hn.tsv, rss.tsv, as the todo says, and update build.js and refresh.ts.
  2. Compute blog similarity with embeddings from the existing ideas.tsv embeddings script, then group by category.
- [ ] add closest major city for each blog. grab from github?
- [ ] blog categories and similarities via vector embeddings
- [ ] change to append-based: blogs.tsv, hn.tsv, rss.tsv