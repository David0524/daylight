// Regression tests for the wall-detection logic.
// The archive.ph fixture is a real captured response: 810 bytes, HTTP 200,
// which passed the old `length < 800` guard by ten bytes and was rendered
// to the reader as an article.
import { readFileSync } from "node:fs";
import { rejectReason } from "../src/index.js";

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const captcha = readFileSync(new URL("./fixture-archiveph-captcha.txt", import.meta.url), "utf8");

console.log("wall detection:");
check("real archive.ph captcha is rejected", rejectReason(captcha) !== null);
check("  ...and old length guard would have passed it", captcha.length >= 800);
check("jina captcha warning line", rejectReason("Warning: This page maybe requiring CAPTCHA\n\nMarkdown Content:\n" + "x".repeat(5000)) !== null);
check("cloudflare ray id", rejectReason("Attention Required! | Cloudflare\nRay ID: 8f2a\n" + "y".repeat(3000)) !== null);
check("hard paywall copy", rejectReason("Subscribe to continue reading this article. " + "z".repeat(3000)) !== null);
check("empty input", rejectReason("") !== null);
check("short input", rejectReason("tiny") !== null);

// A long nav dump with no prose must still be rejected — this is the case that
// pure length checks always miss.
const navDump = Array.from({ length: 200 }, (_, i) => `[Link ${i}](https://x.com/${i})`).join("\n\n");
check("link-only nav dump", rejectReason(navDump) !== null);

console.log("\nreal articles pass:");
const realArticle = [
  "Title: A Genuine News Story",
  "",
  "Markdown Content:",
  "",
  "The regulator said on Tuesday that it would open a formal investigation into the matter, citing concerns raised by several industry participants over the preceding months and the need for a fuller public accounting.",
  "",
  "In a statement, the company said it disagreed with the characterisation of events and would cooperate fully with any review, while maintaining that its existing disclosures were complete and accurate in all material respects.",
  "",
  "Analysts covering the sector noted that the inquiry could take more than a year to conclude, and that similar reviews elsewhere had ended without enforcement action despite lengthy and costly proceedings for the firms involved.",
  "",
  "A spokesperson for the agency declined to comment beyond the published statement, saying only that the process would follow the usual timetable and that further updates would be issued as appropriate.",
  "",
  "The investigation follows a series of complaints filed with the agency over the past eighteen months, according to two people familiar with the process who were not authorised to discuss it publicly and spoke on condition of anonymity.",
  "",
  "Shares in the company fell modestly in afternoon trading before recovering much of the decline by the close, as investors weighed the likelihood of a material financial penalty against the long timelines such reviews typically involve.",
].join("\n");
check("genuine article accepted", rejectReason(realArticle) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
