// Comment moderation pass: finds any Firestore comments with
// moderationStatus="pending", asks Gemini to classify each as "ok" or
// "blocked", and writes the result back. Runs every 15 minutes via
// .github/workflows/moderate.yml. Comments without text (rating-only) are
// auto-approved without calling the model.
//
// Required env:
//   FIREBASE_SERVICE_ACCOUNT  - JSON of the firebase-admin service account
//   GEMINI_API_KEY            - Google AI Studio key

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const SA     = process.env.FIREBASE_SERVICE_ACCOUNT;
const GEMINI = process.env.GEMINI_API_KEY;

if (!SA || !GEMINI) {
  console.log("Skipping moderation: FIREBASE_SERVICE_ACCOUNT or GEMINI_API_KEY not set.");
  process.exit(0);
}

let sa;
try { sa = JSON.parse(SA); }
catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message); process.exit(1); }

initializeApp({ credential: cert(sa) });
const db = getFirestore();

// Up to 50 pending comments per run. Skipping orderBy keeps this as a
// single-field query (no composite index needed). At current volume the
// limit comfortably exceeds any plausible backlog, so starvation is moot.
const snap = await db.collection("comments")
  .where("moderationStatus", "==", "pending")
  .limit(50)
  .get();

if (snap.empty) { console.log("Nothing pending."); process.exit(0); }
console.log(`Reviewing ${snap.size} pending comment(s).`);

// Rating-only comments (no text, default username) can be auto-approved.
const needReview = [];
const autoOk = [];
for (const d of snap.docs) {
  const x = d.data();
  const text = (x.text || "").trim();
  const username = (x.username || "Anonymous").trim();
  if (!text && username === "Anonymous") autoOk.push(d);
  else needReview.push({ doc: d, text, username });
}

// Apply auto-approvals via a batch.
const writer = db.bulkWriter();
for (const d of autoOk) {
  writer.update(d.ref, {
    moderationStatus: "ok",
    moderationReason: "auto: rating-only",
    moderatedAt: FieldValue.serverTimestamp(),
  });
}

// Classify the rest in a single Gemini call.
if (needReview.length) {
  const prompt = [
    "You are a content moderator for a Caltech Dining Services feedback site.",
    "Classify each numbered item as either \"ok\" or \"blocked\".",
    "Block when content contains:",
    "  - Sexual content",
    "  - Hate speech, slurs, or harassment of any individual or group",
    "  - Spam, scams, or obvious off-topic promotion",
    "  - Personal attacks on identifiable staff/students",
    "Honest negative feedback about food quality is NOT a reason to block.",
    "Mild profanity in food complaints is NOT a reason to block.",
    "",
    "Output a single JSON array of objects with this exact shape:",
    "  [{\"n\": <number>, \"status\": \"ok\"|\"blocked\", \"reason\": \"<short phrase>\"}]",
    "",
    "Items to classify (each shows the username then the comment text):",
    "",
    ...needReview.map(({ text, username }, i) =>
      `${i + 1}. username="${username.slice(0, 40)}" comment="${text.slice(0, 500)}"`
    ),
  ].join("\n");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2048,
        responseMimeType: "application/json",
      },
    }),
  });
  // Flush whatever auto-OKs queued so far before the model call — that way
  // if Gemini errors we still persist those decisions.
  await writer.flush();

  let results = [];
  if (!res.ok) {
    console.error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  } else {
    const json = await res.json();
    const raw = json.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    try { results = JSON.parse(raw); }
    catch (e) {
      console.error("Couldn't parse Gemini JSON:", raw.slice(0, 300));
    }
  }

  // Index results by `n` for fast lookup so we can detect missing entries.
  const byN = new Map();
  for (const r of results) byN.set(r.n | 0, r);

  let blocked = 0, ok = 0, skipped = 0;
  for (let i = 0; i < needReview.length; i++) {
    const { doc } = needReview[i];
    const r = byN.get(i + 1);
    if (!r) {
      // Gemini didn't classify this one — leave pending so the next run
      // retries it. Bumping a retry count would be nicer; defer.
      skipped++;
      continue;
    }
    const status = r.status === "blocked" ? "blocked" : "ok";
    if (status === "blocked") blocked++; else ok++;
    writer.update(doc.ref, {
      moderationStatus: status,
      moderationReason: (r.reason || "").toString().slice(0, 200),
      moderatedAt: FieldValue.serverTimestamp(),
    });
  }
  console.log(`Gemini reviewed ${needReview.length}: ${blocked} blocked, ${ok} ok, ${skipped} deferred to next run.`);
}

// close() can throw if any per-doc write failed; log and keep going so the
// already-completed writes are at least durable when the process exits.
try { await writer.close(); }
catch (e) { console.error("bulkWriter close failed:", e.message); }
console.log(`Done. ${autoOk.length} auto-ok, ${needReview.length} model-reviewed.`);
