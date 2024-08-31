const fetch = require("node-fetch");
const xml2js = require("xml2js");

process.stdin.setEncoding('utf8');

let input = '';
process.stdin.on('data', chunk => input += chunk);

process.stdin.on('end', async () => {
    try {
        const feeds = JSON.parse(input)
            .map(x => x.feed)
            .filter(x => x)
            .sort(() => Math.random() - 0.5)
            .slice(0, 1);

        const results = await Promise.all(feeds.map(async (url) => {
            try {
                console.log(url);
                const response = await fetch(url);
                const text = await response.text();
                const parser = new xml2js.Parser();
                const xml = await parser.parseStringPromise(text);

                const items = xml.rss ? xml.rss.channel[0].item : xml.feed.entry;
                return items.map(item => {
                    let obj = {};
                    for (let key in item) {
                        obj[key] = item[key][0];
                    }
                    return obj;
                });
            } catch (error) {
                return [];
            }
        }));

      console.log(results?.[0]);

        const output = results
            .flatMap(x => x)
            .filter(x => x.id || x.guid)
            .map(x => `${x.id || x.guid}\t${x.link}`)
            .join('\n');

        console.log(output);
    } catch (error) {
        console.error("Error parsing input or processing feeds:", error);
    }
});
