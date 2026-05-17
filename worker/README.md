# Feature-request Cloudflare Worker

Receives `POST { text, username }` from the in-page "💡 Suggest a feature"
form, runs a Gemini triage pass, and creates a GitHub issue labelled
`feature-request` with the triage already in the body. Replaces the old
Firestore + 15-min cron + on-issue-opened triage flow.

Two ways to deploy. Pick **one** — the automated path is preferred.

---

## Automated (GitHub Actions, recommended)

After the one-time setup below, every push that changes `worker/` will
auto-deploy and (on the first deploy) auto-write the Worker URL into
`index.html`. You never touch Wrangler locally.

### One-time setup

1. **Cloudflare API token.** Visit
   <https://dash.cloudflare.com/profile/api-tokens> →
   **Create Token** → use the **"Edit Cloudflare Workers"** template →
   **Continue to summary** → **Create Token**. Copy it.

2. **GitHub PAT for the Worker.** Visit
   <https://github.com/settings/tokens?type=beta> → **Generate new token**
   (fine-grained) →
     - **Resource owner**: you
     - **Repository access**: Only `caltech_food`
     - **Repository permissions** → **Issues**: Read and write
   Generate, copy.

3. **Add three secrets to the repo.** Go to
   <https://github.com/eloisezeng/caltech_food/settings/secrets/actions> →
   **New repository secret** for each:
     - `CLOUDFLARE_API_TOKEN`  → the token from step 1
     - `WORKER_GITHUB_TOKEN`   → the PAT from step 2
     - `GEMINI_API_KEY`        → (already set; reuse the existing value)

4. **Trigger the deploy.** Either push any change inside `worker/`, or
   manually run the workflow:
   <https://github.com/eloisezeng/caltech_food/actions/workflows/deploy-worker.yml>
   → **Run workflow** → green button.

The workflow does three things in sequence:
- Publishes the Worker to your Cloudflare account.
- Pushes `WORKER_GITHUB_TOKEN` and `GEMINI_API_KEY` into the Worker as
  secrets (so the Worker can call GitHub / Gemini).
- Parses the deploy output for the `*.workers.dev` URL and, if
  `FEATURE_REQUEST_WORKER` in `index.html` is still empty, writes the URL
  in and pushes a follow-up commit.

After the first run, the "💡 Suggest a feature" button on the live site
starts working.

---

## Manual (Wrangler CLI, fallback)

If you'd rather deploy from your laptop:

```sh
cd worker
npx wrangler login                         # opens browser
npx wrangler secret put GITHUB_TOKEN       # paste a fine-grained PAT
npx wrangler secret put GEMINI_API_KEY     # paste the Gemini key
npx wrangler deploy
```

Wrangler prints a URL like
`https://caltech-food-feature-request.<your-name>.workers.dev`.
Paste it into `index.html` next to `const FEATURE_REQUEST_WORKER = ""`,
commit, push.

---

## Iterating

To change the prompt or any other Worker behaviour, edit
`feature-request.js` and either push (auto-deploy fires) or run
`npx wrangler deploy` locally. To watch live logs:

```sh
npx wrangler tail
```

## Trade-offs vs the old polling flow

- **Faster**: ~1 s end-to-end (Browser → Worker → GitHub) vs. up to
  15 minutes in the previous architecture.
- **Fewer moving parts**: this Worker + workflow replaces
  `scripts/sync-feature-requests.mjs`, `scripts/triage-issue.mjs`,
  `.github/workflows/sync-requests.yml`,
  `.github/workflows/triage-issues.yml`, and the `feature_requests`
  Firestore collection.
- **Cost**: free up to 100k Worker requests / day.
- **Spam mitigation**: the `ALLOWED_ORIGINS` var in `wrangler.toml`
  blocks browser-side cross-origin abuse. For real throughput protection
  add Cloudflare's Rate Limiting binding (~30 lines).
