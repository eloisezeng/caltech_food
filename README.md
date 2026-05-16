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

## File layout

```
.
├── index.html                  # the page (HTML + CSS + JS, one file)
├── data/
│   ├── sheets.json             # spreadsheet IDs + per-day gids (Action-managed)
│   └── images.json             # cached Google-quality image URLs (Action-managed)
├── scripts/
│   └── refresh.mjs             # Node script the Action runs each night
├── .github/workflows/
│   ├── refresh.yml             # nightly cron + manual trigger
│   └── pages.yml               # deploy index.html + data to GitHub Pages
├── README.md
└── TO-DO.md
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
