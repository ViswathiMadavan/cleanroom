# Cleanroom — Data Cleaning Pipeline

A guided, transparent data-cleaning and analysis tool that runs entirely in the
browser. Upload a CSV and move through five stages — **Collect → Clean → Analyze
→ Visualize → Report** — where every decision is explained, every destructive
action is previewable and reversible, and the data flows automatically from one
step to the next.

## What it does

- **Collect** — robust CSV upload (auto-detects delimiter, handles messy headers,
  blank lines, and ragged rows; rejects oversized/empty files gracefully).
- **Clean** — five ordered steps, each consuming the previous step's output:
  1. Remove duplicates & irrelevant columns
  2. Fix structural errors (format uniformity + manual synonym merges)
  3. Discard outliers (IQR) — *before* imputation, so statistics stay clean
  4. Fix missing values (drop below a threshold, impute above it)
  5. Validate (type, logic, and date-order checks) with one-click removal of
     failing records
- **Analyze** — patterns & trends (with distribution shape and concentration),
  Pearson correlation (strength-graded), and anomaly detection.
- **Visualize** — choose a chart type and columns; renders live.
- **Report** — rolls up the cleaning log, key insights, and a snapshot.

Every step that removes rows shows a preview of exactly what it removed and can be
undone (which also clears any downstream steps that were built on it).

## Scope & limits (by design)

Runs in-memory and single-threaded, so it stays smooth to ~10,000 rows (hard cap
15 MB). For larger data the natural next step would be a columnar engine
(DuckDB-WASM) or a backend — out of scope for this build.

## Run locally

```bash
npm install
npm run dev
```

Then open the printed local URL (usually http://localhost:5173).

## Build for production

```bash
npm run build      # outputs to dist/
npm run preview    # serve the production build locally
```

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, **Add New → Project**, import the repo.
3. Vercel auto-detects Vite — no configuration needed:
   - Framework Preset: **Vite**
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. Deploy. You'll get a public URL.

Alternatively, with the Vercel CLI: `npm i -g vercel` then `vercel`.

## Tech

React 18, Vite 5, Recharts, PapaParse, Lodash. No backend, no data leaves the
browser.
