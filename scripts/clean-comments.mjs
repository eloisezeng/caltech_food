// Maintenance utility: bulk-delete comments from the Firestore `comments`
// collection. Triggered by .github/workflows/clean-comments.yml as a
// workflow_dispatch with these inputs:
//
//   CLEAN_USERNAMES   comma-separated usernames whose comments should be
//                     deleted (e.g. "ds,deploy-smoketest"). Empty-string
//                     entries match comments where the username field is
//                     "" or missing.
//   CLEAN_ITEMS       comma-separated `item` values to delete (e.g.
//                     "__OVERALL__HOUSE__,Chicken Tikka Masala").
//   CLEAN_ALL         "true" → wipe the whole collection. Use with care.
//
// At least one of the three must be provided; otherwise the script no-ops.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const SA = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!SA) { console.error("FIREBASE_SERVICE_ACCOUNT not set"); process.exit(1); }

let sa;
try { sa = JSON.parse(SA); }
catch (e) { console.error("FIREBASE_SERVICE_ACCOUNT is not valid JSON:", e.message); process.exit(1); }

initializeApp({ credential: cert(sa) });
const db = getFirestore();

const usernamesIn = (process.env.CLEAN_USERNAMES || "").split(",").map(s => s.trim());
const cleanUsernames = new Set(usernamesIn);
const cleanItems = new Set((process.env.CLEAN_ITEMS || "").split(",").map(s => s.trim()).filter(Boolean));
const wipeAll = (process.env.CLEAN_ALL || "").toLowerCase() === "true";

if (!wipeAll && cleanUsernames.size === 0 && cleanItems.size === 0) {
  console.log("No filter provided. Set CLEAN_USERNAMES, CLEAN_ITEMS, or CLEAN_ALL=true.");
  process.exit(0);
}

const snap = await db.collection("comments").get();
console.log(`Scanning ${snap.size} comment(s)…`);

const toDelete = [];
for (const d of snap.docs) {
  const data = d.data();
  const u = (data.username ?? "").trim();
  if (wipeAll) { toDelete.push(d); continue; }
  if (cleanUsernames.size && cleanUsernames.has(u)) { toDelete.push(d); continue; }
  if (cleanItems.size && cleanItems.has(data.item)) { toDelete.push(d); continue; }
}

if (!toDelete.length) {
  console.log("Nothing matched. Exiting.");
  process.exit(0);
}

console.log(`Deleting ${toDelete.length} comment(s):`);
for (const d of toDelete) {
  const data = d.data();
  console.log(`  - [${d.id.slice(0, 10)}] item="${(data.item || "").slice(0, 40)}" user="${data.username || ""}" text="${(data.text || "").slice(0, 40)}"`);
}

const writer = db.bulkWriter();
for (const d of toDelete) writer.delete(d.ref);
try { await writer.close(); console.log("Done."); }
catch (e) { console.error("bulkWriter close failed:", e.message); process.exit(1); }
