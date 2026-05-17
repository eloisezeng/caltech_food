// Cloudflare Worker: turns a feature-request form submission into a GitHub
// issue with AI-triage inline, in one round-trip from the browser. Replaces
// the old Firestore-write → 15-minute cron → triage-on-issue-opened chain.
//
// Required Wrangler secrets (set with `wrangler secret put <NAME>`):
//   GITHUB_TOKEN     — Personal Access Token with `repo` (or fine-grained
//                      issues:write) scope on the destination repo
//   GEMINI_API_KEY   — Google AI Studio key. Optional — if absent, the
//                      Worker still files the issue, just without triage.
//
// Required vars in wrangler.toml [vars]:
//   GITHUB_REPO      — e.g. "eloisezeng/caltech_food"
//   ALLOWED_ORIGINS  — comma-separated list of HTTP Origins allowed to POST,
//                      e.g. "https://eloisezeng.github.io,http://localhost:8000"

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = corsHeadersFor(origin, env);

    // Preflight
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST")    return json(405, { error: "POST only" }, cors);

    // Origin guard. Trivial to bypass with curl, but blocks the typical
    // accidental cross-site embed and reduces spam from page scrapers.
    if (!cors["Access-Control-Allow-Origin"]) {
      return json(403, { error: "Origin not allowed" }, cors);
    }

    let body;
    try { body = await req.json(); }
    catch { return json(400, { error: "Body must be JSON" }, cors); }

    const text     = String(body.text     || "").trim();
    const username = String(body.username || "Anonymous").trim().slice(0, 40) || "Anonymous";

    if (!text)             return json(400, { error: "text is required" }, cors);
    if (text.length > 5000) return json(400, { error: "text too long (max 5000)" }, cors);

    if (!env.GITHUB_REPO || !env.GITHUB_TOKEN) {
      return json(500, { error: "Worker is misconfigured: GITHUB_REPO / GITHUB_TOKEN missing" }, cors);
    }

    // Run AI triage best-effort. If Gemini fails, file the issue without it.
    let triage = "";
    if (env.GEMINI_API_KEY) {
      try { triage = await runTriage({ text, username, repo: env.GITHUB_REPO }, env.GEMINI_API_KEY); }
      catch (e) { console.warn("Gemini triage failed:", e.message); }
    }

    let issue;
    try { issue = await createIssue(env, { text, username, triage }); }
    catch (e) { return json(502, { error: "GitHub: " + e.message }, cors); }

    return json(200, {
      ok: true,
      number: issue.number,
      url: issue.html_url,
    }, cors);
  },
};

// ---------- helpers ----------

function corsHeadersFor(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed.length === 0 || allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
    headers["Vary"] = "Origin";
  }
  return headers;
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

async function runTriage({ text, username, repo }, key) {
  const prompt = [
    "You are an engineering triage agent for a small static-site project that",
    "displays Caltech Dining menus and lets students post comments / ratings.",
    "The site is one HTML file (~2500 lines, vanilla JS + Firestore) plus a",
    "handful of Node scripts and GitHub Actions.",
    "",
    "A user just submitted a feature request via the in-page form. Produce a",
    "SHORT (≤ 150 words) triage block in Markdown that the maintainer can",
    "read in 30 seconds. Use these labels verbatim:",
    "",
    "**Summary** — one sentence restating what the user wants.",
    "**Feasibility** — trivial / medium / large / out of scope, with one sentence why.",
    "**Likely files to touch** — short bullet list of paths in the repo.",
    "**Implementation sketch** — 2–4 bullets describing the approach. If",
    "  ambiguous, list 1–2 clarifying questions instead.",
    "**Suggested label** — one of: easy / medium / hard / wontfix /",
    "  needs-clarification / duplicate.",
    "",
    "Do NOT include a greeting or sign-off.",
    "",
    `Submitter: ${username}`,
    `Repo: ${repo}`,
    "",
    "=== Request ===",
    text,
  ].join("\n");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function createIssue(env, { text, username, triage }) {
  const oneLine = text.replace(/\s+/g, " ");
  const title = "Feature request: " + (oneLine.length > 60 ? oneLine.slice(0, 60) + "…" : oneLine);
  const body = [
    "> " + text.split("\n").join("\n> "),
    "",
    "---",
    `**Submitted via the in-page "💡 Suggest a feature" form by \`${username}\`.**`,
    triage ? "\n## 🤖 AI triage (Gemini)\n\n" + triage : "",
    "",
    "**Approve** → close as completed (and ping Claude Code to implement).  ",
    "**Decline** → close as not planned.",
  ].join("\n");

  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "caltech-food-feature-request-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body, labels: ["feature-request"] }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
