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
2. In the project, click **Build → Firestore Database → Create database**.
   Pick "production mode" and your nearest region.
3. **Project settings → General → Your apps → Web** (the `</>` icon). Register
   the app. Copy the `firebaseConfig` object shown.
4. Open `index.html` and paste those six values into `FIREBASE_CONFIG`,
   replacing the `"REPLACE_ME"` placeholders.
5. Deploy the rules in `firestore.rules`:
   ```sh
   npm i -g firebase-tools
   firebase login
   firebase use <your-project-id>
   firebase deploy --only firestore:rules
   ```
   (Or paste the rules into the Firestore Rules tab in the console.)

That's all the browser needs — comments and feature requests now work. The
"weekly summary" button still says "no summary yet" until step 2.

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

### Privacy / safety notes

- Anyone can post anonymously. The Firestore Rules in `firestore.rules` cap
  field sizes and forbid edits/deletes, so the worst case is unwanted text
  in the database — you can delete documents from the Firebase console.
- If you ever want to take comments offline temporarily, set
  `FIREBASE_CONFIG.apiKey` back to `"REPLACE_ME"` and redeploy. The buttons
  vanish; existing comments stay in Firestore.
- For "AI implements a feature" — the chat box is **submit-only**. Requests
  go to the `feature_requests` Firestore collection and surface in the
  weekly summary, so you can review and decide which to implement.

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
│   ├── refresh.mjs             # Node script the Action runs each night
│   └── summary.mjs             # Generates summary from Firestore + Gemini
├── .github/workflows/
│   ├── refresh.yml             # nightly cron + manual trigger
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
