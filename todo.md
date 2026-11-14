- [ ] Visitors browse blogs by category and nearby city.
  Decision: bucket "maintain" in the projects strategy (~/Documents/tasks/todo.md, projects entry, 27 Oct). People use it, and it needs a few hours a year, so you keep it (you, 27 Oct).
  1. Split blogs.json into append-only blogs.tsv, hn.tsv, rss.tsv, as the todo says, and update build.js and refresh.ts.
  2. Add deno task status that checks that blogs.hn loads and the newest refresh is under a week old; register it in snitch.
  3. Compute blog similarity with embeddings from the existing ideas.tsv embeddings script, then group by category.
- [ ] add closest major city for each blog. grab from github?
- [ ] blog categories and similarities via vector embeddings
- [ ] change to append-based: blogs.tsv, hn.tsv, rss.tsv