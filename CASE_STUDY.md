# Cleanroom — A Case Study

Most "data cleaning" tools either hide everything behind a magic button or hand you a Python notebook and wish you luck. Cleanroom is for the person in between: an analyst, ops lead, or founder with a messy CSV of signups or orders who needs it trustworthy but doesn't want to write pandas to get there. It runs entirely in the browser — you drop in a file, watch each cleaning decision happen in front of you, and download the result. Nothing leaves the page. The whole point is that you can *see* and *undo* every transformation, because a cleaning tool you can't audit is one you have to take on faith.

## The five-stage pipeline

The app is organized as Collect → Clean → Analyze → Visualize → Report. Collect gets data in safely — delimiter detection, ragged rows, messy headers — and sets the schema everything downstream depends on. Clean is the heart: five ordered sub-steps (deduplicate, fix structural errors, remove outliers, handle missing values, validate). Analyze surfaces patterns, correlations, and anomalies so you understand the data you just cleaned. Visualize turns those into charts. Report bundles a snapshot of every decision into something you can hand to someone else. Each stage answers a different question: *can I trust the input, the rows, the meaning, and finally the story?*

## Why outliers run before imputation

This is the ordering decision I'm most deliberate about. Missing-value imputation fills gaps with a column's mean or median. But if a revenue column has a fat-fingered `9999999`, the mean is already poisoned — and every imputed cell inherits that poison. So outliers (step 3) run *before* missing values (step 4): strip the extremes first using IQR bounds, then compute the statistics you'll impute with against a population that actually represents the data. Reverse the order and you quietly contaminate every gap you fill.

## Why synonym matching can't be automatic

Early on I wanted the tool to auto-merge inconsistent categories — collapse `US` and `USA` for you. The problem is unsolvable in the general case, and here's the proof that stopped me: `US`→`USA` is a one-character edit, and so is `US`→`UK`. Any string-distance algorithm aggressive enough to merge the first will also merge the second — and silently turning the United Kingdom into the United States is exactly the kind of error a cleaning tool must never make. There's no threshold that catches one and spares the other, because they're genuinely equidistant. So Cleanroom does the part that *is* safe automatically — normalizing case, punctuation, and whitespace, so `Country` and `country` or `UK` and `U.K` collapse without risk — and routes real synonyms to a manual-merge UI where a human says "yes, US means USA." The machine handles formatting; the person handles meaning.

## Trust and reversibility

Every design choice here serves auditability. No row ever disappears without a preview — before a step removes anything, you see exactly which rows and why. Every step is undoable. And because the steps are ordered and dependent, re-running an earlier one cascade-invalidates everything downstream: change your outlier threshold and the imputation that was computed on the old data is thrown out rather than left stale. Cleaning is a chain of decisions, and the tool refuses to let a later decision rest on an input you've since changed.

## Scope and what scale would change

This is built for roughly 10k rows — everything runs in-memory, single-threaded, in one tab. That's a constraint I chose on purpose: it keeps the app dependency-light, private, and instant for the files people actually paste in. At genuinely large scale I'd change three things: move the data engine to DuckDB-WASM so joins and aggregations don't live in JavaScript arrays, code-split recharts out of the initial bundle, and push the heavy cleaning passes into web workers so the UI never blocks. None of that is needed at 10k rows, and adding it now would be cost without benefit.

## Adversarial testing

I treated the parser as hostile-input territory and wrote 17 edge cases against it: BOM-prefixed CSVs from Excel exports, all-zero columns, constant series fed to the Pearson correlation (which divides by zero variance if you're naive), quoted commas inside fields, empty files, single-column files, and more. The one I'm proudest to have caught was a latent spread-min/max bug the audit surfaced — a normalization that looked correct until a degenerate column made min equal max. Tests taught me the difference between code that runs and code that's safe.

## What I'd do differently

If this were a production product, I'd invest earliest in a persisted, replayable pipeline definition — right now the audit trail lives in the session. Making each run a saved, shareable, re-applicable recipe is what turns a one-off cleanup into something a team can rely on, and it's the first thing I'd build past the prototype.
