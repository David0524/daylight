import { readFileSync } from "node:fs";
import { fetchHtml, extractFromHtml } from "./extract.mjs";
const s = readFileSync("/tmp/claude-0/-home-user-daylight/14f165b9-10a4-5648-a29e-0d94ffc40287/scratchpad/mintwsj.html", "utf8");
const links = [...new Set([...s.matchAll(/(?:https:\/\/www\.livemint\.com)?(\/[a-z0-9-]+\/[a-z0-9/-]*?-1\d{12,}\.html)/g)].map(m => m[1]))].slice(0, 22);
let free = 0, prem = 0, wsj = 0;
for (const p of links) {
  const u = "https://www.livemint.com" + p;
  const g = await fetchHtml(u, "browser", 20000).catch(() => ({}));
  const h = g.html || "";
  const isWsj = /@wsj\.com|Dow Jones & Company/i.test(h);
  const premium = /isAccessibleForFree"?\s*:\s*"?false/i.test(h);
  if (isWsj) { wsj++; premium ? prem++ : free++; }
  console.log(isWsj ? "WSJ" : "   ", premium ? "premium" : "free   ", p.slice(0, 90));
}
console.log({ wsj, free, prem });
