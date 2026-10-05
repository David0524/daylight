import { fetchHtml, extractFromHtml } from "./extract.mjs";
import { credits, publisherFor } from "./syndicated.mjs";
for (const p of ["/global/bank-stocks-are-haunted-by-the-ghosts-of-2023-11791197209362.html",
                 "/politics/lula-is-the-brazilian-left-s-last-hope-and-its-biggest-problem-11791079270819.html",
                 "/global/democrats-inch-into-red-territory-but-have-problems-on-home-turf-11791204421598.html",
                 "/market/bonds/how-the-french-bond-trade-backfired-on-investors-11791031756769.html"]) {
  const u = "https://www.livemint.com" + p;
  const g = await fetchHtml(u, "browser", 20000);
  const a = g.html && extractFromHtml(g.html, u);
  const wsjLines = (g.html || "").match(/[^<>]{0,80}(Wall Street Journal|Dow Jones|@wsj\.com)[^<>]{0,80}/g) || [];
  console.log(g.status, a ? `${a.words}w partial=${a.partial}` : "unreadable", "credited=" + (a ? credits(g.html, a, publisherFor("https://www.wsj.com/x"), u) : "-"), p.slice(0, 60));
  console.log("   premium:", /isAccessibleForFree"?\s*:\s*"?false/i.test(g.html || ""), "| lines:", wsjLines.slice(0, 3).map(s => s.trim().slice(0, 120)));
  if (a) console.log("   first:", a.paragraphs[0]?.text.slice(0, 100), "\n   last:", a.paragraphs.at(-1)?.text.slice(0, 120));
}
