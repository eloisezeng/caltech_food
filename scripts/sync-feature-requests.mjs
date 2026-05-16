// Sync pending feature_requests from Firestore into GitHub Issues on the
// current repo. Run by .github/workflows/sync-requests.yml every 15 minutes
// and on demand. Each Firestore doc is opened as one issue; the doc is then
// marked status="issued" with the issue number, so subsequent runs skip it.
//
// Required env:
//   FIREBASE_SERVICE_ACCOUNT  - JSON of the same service account used by summary.mjs
//   GITHUB_TOKEN              - injected automatically by GitHub Actions
//   GITHUB_REPOSITORY         - "owner/repo", injected automatically

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const SA       = process.env.FIREBASE_SERVICE_ACCOUNT;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = process.env.GITHUB_REPOSITORY;

if (!SA || !GH_TOKEN || !GH_REPO) {
  console.log("Skipping sync: required env vars not set.");
  process.exit(0);
}

let sa;
try { sa = JSON.parse(SA); }
catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message); process.exit(1); }

initializeApp({ credential: cert(sa) });
const db = getFirestore();

const snap = await db.collection("feature_requests")
  .where("status", "==", "pending")
  .orderBy("createdAt", "asc")
  .limit(50)
  .get();

if (snap.empty) { console.log("No pending feature requests."); process.exit(0); }
console.log(`Found ${snap.size} pending request(s).`);

const headers = {
  "Authorization": `Bearer ${GH_TOKEN}`,
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

let created = 0, failed = 0;
for (const doc of snap.docs) {
  const data = doc.data();
  const text = (data.text || "").trim();
  if (!text) {
    await doc.ref.update({ status: "skipped", reason: "empty text" });
    continue;
  }
  const oneLine = text.replace(/\s+/g, " ");
  const title = "Feature request: " + (oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine);
  const submittedAt = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : "unknown";
  const body = [
    "> " + text.split("\n").join("\n> "),
    "",
    "---",
    "**Submitted via the in-page \"💡 Suggest a feature\" form.**",
    "",
    `- Submitted at: \`${submittedAt}\``,
    `- Firestore doc: \`feature_requests/${doc.id}\``,
    "",
    "**Approve** → close this issue as completed (and ping Claude Code to implement).  ",
    "**Decline** → close as not planned.",
  ].join("\n");

  const res = await fetch(`https://api.github.com/repos/${GH_REPO}/issues`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title, body, labels: ["feature-request"] }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    console.error(`✗ ${doc.id}: HTTP ${res.status} ${errBody.slice(0, 300)}`);
    failed++;
    continue;
  }
  const issue = await res.json();
  await doc.ref.update({
    status: "issued",
    githubIssue: issue.number,
    githubIssueUrl: issue.html_url,
    issuedAt: FieldValue.serverTimestamp(),
  });
  console.log(`✓ Issue #${issue.number} ← ${doc.id}`);
  created++;
}

console.log(`Done. ${created} created, ${failed} failed.`);
process.exit(failed ? 1 : 0);
