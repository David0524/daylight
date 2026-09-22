// Matching a WSJ headline to Morningstar's licensed copy. The match is made on
// Morningstar's URL slug, which tracks the headline but drops punctuation and
// sometimes gains "-update" suffixes as the story develops.
import { headlineOverlap, slugify, canonicalUrl } from "../scripts/build-feed.mjs";

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`  ok   ${name}`))
                                     : (fail++, console.log(`  FAIL ${name}`)); };
const slug = (s) => s.replace(/-/g, " ");

check("matches a slug with an update suffix",
  headlineOverlap("U.K. Government Borrowing Rose in August as Budget Looms",
                  slug("uk-government-borrowing-rose-in-august-as-budget-looms-2nd-update")) >= 0.7);
check("matches across curly apostrophes",
  headlineOverlap("Saudi Arabia Spent Months Trying to Bypass Hormuz. For Now, There’s No Way Around It.",
                  slug("saudi-arabia-spent-months-trying-to-bypass-hormuz-for-now-theres-no-way-around-it")) >= 0.7);
check("rejects a different story on the same topic",
  headlineOverlap("Brent Falls Below $100 a Barrel on U.S.-Iran Diplomacy Hopes",
                  slug("oil-prices-fall-for-fourth-day-as-supply-concerns-ease")) < 0.7);
check("rejects an unrelated story",
  headlineOverlap("Trump Summit With Xi Unlikely to Include Chinese CEOs",
                  slug("canada-to-enshrine-expedited-project-reviews-with-legislation")) < 0.7);

// Kanebridge's URLs are the headline slugified; the lookup depends on
// reproducing that exactly, including the dropped "Opinion |" prefix.
check("slugifies an opinion headline as Kanebridge does",
  slugify("Opinion | The Hidden Agenda Behind the AI Panic") === "the-hidden-agenda-behind-the-ai-panic");
check("drops curly apostrophes rather than splitting on them",
  slugify("Trump’s Greenland Deal") === "trumps-greenland-deal");

// A pasted WSJ link rarely carries the same tracking parameter as the feed's
// copy of it; they must still be recognised as the same story.
check("ignores WSJ's mod tracking parameter",
  canonicalUrl("https://www.wsj.com/a/b-1a2b3c4d?mod=rss_worldnews") === canonicalUrl("https://www.wsj.com/a/b-1a2b3c4d"));
check("ignores WSJ's share parameters",
  canonicalUrl("https://www.wsj.com/a/b-1a2b3c4d?st=x9&reflink=share") === canonicalUrl("https://www.wsj.com/a/b-1a2b3c4d"));
check("keeps parameters that only look similar",
  canonicalUrl("https://e.com/p?model=3") !== canonicalUrl("https://e.com/p"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
