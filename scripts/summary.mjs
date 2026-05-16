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
const requests = await loadRecent("feature_requests");
console.log(`Loaded ${comments.length} comments, ${requests.length} feature requests`);

// Build a compact text dump for the model.
function fmtComment(c) {
  const parts = [];
  if (c.item) parts.push(`[${c.item}]`);
  if (c.rating) parts.push(`${c.rating}/5`);
  if (c.text) parts.push(c.text);
  return parts.join(" ");
}
const commentLines = comments.map(fmtComment).filter(Boolean);
const requestLines = requests.map(r => r.text).filter(Boolean);

let summary = "";
if (!commentLines.length && !requestLines.length) {
  summary = "No feedback collected this week yet.";
} else {
  const prompt = [
    "You are summarizing student feedback for Caltech Dining Services.",
    "Be concrete and brief: 5–10 bullets MAX. Group complaints by dish or theme,",
    "highlight any safety/allergen concerns first, and surface the most-asked-for",
    "feature requests. Do not invent foods or themes that aren't in the data.",
    "",
    "=== Comments and ratings (this week) ===",
    commentLines.length ? commentLines.join("\n") : "(none)",
    "",
    "=== Feature requests for the website (this week) ===",
    requestLines.length ? requestLines.join("\n") : "(none)",
  ].join("\n");

  const model = "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
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
  requestCount: requests.length,
  summary,
}, null, 2) + "\n");
console.log("Wrote data/summary.json");
