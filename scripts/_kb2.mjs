import { fetchHtml, extractFromHtml } from "./extract.mjs";
const g = await fetchHtml("https://kanebridgenews.com/", "browser", 25000);
const links = [...new Set([...g.html.matchAll(/https:\/\/kanebridgenews\.com\/([a-z0-9-]{15,})\/?(?=["<])/g)].map(m => m[0]))];
const pick = links.filter(u => /openai-scraps|20-something|hidden-agenda/.test(u));
for (const u of pick) {
  const p = await fetchHtml(u, "browser", 20000);
  const a = extractFromHtml(p.html, u);
  console.log("==", u, a.words, a.headline);
  a.paragraphs.slice(0, 3).forEach(x => console.log("  F", x.text.slice(0, 120)));
  a.paragraphs.slice(-3).forEach(x => console.log("  L", x.text.slice(0, 120)));
  const ld = p.html.match(/"articleBody"\s*:\s*"([^"]{0,200})/); console.log("  ld body:", ld && ld[1]);
}
