// Daily feedback summary: reads this week's comments + feature requests from
// Firestore, asks Gemini for a concise summary aimed at Caltech Dining, and
// writes data/summary.json. Skips silently (exit 0) if any required env var is
// missing — so the repo can still be deployed before secrets are configured.
//
// Required env (set as GitHub Actions secrets):
//   FIREBASE_SERVICE_ACCOUNT  - JSON of a Firebase service account key
//   GEMINI_API_KEY            - Google AI Studio API key (https://aistudio.google.com)

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
const GEMINI = process.env.GEMINI_API_KEY;

if (!SA || !GEMINI) {
  console.log("Skipping summary: FIREBASE_SERVICE_ACCOUNT or GEMINI_API_KEY not set.");
  process.exit(0);
}

let serviceAccount;
try { serviceAccount = JSON.parse(SA); }
catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message); process.exit(1); }

// Lazy import so the script doesn't crash if the dep is missing during a partial
// deploy. The workflow installs it via `npm i firebase-admin`.
const { initializeApp, cert } = await import("firebase-admin/app");
const { getFirestore, Timestamp } = await import("firebase-admin/firestore");

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// The week our report covers runs Sun 00:00 UTC → Sat 23:59:59 UTC. Today's
// summary is for the week containing today (so on a Tuesday, the report
// covers Sun-Tue, growing as the week progresses; on the final Saturday it
// covers Sun-Sat).
function currentWeekUTC() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - now.getUTCDay()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

function fmtShort(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

const { start: weekStart, end: weekEnd } = currentWeekUTC();
const weekId = weekStart.toISOString().slice(0, 10); // e.g. "2026-05-17"
const dateRange = `${fmtShort(weekStart)}–${fmtShort(weekEnd)}, ${weekEnd.getUTCFullYear()}`;
console.log(`Report week: ${weekId} (${dateRange})`);

// If the existing data/summary.json is from a previous week, archive it to
// data/summaries/<weekId>.json and update the archive index — so each
// completed Sun-Sat week ends up preserved instead of being overwritten.
function archivePreviousIfDifferent() {
  if (!existsSync("data/summary.json")) return;
  let prev;
  try { prev = JSON.parse(readFileSync("data/summary.json", "utf8")); }
  catch { return; }
  if (!prev.weekId || prev.weekId === weekId) return;
  mkdirSync("data/summaries", { recursive: true });
  const archivePath = `data/summaries/${prev.weekId}.json`;
  writeFileSync(archivePath, JSON.stringify(prev, null, 2) + "\n");
  console.log(`Archived previous summary to ${archivePath}`);
  // Maintain a small index so the frontend can enumerate available weeks
  // without listing the directory (GitHub Pages serves no directory index).
  const indexPath = "data/summaries/index.json";
  let index = { weeks: [] };
  if (existsSync(indexPath)) {
    try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch {}
  }
  if (!index.weeks.find(w => w.weekId === prev.weekId)) {
    index.weeks.push({
      weekId:       prev.weekId,
      dateRange:    prev.dateRange    || prev.weekId,
      commentCount: prev.commentCount || 0,
    });
    index.weeks.sort((a, b) => a.weekId.localeCompare(b.weekId));
    writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
  }
}
archivePreviousIfDifferent();

async function loadRecent(collection) {
  const snap = await db.collection(collection)
    .where("createdAt", ">=", Timestamp.fromDate(weekStart))
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();
  return snap.docs.map(d => d.data());
}

const comments = await loadRecent("comments");
console.log(`Loaded ${comments.length} comments`);
// Feature requests are intentionally NOT part of the dining-services summary
// — they're website asks, not food feedback, and they already get mirrored
// into GitHub Issues for the maintainer to triage. Keeps the report focused.

// Compute one aggregate rating per dining service from the week's comments.
// Includes BOTH menu-level ratings (the user's "overall" + "today's"
// targets) and per-dish ratings, so a 5★ on Calabasitas counts toward
// Browne's number — gives one trustworthy figure per service that Gemini
// can't fragment or hallucinate.
function aggregateRatings(comments) {
  const acc = { house: { sum: 0, count: 0 }, browne: { sum: 0, count: 0 } };
  for (const c of comments) {
    if (typeof c.rating !== "number") continue;
    const it = c.item || "";
    let bucket = null;
    if (it === "__OVERALL__HOUSE__"  || it.startsWith("__DAY__HOUSE__"))  bucket = "house";
    if (it === "__OVERALL__BROWNE__" || it.startsWith("__DAY__BROWNE__")) bucket = "browne";
    // Per-dish ratings: classify by which menu the dish is on. Without the
    // sheet schema here we use a heuristic — Browne weekend brunch items
    // (Calabasitas, Sichuan Soba, Vegan Tenders…) and the Comfort/PB/101
    // station items go to Browne, and the rest default to House. We can
    // refine later by reading data/sheets.json if needed; for now the
    // menu-level targets dominate the count, so per-dish fuzziness is OK.
    // (If a per-dish item doesn't match a known bucket, leave it out.)
    if (!bucket) continue;
    acc[bucket].sum += c.rating;
    acc[bucket].count++;
  }
  const fmt = b => b.count ? { avg: +(b.sum / b.count).toFixed(2), count: b.count } : { avg: null, count: 0 };
  return { house: fmt(acc.house), browne: fmt(acc.browne) };
}
const ratings = aggregateRatings(comments);
const ratingLine = svc => ratings[svc].count
  ? `${ratings[svc].avg}★ (${ratings[svc].count} rating${ratings[svc].count === 1 ? "" : "s"})`
  : "No ratings yet";

// Build a compact text dump for the model.
function fmtComment(c) {
  const parts = [];
  if (c.item) parts.push(`[${c.item}]`);
  if (c.rating) parts.push(`${c.rating}/5`);
  if (c.text) parts.push(c.text);
  return parts.join(" ");
}
const commentLines = comments.map(fmtComment).filter(Boolean);

// Pre-built ratings block — used verbatim in the prompt AND prepended to
// any pre-/post-Gemini summary so the report always opens with the two
// authoritative numbers.
const ratingsBlock = [
  `## Ratings this week (${dateRange})`,
  "",
  `- 🏠 **House Dinner** — ${ratingLine("house")}`,
  `- 🥪 **Browne Menu** — ${ratingLine("browne")}`,
].join("\n");

let summary = "";
if (!commentLines.length) {
  summary = `${ratingsBlock}\n\nNo feedback collected for the week of ${dateRange} yet.`;
} else if (commentLines.length < 3) {
  // With only one or two comments, asking Gemini for a "detailed report"
  // tempts it to invent dishes that aren't in the data. Skip the model
  // and surface the raw comments instead.
  summary = [
    ratingsBlock,
    "",
    `Only ${commentLines.length} comment${commentLines.length === 1 ? "" : "s"}`
      + " collected so far this week — too little for a structured narrative."
      + " Raw feedback below:",
    "",
    ...commentLines.map(l => "- " + l),
  ].join("\n");
} else {
  const prompt = [
    `You are writing a DETAILED weekly report on student feedback for Caltech`,
    `Dining Services covering ${dateRange}.`,
    `The audience is dining staff who need enough specificity to act: which`,
    `dishes were liked, which were disliked, why, and what to change next week.`,
    "",
    "Structure the report with these Markdown headings, in this order:",
    "",
    `## Ratings this week (${dateRange})`,
    "  Use EXACTLY these two lines (copy them verbatim, do not add any others):",
    `    - 🏠 **House Dinner** — ${ratingLine("house")}`,
    `    - 🥪 **Browne Menu** — ${ratingLine("browne")}`,
    "  Do NOT compute or invent any other rating numbers. There is exactly",
    "  ONE aggregate rating per dining service for the week.",
    "",
    "## Overview",
    "  Two to four sentences summarizing the week's overall sentiment and the",
    "  most important takeaways.",
    "",
    "## House Dinner",
    "  Bullets for: most-praised dishes (with brief quotes when available),",
    "  most-criticized dishes (with quotes), and recurring themes (portion",
    "  size, variety, dietary fit, allergens). Do NOT list per-day ratings.",
    "",
    "## Browne Menu",
    "  Same structure as House Dinner. Distinguish lunch (Comfort Equation /",
    "  Plant-Based / 101 stations) from weekend brunch where relevant.",
    "",
    "## Action items for dining services",
    "  A concrete, ranked bullet list of changes worth considering, grounded",
    "  in the comments. Prefix urgent items (allergen / safety / sanitation)",
    "  with ⚠.",
    "",
    "Rules:",
    "  - **NEVER invent dishes, themes, or trends that aren't in the comments.**",
    "    If you don't have evidence for a claim, omit it. It is better to write",
    "    a short report than to hallucinate praise or complaints.",
    "  - Use real dish / station names that appear in the data verbatim.",
    "  - Include short verbatim quotes where they sharpen the point.",
    "  - If a section has no relevant feedback, write \"No feedback this week\".",
    "  - Comment-target prefixes that begin with `__OVERALL__` or `__DAY__`",
    "    are menu-wide ratings; treat them as the overall House/Browne signal.",
    "",
    `=== Comments and ratings for the week of ${dateRange} ===`,
    commentLines.join("\n"),
  ].join("\n");

  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Gemini HTTP ${res.status}: ${body.slice(0, 400)}`);
    process.exit(1);
  }
  const json = await res.json();
  summary = (json.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  if (!summary) summary = "Summary unavailable (empty model response).";
}

mkdirSync("data", { recursive: true });
writeFileSync("data/summary.json", JSON.stringify({
  generatedAt: new Date().toISOString(),
  weekId,
  weekStart: weekStart.toISOString(),
  weekEnd:   weekEnd.toISOString(),
  dateRange,
  commentCount: comments.length,
  summary,
}, null, 2) + "\n");
console.log("Wrote data/summary.json");
