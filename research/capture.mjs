// Grab one real article per outlet and save the raw capture, so per-publisher
// junk patterns can be studied from actual data rather than guessed at.
import { writeFileSync, mkdirSync } from "node:fs";
import { jina, scoreText, STRATEGIES } from "./strategies.mjs";

const targets = JSON.parse(process.argv[2]);
mkdirSync("research/captures", { recursive: true });

for (const [host, url] of Object.entries(targets)) {
  const slug = host.replace(/\W+/g, "_");
  let best = null, via = "none";
  for (const name of ["jina-share-params", "jina", "jina-googlebot"]) {
    try {
      const txt = await STRATEGIES[name](url);
      const s = scoreText(txt);
      if (txt && !s.wall && (!best || s.words > scoreText(best).words)) { best = txt; via = name; }
      if (best && scoreText(best).words > 900) break;
    } catch {}
  }
  if (best) {
    writeFileSync(`research/captures/${slug}.md`, best);
    const s = scoreText(best);
    console.log(`  ${host.padEnd(22)} ${String(s.words).padStart(5)}w via ${via.padEnd(18)} (${best.split("\n").length} lines raw)`);
  } else {
    console.log(`  ${host.padEnd(22)}   —   unreachable`);
  }
}
