# Caltech House Dinner and Browne Menus

A single-page website that displays the **House dinner menu** and the **Browne menu**
for a given day of the week. Defaults to the current day, lets you toggle between
days with a button row, and switch between this week and next week.

## Sources

- House dinner menus: <https://caltechdining.my.canva.site/meal-plan-menus>
- Browne menus: <https://diningcaltech.info/browne-dining-specials>

Both pages embed published Google Sheets. The site fetches those sheets' CSV
exports live in the browser (`docs.google.com/.../pub?output=csv&gid=…`), which
serve `Access-Control-Allow-Origin: *` so no backend is needed at runtime.

A small **scheduled GitHub Action** keeps the spreadsheet IDs and per-day `gid`s
fresh by scraping the Canva landing pages once a day, and pre-fetches a
Google-quality image for every menu item via DuckDuckGo's image API.

## Run it locally

`index.html` is a fully static page. Open it directly in a browser, or serve
the folder:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## Hosting on GitHub Pages

1. Push the repo to GitHub.
2. Settings → Pages → Source: **GitHub Actions**.
3. The `pages.yml` workflow will deploy on every push to `main`.
4. The `refresh.yml` workflow will run nightly (14:00 UTC ≈ 6 AM Pacific) to
   refresh sheet IDs and the image cache. It commits the updated
   `data/sheets.json` and `data/images.json`, which triggers the Pages deploy.
5. You can also trigger either workflow manually from the Actions tab.

To run the refresh job locally:

```sh
node scripts/refresh.mjs
```

## Features

- **Day buttons** (Sun-Sat) with the calendar date for the selected week; today
  is outlined.
- **Week toggle** — flip between This Week and Next Week.
- **Two side-by-side panels** — House Dinner | Browne — each grouped into
  categories.
- **Categories**: Entrees, Vegetarian, Vegan, Pasta Bar, Soups, Sides, Bread,
  Dessert, Other.
- **Image button** (🖼) next to every food item — toggles an inline thumbnail.
  Image sources in order of preference:
  1. Pre-fetched DuckDuckGo image cache (`data/images.json`, refreshed daily)
  2. Wikipedia article summary
  3. Wikimedia Commons file search (image MIME types only)
  4. TheMealDB
  5. Shorter Wikipedia query
  6. LoremFlickr (Flickr keyword search) — guaranteed to return an image
- **"Menu data refreshed today/yesterday/N days ago"** indicator below the day
  buttons (driven by the timestamp in `data/sheets.json`).

## What shows per day

- **House dinner:** Monday–Friday only.
- **Browne (Mon–Fri):** Comfort Equation (lunch), Plant Based, Cooking 101 Dinner.
- **Browne (Sat/Sun):** 101 Brunch, Comfort Brunch, Brunch Specials.
- **Next-week Browne** is only the Comfort Equation Mon-Fri (Caltech doesn't
  publish PB / 101 / weekend menus a week in advance).

## Comments and feedback (Firebase + Gemini)

Each menu item has a 💬 button that lets students post a star rating + comment
to a public Firestore collection. There's also a "Suggest a feature" button in
the header, and a "Weekly feedback summary" button that displays an
AI-generated digest aimed at Caltech Dining.

These features are **disabled by default** — `FIREBASE_CONFIG` in `index.html`
starts with placeholder values, and the comment buttons are hidden until
the placeholders are replaced. To turn them on:

### 1. Set up Firebase

1. Go to <https://console.firebase.google.com>, create a project (any name).
2. **Build → Firestore Database → Create database.** Pick "production mode"
   and your nearest region.
3. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable.** (Comments need to identify the author for edit/delete to work.)
4. **Project settings → General → Your apps → Web** (the `</>` icon).
   Register the app. Copy the `firebaseConfig` object shown.
5. Open `index.html` and paste those six values into `FIREBASE_CONFIG`,
   replacing the `"REPLACE_ME"` placeholders.
6. Deploy rules — paste `firestore.rules` into **Firestore → Rules** in
   the Firebase console and click **Publish**.
7. Firestore needs one composite index for the per-item comment query.
   Either visit the auto-create link the page prints in the console the
   first time you click 💬 (Firestore tells you exactly what to create),
   or paste `firestore.indexes.json` via `firebase deploy --only firestore:indexes`.

That's all the browser needs — commenting, editing/deleting your own
comments, and feature requests all work. The "weekly summary" button
still says "no summary yet" until step 2.

> **Image attachments are disabled by default.** Firebase Storage requires
> upgrading to the Blaze (pay-as-you-go) plan. If you upgrade later, set
> `IMAGES_ENABLED = true` in `index.html`, enable Storage in the Firebase
> console, and paste `storage.rules` into **Storage → Rules**.

### 1b. (Optional) Enable on-demand summary regeneration

By default the summary refreshes once a day via the GitHub Action. To let
visitors click a "Regenerate now" button in the summary modal:

1. Reuse your existing `GEMINI_API_KEY` (or create a separate one — same
   place, <https://aistudio.google.com/apikey>).
2. **Restrict the key** in Google Cloud Console first, otherwise anyone on
   the page can spend your quota:
   - <https://console.cloud.google.com/apis/credentials?project=caltech-food>
   - Application restrictions → **Websites** →
     add `https://eloisezeng.github.io/*` (and `http://localhost/*` for testing).
   - API restrictions → **Restrict key** → only **Generative Language API**.
3. Paste the key into `GEMINI_BROWSER_KEY` in `index.html`.

If left blank, the button stays in the modal but says "not configured" when
clicked — the page still shows the latest Action-generated summary.

### 2. Set up the daily summary

1. In Firebase console: **Project settings → Service accounts → Generate new
   private key**. Save the downloaded JSON.
2. In the GitHub repo: **Settings → Secrets and variables → Actions → New
   repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: the full JSON file contents (paste it all)
3. Get a Gemini API key at <https://aistudio.google.com/apikey>. Add another
   secret:
   - Name: `GEMINI_API_KEY`
   - Value: your key
4. From the **Actions** tab, run the "Refresh menu data" workflow once. It
   will write `data/summary.json` and commit it back to the repo.

After that, every nightly run will refresh the summary.

### Moderation

Two layers keep the worst content off the site:

1. **Client wordlist** in `index.html` rejects obvious profanity at submit
   time. Bypassable via DevTools, but catches lazy attempts.
2. **`scripts/moderate.mjs`** runs every 15 minutes (workflow
   `.github/workflows/moderate.yml`). For each comment whose
   `moderationStatus == "pending"`, it asks Gemini to classify as `"ok"`
   or `"blocked"` (with a short reason). The frontend hides anything
   marked `"blocked"`. Edits reset a comment to `"pending"` so it's
   re-classified.

To unblock a comment manually, find the doc in **Firestore → comments**
in the Firebase console and set `moderationStatus = "ok"`. Conversely,
set `moderationStatus = "blocked"` to hide a comment the model missed.
The `moderationReason` field tells you why something was flagged.

### Privacy / safety notes

- Anyone can post anonymously. The Firestore Rules in `firestore.rules` cap
  field sizes and forbid edits/deletes, so the worst case is unwanted text
  in the database — you can delete documents from the Firebase console.
- If you ever want to take comments offline temporarily, set
  `FIREBASE_CONFIG.apiKey` back to `"REPLACE_ME"` and redeploy. The buttons
  vanish; existing comments stay in Firestore.
- For "AI implements a feature" — the chat box is **submit-only**. Requests
  go to the `feature_requests` Firestore collection, are mirrored to GitHub
  Issues by the `sync-requests.yml` workflow (every 15 min), and also
  surface in the weekly summary. To approve a request, close the GitHub
  issue as completed; to decline, close as not planned.

## File layout

```
.
├── index.html                  # the page (HTML + CSS + JS, one file)
├── image.png                   # icon used by the per-item image button
├── firestore.rules             # public-write rules for comments/feature_requests
├── data/
│   ├── sheets.json             # spreadsheet IDs + per-day gids (Action-managed)
│   ├── images.json             # cached Google-quality image URLs (Action-managed)
│   └── summary.json            # AI-generated weekly feedback summary (Action-managed)
├── scripts/
│   ├── refresh.mjs                  # nightly menu data + image cache refresh
│   ├── summary.mjs                  # weekly feedback summary via Gemini
│   └── sync-feature-requests.mjs    # turns pending Firestore requests into issues
├── .github/workflows/
│   ├── refresh.yml             # nightly cron + manual trigger
│   ├── sync-requests.yml       # every 15 min, mirror requests → GitHub issues
│   └── pages.yml               # deploy index.html + data to GitHub Pages
├── README.md
└── TO-DO-*.md                  # rolling list of asks
```

## How it works

### Reading menus
1. On load, the page fetches `data/sheets.json` for current IDs and gids
   (with hardcoded fallback defaults baked into `index.html`).
2. When a day is clicked, it fetches each relevant tab's CSV from Google Docs.
3. It extracts `(heading, item, allergens)` triples from each non-empty column.
4. Cleans up separator rows, standalone "Vegan" flag cells, redundant section
   titles like "Comfort Equation Center Line", and forwards real headings past
   separator lines.
5. Categorizes each entry by regex on its heading + item text.
6. Renders each non-empty category as a labelled section.

### Images
- The Action queries DuckDuckGo image search (which fronts Bing) for every
  menu item once a day, server-side, and writes the URLs to `data/images.json`.
- The page reads this cache first; cache misses cascade through Wikipedia,
  Commons, TheMealDB, and LoremFlickr.
- The caption always includes a "search Google Images" link so users can
  browse alternatives.

## Maintenance notes

- If Caltech Dining changes the Canva site layout or moves to different
  spreadsheet hosting, `scripts/refresh.mjs` will need updates (regexes that
  extract sheet IDs and tab gids).
- The frontend's heading/item/group regexes (`extractEntries`, `cleanEntries`,
  `GROUPS` in `index.html`) were tuned against the sheets as of May 2026. New
  section types may need new patterns.
- All image lookups (Wikipedia, Commons, TheMealDB, DuckDuckGo, LoremFlickr)
  are free and require no API keys.
