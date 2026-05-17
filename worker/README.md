# Feature-request Cloudflare Worker

Receives `POST { text, username }` from the in-page "💡 Suggest a feature"
form, optionally runs a Gemini triage pass, and creates a GitHub issue
labelled `feature-request` with the triage already in the body. Replaces
the older Firestore + 15-min cron + on-issue-opened triage flow.

## One-time setup

```sh
# 1. Sign up at https://workers.cloudflare.com (free tier is enough).

# 2. From this directory:
cd worker
npx wrangler login                         # opens browser, logs into Cloudflare

# 3. Create a GitHub Personal Access Token
#    → https://github.com/settings/tokens?type=beta
#    → "Fine-grained" → Resource owner: you, Repo: caltech_food only,
#      Permissions → Repository → Issues: Read and write
#    Copy the token (starts with `github_pat_...`).

# 4. Store the secrets in the Worker (you only do this once):
npx wrangler secret put GITHUB_TOKEN       # paste the token when prompted
npx wrangler secret put GEMINI_API_KEY     # paste the same Gemini key you use elsewhere

# 5. Deploy.
npx wrangler deploy
```

Wrangler prints a URL like
`https://caltech-food-feature-request.<your-name>.workers.dev` —
that's your Worker endpoint.

## Wire the URL into the site

Edit `../index.html` and set:

```js
const FEATURE_REQUEST_WORKER = "https://caltech-food-feature-request.<your-name>.workers.dev";
```

Commit + push. The "💡 Suggest a feature" button starts using the Worker
on the next Pages deploy.

## Iterating

To change the Gemini prompt, edit `feature-request.js` and re-deploy:

```sh
npx wrangler deploy
```

Logs:

```sh
npx wrangler tail
```

## Trade-offs vs the old flow

- **Faster**: ~1 s end-to-end (Browser → Worker → GitHub) vs. up to
  15 minutes (Browser → Firestore → cron Action → GitHub).
- **Fewer moving parts**: this Worker replaces
  `scripts/sync-feature-requests.mjs`, `scripts/triage-issue.mjs`,
  `.github/workflows/sync-requests.yml`,
  `.github/workflows/triage-issues.yml`, and the `feature_requests`
  Firestore collection.
- **Cost**: free up to 100k Worker requests / day.
- **Spam mitigation**: the `ALLOWED_ORIGINS` var blocks browser-side
  cross-origin abuse; for serious throughput protection you'd add a
  rate-limiter (Cloudflare's Rate Limiting binding, ~30 lines).
