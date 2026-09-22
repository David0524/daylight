// Matching a WSJ headline to Morningstar's licensed copy. The match is made on
// Morningstar's URL slug, which tracks the headline but drops punctuation and
// sometimes gains "-update" suffixes as the story develops.
import { headlineOverlap } from "../scripts/build-feed.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
