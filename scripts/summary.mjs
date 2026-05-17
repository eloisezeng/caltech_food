// Daily feedback summary: reads this week's comments + feature requests from
// Firestore, asks Gemini for a concise summary aimed at Caltech Dining, and
// writes data/summary.json. Skips silently (exit 0) if any required env var is
// missing — so the repo can still be deployed before secrets are configured.
//
// Required env (set as GitHub Actions secrets):
//   FIREBASE_SERVICE_ACCOUNT  - JSON of a Firebase service account key
//   GEMINI_API_KEY            - Google AI Studio API key (https://aistudio.google.com)

import { writeFileSync, mkdirSync } from "node:fs";

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

const sevenDaysAgo = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

async function loadRecent(collection) {
  const snap = await db.collection(collection)
    .where("createdAt", ">=", sevenDaysAgo)
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

// Build a compact text dump for the model.
function fmtComment(c) {
  const parts = [];
  if (c.item) parts.push(`[${c.item}]`);
  if (c.rating) parts.push(`${c.rating}/5`);
  if (c.text) parts.push(c.text);
  return parts.join(" ");
}
const commentLines = comments.map(fmtComment).filter(Boolean);

let summary = "";
if (!commentLines.length) {
  summary = "No feedback collected this week yet.";
} else {
  const prompt = [
    "You are writing a DETAILED weekly report on student feedback for Caltech",
    "Dining Services. The audience is dining staff who need enough specificity",
    "to act: which dishes were liked, which were disliked, why, and what to",
    "change next week.",
    "",
    "Structure the report with these Markdown headings, in this order:",
    "",
    "## Overview",
    "  Two to four sentences summarizing the week's overall sentiment and the",
    "  most important takeaways.",
    "",
    "## House Dinner",
    "  Bullets for: most-praised dishes (with brief quotes when available),",
    "  most-criticized dishes (with quotes), recurring themes (portion size,",
    "  variety, dietary fit, allergens), and any rating trends across days.",
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
    "  - Use real dish / station names that appear in the data — do not invent.",
    "  - Include short verbatim quotes where they sharpen the point.",
    "  - If a section has no relevant feedback, write \"No feedback this week\".",
    "  - Comment-target prefixes that begin with `__OVERALL__` or `__DAY__`",
    "    are menu-wide ratings; treat them as the overall House/Browne signal.",
    "",
    "=== Comments and ratings (this week) ===",
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
  commentCount: comments.length,
  summary,
}, null, 2) + "\n");
console.log("Wrote data/summary.json");
