# [blogs.hn](https://blogs.hn)

[blogs.hn](https://blogs.hn) is for _personal_ blogs! Non-technical blogs are
okay too, but remember that the community is mostly folks from
[HackerNews](https://news.ycombinator.com).

## Adding Blogs

This repo comes with a helper script `fetch.js` to automatically grab blog info
from a URL. But feel free to manually add/edit information to `blogs.json`!

1. Run the script:

```bash
npm init -y && npm i axios cheerio
node fetch.js "https://taylor.town" "https://gwern.net"
```

2. Clean the output:

```json
[
  {
    "url": "https://taylor.town",
    "title": "Taylor Troesh",
    "about": "https://taylor.town/about",
    "now": "https://taylor.town/now",
    "feed": "https://taylor.town/feed.xml",
    "desc": "🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸🐸",
    "hn": [
      {
        "created_at": "2023-04-04T11:42:33.000Z",
        "title": "How to be a -10x Engineer",
        "url": "https://taylor.town/-10x",
        "points": 875,
        "comments": 494,
        "id": "35438068"
      }
    ]
  },
  {
    "url": "https://gwern.net",
    "title": "Essays · Gwern.net",
    "about": "https://gwern.net/about",
    "feed": "https://gwern.substack.com/feed",
    "keywords": "meta",
    "desc": "Personal website of Gwern Branwen (writer, self-experimenter, and programmer): topics: psychology, statistics, technology, deep learning, anime. This index page is a categorized list of Gwern.net pages.",
    "hn": [
      {
        "created_at": "2019-01-21T12:08:15.000Z",
        "title": "On whether changes in bedroom CO2 levels affect sleep quality",
        "url": "https://www.gwern.net/zeo/CO2",
        "points": 576,
        "comments": 306,
        "id": "18959796"
      }
    ]
  }
]
```

3. Append to
   [blogs.json](https://github.com/surprisetalk/blogs.hn/blob/main/blogs.json)
   in a pull request.
