// Auto-refresh script: scrapes the Canva landing pages for the current
// week and next week, derives spreadsheet IDs and per-day gids, and
// pre-fetches a high-quality image for every unique menu item via
// DuckDuckGo's image search (server-side, no CORS).
//
// Writes:
//   data/sheets.json  — { lastUpdated, sources: { house|houseNext|browne|browneNext: { sheetId, gids } } }
//   data/images.json  — { lastUpdated, cache: { "Food name": "https://thumbnail-url" } }
//
// Designed to be run by a GitHub Action on a cron schedule. Failures of one
// data source do not abort the others — partial output is better than none.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const SOURCES = [
  { key: "house",      url: "https://caltechdining.my.canva.site/mealplanmenu" },
  { key: "houseNext",  url: "https://caltechdining.my.canva.site/next-week-meal-plan" },
  { key: "browne",     url: "https://caltechdining.my.canva.site/browne-comfort-equation" },
  { key: "browneNext", url: "https://caltechdining.my.canva.site/comfort-equation-next-week" },
];

const UA = "Mozilla/5.0 (compatible; CaltechMenuBot/1.0)";

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...(opts.headers || {}) }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function findSheetId(canvaUrl) {
  const html = await fetchText(canvaUrl);
  const m = html.match(/docs\.google\.com\/spreadsheets\/d\/e\/(2PACX-[0-9A-Za-z_-]+)/);
  return m ? m[1] : null;
}

async function findGids(sheetId) {
  const html = await fetchText(`https://docs.google.com/spreadsheets/d/e/${sheetId}/pubhtml`);
  const re = /name:\s*"([^"]+)",\s*pageUrl:\s*"[^"]*?gid=(\d+)"/g;
  const map = {};
  let m;
  while ((m = re.exec(html))) map[m[1]] = parseInt(m[2], 10);
  return map;
}

async function refreshSheets() {
  const out = { lastUpdated: new Date().toISOString(), sources: {} };
  for (const s of SOURCES) {
    try {
      const sheetId = await findSheetId(s.url);
      if (!sheetId) throw new Error("no sheet ID in page");
      const gids = await findGids(sheetId);
      out.sources[s.key] = { sheetId, gids };
      console.log(`  [sheets] ${s.key.padEnd(11)} → ${sheetId.slice(0, 20)}… (${Object.keys(gids).length} tabs)`);
    } catch (e) {
      console.warn(`  [sheets] ${s.key.padEnd(11)} ✗ ${e.message}`);
    }
  }
  return out;
}

// ---- CSV parsing (mirrors index.html so we extract the same items) ----

function parseCsv(text) {
  const rows = []; let row = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ""; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== '\r') f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const DAY_RE = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i;
const NOT_FOOD_RE = /^(Day|Menu Items|Allergens|Last Updated|PDF Version|Template|Today|Tomorrow|Date|Type|Dietary|Comfort Equation Center|Plant Based Special|Comfort Special|101 Special|Brunch Special)/i;
// Bare allergen-token vocabulary that shows up as data in the "Allergens"
// column (often without the "Allergens:" prefix on the Cooking 101 sheet).
const ALLERGEN_WORD = /^(gluten|dairy|soy|eggs?|sesame|seafood|peanuts?|tree.?nuts?|nuts?|fish|shellfish|wheat|milk|sulphites?|sulfites?|mustard|celery|lupin|molluscs?|none|free)$/i;

function looksLikeFood(t) {
  if (!t || t.length < 4 || t.length > 90) return false;
  if (/^Allergens:/i.test(t)) return false;
  if (/^[-—–_=*\s]+$/.test(t)) return false;
  if (/^\d+\/\d+\/\d+/.test(t)) return false;
  if (DAY_RE.test(t)) return false;
  if (NOT_FOOD_RE.test(t)) return false;
  // Single-word labels like "Vegan", "Sides", "Entrees" are not dishes
  if (/^(Vegan|Vegetarian|Sides?|Entrees?|Soups?|Breads?|Desserts?|Pasta|Specials?|Bar|Brunch|Dinner|Lunch|101|Wok|Latino|Center\s+Line)$/i.test(t)) return false;
  // Strings composed only of allergen words ("Gluten Soy", "Dairy, Gluten",
  // "No Allergens", "Gluten Free", etc.)
  if (/^No\s+Allergens?$/i.test(t)) return false;
  const words = t.split(/[\s,&]+/).filter(Boolean);
  if (words.length && words.every(w => ALLERGEN_WORD.test(w))) return false;
  return true;
}

async function fetchItemsFromSheet(sheetId, gid) {
  try {
    const text = await fetchText(`https://docs.google.com/spreadsheets/d/e/${sheetId}/pub?output=csv&gid=${gid}`);
    const rows = parseCsv(text);
    const items = new Set();
    for (const row of rows) {
      for (const cell of row) {
        const t = (cell || "").trim().replace(/\s*\|\s*Price.*$/i, "").trim();
        if (looksLikeFood(t)) items.add(t);
      }
    }
    return [...items];
  } catch (e) {
    return [];
  }
}

// ---- DuckDuckGo image search (server-side; no CORS, no API key) ----

async function ddgImage(query) {
  // Step 1: get the vqd token from the search HTML.
  const tokenHtml = await fetchText(
    `https://duckduckgo.com/?q=${encodeURIComponent(query + " food")}&iax=images&ia=images`,
    { headers: { "Accept": "text/html" } }
  );
  const vqdMatch = tokenHtml.match(/vqd=["']?([0-9a-zA-Z-]+)["']?/);
  if (!vqdMatch) throw new Error("no vqd");
  const vqd = vqdMatch[1];
  // Step 2: ask the JSON endpoint for image results.
  const json = JSON.parse(await fetchText(
    `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query + " food")}&vqd=${vqd}`,
    { headers: { "Referer": "https://duckduckgo.com/", "Accept": "application/json" } }
  ));
  const first = (json.results || [])[0];
  if (!first) return null;
  // Prefer DuckDuckGo's CDN-cached thumbnail over the original (which may be
  // hot-link blocked or huge).
  return first.thumbnail || first.image;
}

async function refreshImages(sheets, existingCache) {
  const all = new Set();
  for (const src of Object.values(sheets.sources || {})) {
    for (const gid of Object.values(src.gids || {})) {
      const items = await fetchItemsFromSheet(src.sheetId, gid);
      items.forEach(i => all.add(i));
    }
  }
  console.log(`  [images] ${all.size} unique items across all sheets`);

  const cache = { ...existingCache };
  let hits = 0, misses = 0, skipped = 0;
  for (const item of all) {
    if (cache[item]) { skipped++; continue; }
    try {
      const url = await ddgImage(item);
      if (url) { cache[item] = url; hits++; }
      else { misses++; }
    } catch (e) {
      misses++;
    }
    // Polite delay; DDG rate-limits aggressively otherwise.
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`  [images] ${hits} new hits, ${misses} misses, ${skipped} already cached`);
  // Drop entries for items no longer on any menu so the cache doesn't grow forever.
  for (const k of Object.keys(cache)) if (!all.has(k)) delete cache[k];
  return cache;
}

// ---- main ----

async function main() {
  console.log("Refreshing sheet IDs from Canva...");
  const sheets = await refreshSheets();
  mkdirSync("data", { recursive: true });
  writeFileSync("data/sheets.json", JSON.stringify(sheets, null, 2) + "\n");
  console.log("Wrote data/sheets.json\n");

  let existing = {};
  if (existsSync("data/images.json")) {
    try { existing = JSON.parse(readFileSync("data/images.json", "utf8")).cache || {}; }
    catch { existing = {}; }
  }
  console.log("Refreshing image cache from DuckDuckGo...");
  const cache = await refreshImages(sheets, existing);
  writeFileSync("data/images.json", JSON.stringify({ lastUpdated: new Date().toISOString(), cache }, null, 2) + "\n");
  console.log(`Wrote data/images.json (${Object.keys(cache).length} entries)`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
