// AI triage for a freshly-opened feature-request issue. Reads the issue body
// (and a snapshot of relevant repo files for context), asks Gemini to assess
// feasibility, scope, likely files to touch, and a one-paragraph
// implementation sketch, then posts the result as a single issue comment.
//
// Designed to run from .github/workflows/triage-issues.yml on issues:opened.
//
// Required env:
//   GEMINI_API_KEY      — Google AI Studio key
//   GITHUB_TOKEN        — auto-provided by Actions
//   GITHUB_REPOSITORY   — "owner/repo", auto-provided
//   ISSUE_NUMBER        — set by the workflow from github.event.issue.number
//   ISSUE_TITLE         — set by the workflow
//   ISSUE_BODY          — set by the workflow
//   ISSUE_LABELS        — comma-separated list, set by the workflow

import { readFileSync, existsSync } from "node:fs";

const KEY    = process.env.GEMINI_API_KEY;
const TOKEN  = process.env.GITHUB_TOKEN;
const REPO   = process.env.GITHUB_REPOSITORY;
const NUMBER = process.env.ISSUE_NUMBER;
const TITLE  = process.env.ISSUE_TITLE || "";
const BODY   = process.env.ISSUE_BODY  || "";
const LABELS = (process.env.ISSUE_LABELS || "").toLowerCase();

if (!KEY || !TOKEN || !REPO || !NUMBER) {
  console.log("Skipping triage: required env vars not set.");
  process.exit(0);
}
// Only triage feature-request issues — leave bug reports / discussions alone.
if (!LABELS.includes("feature-request")) {
  console.log("Skipping triage: issue has no 'feature-request' label.");
  process.exit(0);
}

// A compact snapshot of the codebase. We don't ship the whole 2500-line
// index.html — just the README + a list of source files + the comment
// describing the project's structure. Gemini can ask vaguely informed
// questions even with this minimal context.
function safeRead(path, maxBytes = 6000) {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  return raw.length > maxBytes ? raw.slice(0, maxBytes) + "\n…[truncated]" : raw;
}
const readme = safeRead("README.md", 4000);
const fileList = [
  "index.html", "image.png", "README.md", "TO-DO-*.md",
  "firestore.rules", "firestore.indexes.json", "storage.rules",
  "data/sheets.json", "data/images.json", "data/summary.json",
  "scripts/refresh.mjs", "scripts/summary.mjs",
  "scripts/moderate.mjs", "scripts/sync-feature-requests.mjs",
  "scripts/triage-issue.mjs",
  ".github/workflows/refresh.yml", ".github/workflows/moderate.yml",
  ".github/workflows/sync-requests.yml", ".github/workflows/pages.yml",
  ".github/workflows/triage-issues.yml",
].join("\n");

const prompt = [
  "You are an engineering triage agent for a small static-site project that",
  "displays Caltech Dining menus and lets students post comments and",
  "ratings. The site is one HTML file (~2500 lines, vanilla JS + Firestore).",
  "GitHub Actions handle a nightly menu refresh, comment moderation via",
  "Gemini, and a feature-request → GitHub Issues sync.",
  "",
  "A user just submitted a feature request via the in-page form. Read it",
  "below and produce a SHORT, helpful triage comment (Markdown) that the",
  "site maintainer can read in 30 seconds. Structure:",
  "",
  "**Summary** — one sentence restating what the user wants.",
  "**Feasibility** — \"trivial\" / \"medium\" / \"large\" / \"out of scope\",",
  "with one sentence explaining why.",
  "**Likely files to touch** — a short bullet list (file paths only).",
  "**Implementation sketch** — 2–4 bullets describing the approach. If",
  "  ambiguous, list the open questions.",
  "**Suggested label** — one of: easy / medium / hard / wontfix /",
  "  needs-clarification / duplicate.",
  "",
  "Rules:",
  "- Be specific about which file(s); do NOT invent files that aren't listed.",
  "- If the request is unclear, ask 1–2 clarifying questions instead of",
  "  guessing.",
  "- If it's a duplicate of something obviously already done, say so.",
  "- Don't include a greeting or sign-off; jump straight into the sections.",
  "",
  "=== Project README (truncated) ===",
  readme || "(no README found)",
  "",
  "=== Files in the repo ===",
  fileList,
  "",
  `=== Issue #${NUMBER}: ${TITLE} ===`,
  BODY || "(empty body)",
].join("\n");

const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}`;
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
  }),
});
if (!res.ok) {
  console.error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const json = await res.json();
let analysis = (json.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
if (!analysis) {
  console.error("Empty Gemini response — skipping comment.");
  process.exit(0);
}

const commentBody = [
  "🤖 **AI triage** (Gemini)",
  "",
  analysis,
  "",
  "---",
  "_This is an automated first-look. The maintainer will review and decide._",
].join("\n");

const ghRes = await fetch(`https://api.github.com/repos/${REPO}/issues/${NUMBER}/comments`, {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${TOKEN}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ body: commentBody }),
});
if (!ghRes.ok) {
  console.error(`GitHub HTTP ${ghRes.status}: ${(await ghRes.text()).slice(0, 400)}`);
  process.exit(1);
}
console.log(`Posted triage comment on #${NUMBER}.`);
