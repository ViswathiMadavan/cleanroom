import React, { useState, useMemo, useRef } from "react";
import Papa from "papaparse";
import _ from "lodash";
import {
  BarChart, Bar, LineChart, Line, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

/* ============================================================
   THEME
   ============================================================ */
const C = {
  paper: "#F3EEE3",
  paper2: "#ECE5D6",
  card: "#FBF8F1",
  ink: "#211C16",
  inkSoft: "#5C5446",
  line: "#D8CFBC",
  clay: "#BD5638",
  clayDk: "#9A4128",
  sage: "#4F6F5A",
  gold: "#C08A2D",
  blue: "#3D5A80",
};
const CHART_COLORS = [C.clay, C.sage, C.blue, C.gold, "#7A5C8E", "#B0654A", "#4C8076", "#9C8245"];

/* ============================================================
   DATA HELPERS
   ============================================================ */
const isMissing = (v) =>
  v === null || v === undefined ||
  (typeof v === "string" && (v.trim() === "" || ["na", "n/a", "null", "none", "nan"].includes(v.trim().toLowerCase())));

const toNum = (v) => {
  if (typeof v === "number") return v;
  if (isMissing(v)) return NaN;
  const n = Number(String(v).replace(/,/g, "").trim());
  return n;
};

function inferType(values) {
  const present = values.filter((v) => !isMissing(v));
  if (present.length === 0) return "text";
  const numeric = present.filter((v) => !isNaN(toNum(v))).length;
  if (numeric / present.length >= 0.85) return "numeric";
  const dated = present.filter((v) => !isNaN(Date.parse(v)) && /[-/:]/.test(String(v))).length;
  if (dated / present.length >= 0.85) return "date";
  return "text";
}

function inferTypes(data, columns) {
  const t = {};
  columns.forEach((c) => (t[c] = inferType(data.map((r) => r[c]))));
  return t;
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
};
const mode = (a) => {
  const counts = _.countBy(a);
  return _.maxBy(Object.keys(counts), (k) => counts[k]);
};
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};

/* ---- Step 1: duplicates + irrelevant columns ---- */
function removeDuplicates(data, dropCols) {
  const kept = dropCols.length ? data.map((r) => _.omit(r, dropCols)) : data;
  const seen = new Set();
  const out = [];
  const removedRows = [];
  kept.forEach((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) removedRows.push(row);
    else { seen.add(key); out.push(row); }
  });
  return { data: out, removedDupes: removedRows.length, droppedCols: dropCols, removedRows };
}

/* ---- Step 2: structural errors ---- */
const normKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// Format uniformity only: unify case / punctuation / whitespace. Most frequent spelling wins.
// Does NOT merge genuinely different strings (US vs USA, UK vs anything).
function formatStandardize(data, col) {
  const byKey = {};
  data.forEach((r) => {
    const v = r[col];
    if (isMissing(v)) return;
    const t = String(v).trim();
    const k = normKey(t);
    if (!k) return;
    byKey[k] = byKey[k] || {};
    byKey[k][t] = (byKey[k][t] || 0) + 1;
  });
  const map = {}; // original spelling -> canonical spelling
  Object.values(byKey).forEach((variants) => {
    const entries = Object.entries(variants).sort((a, b) => b[1] - a[1]);
    const canonical = entries[0][0];
    entries.forEach(([o]) => (map[o] = canonical));
  });
  const distinct = [...new Set(Object.values(map))].sort((a, b) => a.localeCompare(b));
  return { map, distinct };
}

// manualRules: [{ col, values:[...], to }]  — operate on already-standardized values
function fixStructural(data, textCols, manualRules) {
  const finalMaps = {}; // col -> { originalTrimmed -> finalValue }
  const standardized = {}; // col -> { originalTrimmed -> standardizedValue }
  textCols.forEach((col) => {
    const { map } = formatStandardize(data, col);
    standardized[col] = map;
    finalMaps[col] = { ...map };
  });
  // layer manual synonym rules on top (keyed by standardized value)
  (manualRules || []).forEach(({ col, values, to }) => {
    if (!textCols.includes(col) || !to) return;
    const set = new Set(values);
    Object.keys(finalMaps[col]).forEach((orig) => {
      if (set.has(finalMaps[col][orig])) finalMaps[col][orig] = to;
    });
    // also catch standardized values that map to themselves but aren't in finalMaps keys
    set.forEach((sv) => { if (finalMaps[col][sv] === undefined) finalMaps[col][sv] = to; });
  });
  const out = data.map((r) => {
    const nr = { ...r };
    textCols.forEach((col) => {
      if (isMissing(nr[col])) return;
      const trimmed = String(nr[col]).trim();
      const fm = finalMaps[col];
      nr[col] = fm[trimmed] !== undefined ? fm[trimmed] : trimmed;
    });
    return nr;
  });
  const changes = [];
  textCols.forEach((col) => {
    const seen = new Set();
    data.forEach((r) => {
      if (isMissing(r[col])) return;
      const from = String(r[col]).trim();
      const to = finalMaps[col][from] !== undefined ? finalMaps[col][from] : from;
      const key = from + "→" + to;
      if (from !== to && !seen.has(key)) { seen.add(key); changes.push({ col, from, to }); }
    });
  });
  return { data: out, changes };
}

/* ---- Step 3: missing values ---- */
function fixMissing(data, columns, types, thresholdPct, method) {
  const total = data.length;
  const incomplete = data.filter((r) => columns.some((c) => isMissing(r[c])));
  const missPct = total ? (incomplete.length / total) * 100 : 0;

  if (missPct <= thresholdPct) {
    const out = data.filter((r) => !columns.some((c) => isMissing(r[c])));
    return { data: out, action: "dropped", affected: incomplete.length, missPct, removedRows: incomplete };
  }
  const fills = {};
  columns.forEach((col) => {
    if (types[col] === "numeric") {
      const nums = data.map((r) => toNum(r[col])).filter((n) => !isNaN(n));
      fills[col] = { value: method === "median" ? median(nums) : mean(nums), how: method };
    } else {
      const vals = data.map((r) => r[col]).filter((v) => !isMissing(v));
      fills[col] = { value: mode(vals), how: "mode" };
    }
  });
  const out = data.map((r) => {
    const nr = { ...r };
    columns.forEach((col) => {
      if (isMissing(nr[col])) {
        const f = fills[col].value;
        nr[col] = types[col] === "numeric" ? Math.round(f * 100) / 100 : f;
      }
    });
    return nr;
  });
  return { data: out, action: "imputed", affected: incomplete.length, missPct, fills };
}

/* ---- Step 4: outliers (IQR) ---- */
function removeOutliers(data, numericCols) {
  const bounds = {};
  numericCols.forEach((col) => {
    const nums = data.map((r) => toNum(r[col])).filter((n) => !isNaN(n)).sort((a, b) => a - b);
    const q1 = quantile(nums, 0.25), q3 = quantile(nums, 0.75), iqr = q3 - q1;
    bounds[col] = { lower: q1 - 1.5 * iqr, upper: q3 + 1.5 * iqr, q1, q3 };
  });
  const perCol = {};
  numericCols.forEach((c) => (perCol[c] = 0));
  const removedRows = [];
  const out = data.filter((r) => {
    let outlier = false;
    numericCols.forEach((col) => {
      const v = toNum(r[col]);
      if (!isNaN(v) && (v < bounds[col].lower || v > bounds[col].upper)) { outlier = true; perCol[col]++; }
    });
    if (outlier) removedRows.push(r);
    return !outlier;
  });
  return { data: out, removed: removedRows.length, perCol, bounds, removedRows };
}

/* ---- Step 5: validation ---- */
function validate(data, columns, types, datePairs) {
  const invalid = new Set();
  const typeIssues = [];
  columns.forEach((col) => {
    if (types[col] === "numeric") {
      const rows = [];
      data.forEach((r, i) => { if (!isMissing(r[col]) && isNaN(toNum(r[col]))) { rows.push(i); invalid.add(i); } });
      if (rows.length) typeIssues.push({ col, kind: "non-numeric values", count: rows.length });
    } else if (types[col] === "date") {
      const rows = [];
      data.forEach((r, i) => { if (!isMissing(r[col]) && isNaN(Date.parse(r[col]))) { rows.push(i); invalid.add(i); } });
      if (rows.length) typeIssues.push({ col, kind: "unparseable dates", count: rows.length });
    }
  });
  const dateIssues = [];
  datePairs.forEach(({ start, end }) => {
    if (!start || !end) return;
    let bad = 0;
    data.forEach((r, i) => {
      const s = Date.parse(r[start]), e = Date.parse(r[end]);
      if (!isNaN(s) && !isNaN(e) && e < s) { bad++; invalid.add(i); }
    });
    if (bad) dateIssues.push({ start, end, count: bad });
  });
  let missingLeft = 0;
  data.forEach((r, i) => {
    const cells = columns.filter((c) => isMissing(r[c])).length;
    if (cells) { missingLeft += cells; invalid.add(i); }
  });
  const invalidIndices = [...invalid].sort((a, b) => a - b);
  const passed = !typeIssues.length && !dateIssues.length && !missingLeft;
  return { data, typeIssues, dateIssues, missingLeft, invalidIndices, invalidCount: invalidIndices.length, passed };
}

/* ---- Analysis ---- */
function pearson(x, y) {
  const n = x.length;
  if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

function correlationMatrix(data, numericCols) {
  const series = {};
  numericCols.forEach((c) => (series[c] = data.map((r) => toNum(r[c]))));
  const rows = numericCols.map((a) => {
    const row = { col: a };
    numericCols.forEach((b) => {
      const pairs = data
        .map((r) => [toNum(r[a]), toNum(r[b])])
        .filter(([u, v]) => !isNaN(u) && !isNaN(v));
      row[b] = pairs.length > 1
        ? Math.round(pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])) * 100) / 100
        : 0;
    });
    return row;
  });
  return rows;
}

function topPatterns(data, columns, types) {
  return columns.map((col) => {
    if (types[col] === "numeric") {
      const nums = data.map((r) => toNum(r[col])).filter((n) => !isNaN(n));
      return {
        col, type: "numeric",
        stats: { min: Math.min(...nums), max: Math.max(...nums), mean: +mean(nums).toFixed(2), median: +median(nums).toFixed(2), std: +stdev(nums).toFixed(2) },
      };
    }
    const counts = _.countBy(data.map((r) => (isMissing(r[col]) ? "(missing)" : String(r[col]))));
    const top = _.orderBy(Object.entries(counts), [1], ["desc"]).slice(0, 6)
      .map(([value, count]) => ({ value, count, pct: +((count / data.length) * 100).toFixed(1) }));
    return { col, type: types[col], top, distinct: Object.keys(counts).length };
  });
}

function skewness(nums) {
  const n = nums.length;
  if (n < 3) return 0;
  const m = mean(nums), sd = stdev(nums);
  if (sd === 0) return 0;
  const s = nums.reduce((a, x) => a + ((x - m) / sd) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * s;
}
function numericSummary(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const m = mean(nums), sd = stdev(nums);
  const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75);
  return { n: nums.length, min: sorted[0], max: sorted[sorted.length - 1], mean: m, median: median(nums), std: sd, q1, q3, iqr: q3 - q1, cv: m !== 0 ? Math.abs(sd / m) : 0, skew: skewness(nums) };
}
function interpretNumeric(s) {
  const parts = [];
  const sk = s.skew;
  if (Math.abs(sk) < 0.5) parts.push("roughly symmetric");
  else if (sk > 0) parts.push(Math.abs(sk) > 1 ? "strongly right-skewed (a long tail of high values)" : "moderately right-skewed");
  else parts.push(Math.abs(sk) > 1 ? "strongly left-skewed (a long tail of low values)" : "moderately left-skewed");
  if (s.cv > 1) parts.push("highly variable relative to its average");
  else if (s.cv > 0.3) parts.push("moderately spread");
  else parts.push("tightly clustered");
  return parts.join("; ") + ".";
}
function catSummary(values) {
  const counts = _.countBy(values);
  const entries = _.orderBy(Object.entries(counts), [1], ["desc"]);
  const present = values.length;
  const top = entries.slice(0, 6).map(([value, count]) => ({ value, count, pct: present ? (count / present) * 100 : 0 }));
  const top3Share = entries.slice(0, 3).reduce((a, [, c]) => a + c, 0) / (present || 1) * 100;
  let H = 0;
  entries.forEach(([, c]) => { const p = c / present; if (p > 0) H -= p * Math.log(p); });
  const diversity = entries.length > 1 ? H / Math.log(entries.length) : 0;
  return { distinct: entries.length, top, topShare: top.length ? top[0].pct : 0, top3Share, diversity };
}
function interpretCategorical(s) {
  if (s.topShare >= 60) return `Dominated by one value (${s.topShare.toFixed(0)}% of records).`;
  if (s.top3Share >= 80) return `Concentrated — the top 3 values cover ${s.top3Share.toFixed(0)}%.`;
  if (s.diversity > 0.85) return "Very evenly spread across categories.";
  return "Fairly balanced across a handful of main values.";
}
function generateHeadlines(data, columns, types) {
  const out = [];
  columns.forEach((col) => {
    if (types[col] === "numeric") {
      const nums = data.map((r) => toNum(r[col])).filter((x) => !isNaN(x));
      if (nums.length < 3) return;
      const s = numericSummary(nums);
      if (Math.abs(s.skew) > 1) out.push({ icon: "⤴", text: `${col} is ${s.skew > 0 ? "right" : "left"}-skewed — most values sit ${s.skew > 0 ? "low, with a few large ones pulling the average up" : "high, with a few small ones pulling it down"}.` });
      else if (s.cv > 1) out.push({ icon: "↔", text: `${col} varies widely — its spread is larger than its average (${s.mean.toFixed(1)}).` });
    } else if (types[col] === "text") {
      const vals = data.map((r) => r[col]).filter((v) => !isMissing(v));
      if (!vals.length) return;
      const s = catSummary(vals);
      if (s.topShare >= 50) out.push({ icon: "★", text: `${s.topShare.toFixed(0)}% of records share one ${col}: "${s.top[0].value}".` });
      else out.push({ icon: "▦", text: `${col} spans ${s.distinct} values; "${s.top[0].value}" leads at ${s.topShare.toFixed(0)}%.` });
    }
  });
  return out.slice(0, 6);
}
function corrStrength(r) {
  const a = Math.abs(r);
  if (a >= 0.7) return "very strong";
  if (a >= 0.5) return "strong";
  if (a >= 0.3) return "moderate";
  if (a >= 0.1) return "weak";
  return "negligible";
}

function findAnomalies(data, numericCols, types, columns) {
  const numeric = numericCols.map((col) => {
    const nums = data.map((r) => toNum(r[col])).filter((n) => !isNaN(n));
    const m = mean(nums), sd = stdev(nums);
    const flagged = data
      .map((r, i) => ({ i, v: toNum(r[col]) }))
      .filter(({ v }) => !isNaN(v) && sd > 0 && Math.abs((v - m) / sd) > 3)
      .map(({ i, v }) => ({ row: i + 1, value: v, z: +((v - m) / sd).toFixed(2) }));
    return { col, count: flagged.length, examples: flagged.slice(0, 5) };
  }).filter((x) => x.count > 0);

  const rare = columns.filter((c) => types[c] === "text").map((col) => {
    const counts = _.countBy(data.map((r) => r[col]).filter((v) => !isMissing(v)));
    const rares = Object.entries(counts).filter(([, n]) => n === 1).map(([v]) => v);
    return { col, count: rares.length, examples: rares.slice(0, 5) };
  }).filter((x) => x.count > 0);

  return { numeric, rare };
}

/* ---- CSV download ---- */
function downloadCSV(data, filename) {
  const csv = Papa.unparse(data);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Validate + clean a parsed CSV result; returns { data, warnings, summary } or { error }.
function ingest(res, name) {
  const rawRows = res && res.data ? res.data : [];
  const data = rawRows.filter((row) => row && typeof row === "object" && Object.values(row).some((v) => !isMissing(v)));
  if (!data.length) return { error: "No usable data rows were found. Make sure the file is a CSV with a header row and at least one data row." };
  const fields = res.meta && res.meta.fields ? res.meta.fields : Object.keys(data[0]);
  if (fields.length < 1) return { error: "Couldn't detect any columns. Check that the first row contains column headers." };
  const warnings = [];
  const dupes = [...new Set(fields.filter((f, i) => fields.indexOf(f) !== i))];
  if (dupes.length) warnings.push(`Repeated column name(s): ${dupes.join(", ")} — only the last copy of each was kept.`);
  if (res.errors && res.errors.length) {
    const mismatch = res.errors.filter((e) => e.code === "TooFewFields" || e.code === "TooManyFields").length;
    if (mismatch) warnings.push(`${mismatch} row(s) had an unexpected column count and were realigned to the header.`);
  }
  const delim = res.meta && res.meta.delimiter;
  if (delim && delim !== ",") warnings.push(`Delimiter auto-detected as "${delim === "\t" ? "tab" : delim}".`);
  if (data.length > 10000) warnings.push(`${data.length.toLocaleString()} rows — this in-browser tool stays smooth to ~10k rows; larger files may feel slow.`);
  return { data, warnings, summary: `Loaded ${data.length.toLocaleString()} rows × ${fields.length} columns from ${name}.` };
}

/* ---- sample datasets (intentionally messy, to exercise the whole pipeline) ---- */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const isoDate = (d) => d.toISOString().slice(0, 10);

// 1 · Customer signups — messy country labels, missing ages, revenue outliers, duplicates
function makeCustomers() {
  const countries = ["USA", "USA", "U.S.A", "U.S", "usa", "Canada", "canada", "CANADA", "India", "india", "U.K", "UK", "United Kingdom"];
  const rows = [];
  for (let i = 0; i < 120; i++) {
    const start = new Date(2024, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27));
    const end = new Date(start.getTime() + (Math.random() * 40 - 5) * 86400000);
    rows.push({
      id: i + 1,
      country: i > 0 && i % 17 === 0 ? "" : pick(countries),
      age: i > 0 && i % 23 === 0 ? "" : Math.floor(18 + Math.random() * 50),
      revenue: i > 0 && i % 31 === 0 ? 99999 : Math.round(200 + Math.random() * 1800),
      start_date: isoDate(start),
      end_date: isoDate(end),
    });
  }
  rows.push({ ...rows[0] }); rows.push({ ...rows[5] }); // duplicates
  return rows;
}

// 2 · Sales orders — inconsistent region/status casing, amount outliers, ship-before-order errors
function makeSales() {
  const regions = ["West", "west", "WEST", "East", "east", "North", "north", "South", "south "];
  const statuses = ["Shipped", "shipped", "Pending", "pending", "Cancelled", "cancelled"];
  const rows = [];
  for (let i = 0; i < 150; i++) {
    const order = new Date(2024, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27));
    const ship = new Date(order.getTime() + (Math.random() * 30 - 6) * 86400000); // some ship before order
    rows.push({
      order_id: 1000 + i,
      region: i > 0 && i % 19 === 0 ? "" : pick(regions),
      amount: i > 0 && i % 29 === 0 ? 88888 : Math.round(20 + Math.random() * 980),
      quantity: i > 0 && i % 21 === 0 ? "" : 1 + Math.floor(Math.random() * 12),
      status: pick(statuses),
      order_date: isoDate(order),
      ship_date: isoDate(ship),
    });
  }
  rows.push({ ...rows[3] }); rows.push({ ...rows[10] }); // duplicates
  return rows;
}

// 3 · Survey responses — mixed-case plans, blank answers, a few wild ratings
function makeSurvey() {
  const plans = ["Free", "free", "FREE", "Pro", "pro", "Enterprise", "enterprise"];
  const sources = ["Email", "email", "Ad", "ad", "Referral", "referral"];
  const rows = [];
  for (let i = 0; i < 110; i++) {
    const signup = new Date(2024, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 27));
    rows.push({
      respondent_id: i + 1,
      plan: i > 0 && i % 18 === 0 ? "" : pick(plans),
      satisfaction: i > 0 && i % 27 === 0 ? 99 : 1 + Math.floor(Math.random() * 5),
      age: i > 0 && i % 25 === 0 ? "" : Math.floor(18 + Math.random() * 52),
      source: pick(sources),
      signup_date: isoDate(signup),
    });
  }
  rows.push({ ...rows[1] }); rows.push({ ...rows[7] }); // duplicates
  return rows;
}

const SAMPLE_DATASETS = [
  { id: "customers", label: "Customer signups", desc: "120 rows · messy country labels, missing ages, revenue outliers", make: makeCustomers },
  { id: "sales", label: "Sales orders", desc: "150 rows · inconsistent regions, amount outliers, bad ship dates", make: makeSales },
  { id: "survey", label: "Survey responses", desc: "110 rows · mixed-case plans, blank answers, wild ratings", make: makeSurvey },
];

/* ============================================================
   UI PRIMITIVES
   ============================================================ */
const Btn = ({ children, onClick, kind = "solid", disabled, small }) => (
  <button onClick={onClick} disabled={disabled}
    style={{
      fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer",
      fontSize: small ? 12 : 13.5, letterSpacing: 0.2, padding: small ? "6px 12px" : "10px 18px",
      borderRadius: 8, transition: "all .15s", opacity: disabled ? 0.4 : 1,
      border: kind === "solid" ? "none" : `1.5px solid ${C.line}`,
      background: kind === "solid" ? C.clay : "transparent",
      color: kind === "solid" ? "#fff" : C.ink,
    }}
    onMouseOver={(e) => !disabled && (e.currentTarget.style.background = kind === "solid" ? C.clayDk : C.paper2)}
    onMouseOut={(e) => !disabled && (e.currentTarget.style.background = kind === "solid" ? C.clay : "transparent")}>
    {children}
  </button>
);

const Card = ({ children, style }) => (
  <div className="cr-card" style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 22, ...style }}>{children}</div>
);

const Stat = ({ label, value, accent }) => (
  <div style={{ flex: 1, minWidth: 120 }}>
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: C.inkSoft, fontFamily: "'IBM Plex Mono', monospace" }}>{label}</div>
    <div style={{ fontSize: 28, fontWeight: 600, color: accent || C.ink, fontFamily: "'Fraunces', serif", lineHeight: 1.1, marginTop: 4 }}>{value}</div>
  </div>
);

const StepBadge = ({ n, done }) => (
  <span style={{
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: "50%",
    fontSize: 12, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", marginRight: 10,
    background: done ? C.sage : C.paper2, color: done ? "#fff" : C.inkSoft, border: `1px solid ${done ? C.sage : C.line}`,
  }}>{done ? "✓" : n}</span>
);

const Pill = ({ children, tone = "neutral" }) => {
  const map = { neutral: [C.paper2, C.inkSoft], good: ["#E3EDE5", C.sage], warn: ["#F6E7D8", C.clayDk], info: ["#E1E8F1", C.blue] };
  const [bg, fg] = map[tone];
  return <span style={{ background: bg, color: fg, padding: "3px 9px", borderRadius: 20, fontSize: 11.5, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>{children}</span>;
};

function DataTable({ data, columns, max = 40, types = {} }) {
  if (!data || !data.length) return <div style={{ color: C.inkSoft, fontStyle: "italic", padding: 12 }}>No rows.</div>;
  const cols = columns || Object.keys(data[0]);
  return (
    <div style={{ overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 10, maxHeight: 360 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
        <thead>
          <tr>{cols.map((c) => (
            <th key={c} style={{ position: "sticky", top: 0, background: C.paper2, textAlign: "left", padding: "9px 12px", borderBottom: `1.5px solid ${C.line}`, color: C.ink, whiteSpace: "nowrap" }}>
              {c}{types[c] && <span style={{ color: C.inkSoft, fontWeight: 400 }}> · {types[c][0]}</span>}
            </th>))}</tr>
        </thead>
        <tbody>
          {data.slice(0, max).map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? C.card : "#fff" }}>
              {cols.map((c) => (
                <td key={c} style={{ padding: "7px 12px", borderBottom: `1px solid ${C.paper2}`, color: isMissing(row[c]) ? C.clay : C.ink, fontStyle: isMissing(row[c]) ? "italic" : "normal", whiteSpace: "nowrap" }}>
                  {isMissing(row[c]) ? "—" : String(row[c])}
                </td>))}
            </tr>))}
        </tbody>
      </table>
      {data.length > max && <div style={{ padding: "8px 12px", fontSize: 12, color: C.inkSoft, background: C.paper2, fontFamily: "'IBM Plex Mono', monospace" }}>Showing {max} of {data.length} rows</div>}
    </div>
  );
}

const SectionTitle = ({ children, sub }) => (
  <div style={{ marginBottom: 16 }}>
    <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, color: C.ink, margin: 0 }}>{children}</h3>
    {sub && <p style={{ color: C.inkSoft, fontSize: 13.5, margin: "5px 0 0", lineHeight: 1.5 }}>{sub}</p>}
  </div>
);

/* ============================================================
   MAIN APP
   ============================================================ */
const MAIN_TABS = [
  { id: "collect", label: "Data Collect", n: "01" },
  { id: "clean", label: "Data Cleaning", n: "02" },
  { id: "analyze", label: "Analyze", n: "03" },
  { id: "viz", label: "Visualization", n: "04" },
  { id: "result", label: "Result", n: "05" },
];
const CLEAN_SUBS = [
  { id: "dedup", label: "1 · Duplicates & Irrelevant" },
  { id: "structural", label: "2 · Structural Errors" },
  { id: "outliers", label: "3 · Outliers" },
  { id: "missing", label: "4 · Missing Values" },
  { id: "validate", label: "5 · Validate" },
];
const ANALYZE_SUBS = [
  { id: "patterns", label: "Patterns & Trends" },
  { id: "correlation", label: "Correlation" },
  { id: "anomaly", label: "Anomaly" },
];
const STEP_ORDER = ["dedup", "structural", "outliers", "missing", "validate"];

export default function App() {
  const [main, setMain] = useState("collect");
  const [cleanSub, setCleanSub] = useState("dedup");
  const [analyzeSub, setAnalyzeSub] = useState("patterns");

  const [raw, setRaw] = useState(null); // {data, columns}
  const [stages, setStages] = useState({ dedup: null, structural: null, missing: null, outliers: null, validate: null });

  // step controls
  const [dropCols, setDropCols] = useState([]);
  const [structCols, setStructCols] = useState([]);
  const [manualRules, setManualRules] = useState([]);
  const [missThreshold, setMissThreshold] = useState(15);
  const [missMethod, setMissMethod] = useState("median");
  const [datePair, setDatePair] = useState({ start: "", end: "" });
  const [uploadMsg, setUploadMsg] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef();

  const types = useMemo(() => (raw ? inferTypes(raw.data, raw.columns) : {}), [raw]);
  const numericCols = useMemo(() => raw ? raw.columns.filter((c) => types[c] === "numeric") : [], [raw, types]);
  const textCols = useMemo(() => raw ? raw.columns.filter((c) => types[c] === "text") : [], [raw, types]);
  const dateCols = useMemo(() => raw ? raw.columns.filter((c) => types[c] === "date") : [], [raw, types]);

  // input data for a given step = output of nearest prior completed stage, else raw
  const inputFor = (stepId) => {
    const idx = STEP_ORDER.indexOf(stepId);
    for (let i = idx - 1; i >= 0; i--) if (stages[STEP_ORDER[i]]) return stages[STEP_ORDER[i]].data;
    return raw ? raw.data : null;
  };
  const cleanedData = useMemo(() => {
    for (let i = STEP_ORDER.length - 1; i >= 0; i--) if (stages[STEP_ORDER[i]]) return stages[STEP_ORDER[i]].data;
    return raw ? raw.data : null;
  }, [stages, raw]);
  const cleanedCols = cleanedData && cleanedData.length ? Object.keys(cleanedData[0]) : (raw ? raw.columns : []);

  const loadData = (data) => {
    const columns = Object.keys(data[0] || {});
    setRaw({ data, columns });
    setStages({ dedup: null, structural: null, missing: null, outliers: null, validate: null });
    const t = inferTypes(data, columns);
    setStructCols(columns.filter((c) => t[c] === "text"));
    setManualRules([]);
    const dc = columns.filter((c) => t[c] === "date");
    setDatePair({ start: dc[0] || "", end: dc[1] || "" });
  };

  const onFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) {
      setUploadMsg({ type: "error", text: "This file is over 15 MB. The in-browser engine is built for files up to ~10k rows — please try a smaller sample." });
      e.target.value = ""; return;
    }
    setLoading(true); setUploadMsg(null);
    Papa.parse(f, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      transformHeader: (h, i) => { const t = (h || "").trim(); return t || `column_${i + 1}`; },
      complete: (res) => {
        setLoading(false);
        try {
          const result = ingest(res, f.name);
          if (result.error) { setUploadMsg({ type: "error", text: result.error }); return; }
          loadData(result.data);
          setUploadMsg({ type: "info", text: result.summary, warnings: result.warnings });
        } catch (err) {
          setUploadMsg({ type: "error", text: "Couldn't read this file: " + (err && err.message ? err.message : "unknown error") });
        }
      },
      error: (err) => { setLoading(false); setUploadMsg({ type: "error", text: "Parsing failed: " + (err && err.message ? err.message : "unknown error") }); },
    });
    e.target.value = ""; // allow re-uploading the same file
  };
  const loadSample = (id) => {
    const ds = SAMPLE_DATASETS.find((d) => d.id === id) || SAMPLE_DATASETS[0];
    setUploadMsg(null); loadData(ds.make());
  };

  const setStage = (id, payload) => setStages((s) => {
    const next = { ...s, [id]: payload };
    const idx = STEP_ORDER.indexOf(id);
    STEP_ORDER.slice(idx + 1).forEach((later) => { next[later] = null; }); // re-running a step invalidates everything after it
    return next;
  });

  /* ---- run handlers ---- */
  const runDedup = () => { const r = removeDuplicates(inputFor("dedup"), dropCols); setStage("dedup", { data: r.data, meta: r }); };
  const runStruct = () => { const r = fixStructural(inputFor("structural"), structCols, manualRules); setStage("structural", { data: r.data, meta: r }); };
  const runMissing = () => { const inp = inputFor("missing"); const r = fixMissing(inp, Object.keys(inp[0] || {}), types, missThreshold, missMethod); setStage("missing", { data: r.data, meta: r }); };
  const runOutliers = () => { const inp = inputFor("outliers"); const nc = Object.keys(inp[0] || {}).filter((c) => types[c] === "numeric"); const r = removeOutliers(inp, nc); setStage("outliers", { data: r.data, meta: r }); };
  const runValidate = () => { const inp = inputFor("validate"); const cols = Object.keys(inp[0] || {}); const r = validate(inp, cols, types, [datePair]); setStage("validate", { data: r.data, meta: r }); };
  const removeInvalid = () => {
    const inp = inputFor("validate");
    const cols = Object.keys(inp[0] || {});
    const idx = (stages.validate && stages.validate.meta.invalidIndices) || validate(inp, cols, types, [datePair]).invalidIndices;
    const bad = new Set(idx);
    const cleaned = inp.filter((_, i) => !bad.has(i));
    const removedRows = inp.filter((_, i) => bad.has(i));
    const r = validate(cleaned, cols, types, [datePair]); // re-check the cleaned data
    setStage("validate", { data: cleaned, meta: { ...r, removed: bad.size, removedRows } });
  };
  const undoStep = (id) => setStages((s) => {
    const next = { ...s };
    STEP_ORDER.slice(STEP_ORDER.indexOf(id)).forEach((later) => { next[later] = null; }); // undo this step and anything built on it
    return next;
  });

  /* =========================================================
     RENDER
     ========================================================= */
  const showSubs = main === "clean" ? CLEAN_SUBS : main === "analyze" ? ANALYZE_SUBS : null;
  const activeSub = main === "clean" ? cleanSub : main === "analyze" ? analyzeSub : null;
  const setActiveSub = main === "clean" ? setCleanSub : setAnalyzeSub;

  return (
    <div style={{ background: C.paper, minHeight: "100vh", color: C.ink, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        input[type=range]{accent-color:${C.clay};} ::selection{background:${C.clay};color:#fff;}
        @media (max-width: 640px){
          .cr-content{ padding-left:14px !important; padding-right:14px !important; }
          .cr-nav{ padding-left:14px !important; padding-right:14px !important; }
          .cr-header > div{ padding-left:16px !important; padding-right:16px !important; }
        }
        @media print{
          .cr-header, .cr-nav, .cr-no-print, button{ display:none !important; }
          .cr-content{ max-width:100% !important; padding:8px 0 0 !important; }
          body{ background:#fff !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
          .cr-card{ break-inside:avoid; box-shadow:none !important; }
        }`}</style>

      {/* Header */}
      <div className="cr-header" style={{ borderBottom: `1px solid ${C.line}`, background: C.paper2 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "20px 28px", display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: 27, fontWeight: 600, margin: 0, letterSpacing: -0.4 }}>
              Cleanroom<span style={{ color: C.clay }}>.</span>
            </h1>
            <p style={{ margin: "2px 0 0", fontSize: 12.5, color: C.inkSoft, fontFamily: "'IBM Plex Mono', monospace" }}>collect → clean → analyze → visualize → report</p>
          </div>
          {raw && <Pill tone="info">{raw.data.length} rows loaded · {raw.columns.length} cols</Pill>}
        </div>
      </div>

      {/* Main tabs */}
      <div className="cr-nav" style={{ maxWidth: 1080, margin: "0 auto", padding: "0 28px" }}>
        <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
          {MAIN_TABS.map((t) => {
            const active = main === t.id;
            const locked = t.id !== "collect" && !raw;
            return (
              <button key={t.id} disabled={locked}
                onClick={() => setMain(t.id)}
                style={{ background: "none", border: "none", padding: "16px 18px 13px", cursor: locked ? "not-allowed" : "pointer",
                  fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, fontWeight: active ? 600 : 500,
                  color: locked ? C.line : active ? C.ink : C.inkSoft, borderBottom: `3px solid ${active ? C.clay : "transparent"}`,
                  marginBottom: -1, opacity: locked ? 0.5 : 1, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: active ? C.clay : C.inkSoft }}>{t.n}</span>
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Sub tabs */}
        {showSubs && (
          <div style={{ display: "flex", gap: 6, padding: "14px 0 2px", flexWrap: "wrap" }}>
            {showSubs.map((s) => {
              const active = activeSub === s.id;
              const done = main === "clean" && stages[s.id];
              return (
                <button key={s.id} onClick={() => setActiveSub(s.id)}
                  style={{ padding: "7px 14px", borderRadius: 20, cursor: "pointer", fontSize: 12.5, fontWeight: 600,
                    fontFamily: "'IBM Plex Sans', sans-serif", border: `1.5px solid ${active ? C.clay : C.line}`,
                    background: active ? C.clay : done ? "#E3EDE5" : "transparent", color: active ? "#fff" : done ? C.sage : C.inkSoft }}>
                  {done && !active ? "✓ " : ""}{s.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="cr-content" style={{ maxWidth: 1080, margin: "0 auto", padding: "26px 28px 80px" }}>
        {main === "collect" && <Collect raw={raw} types={types} onFile={onFile} fileRef={fileRef} loadSample={loadSample} reset={() => { setRaw(null); setUploadMsg(null); }} uploadMsg={uploadMsg} loading={loading} />}
        {main === "clean" && (
          <CleanStep
            sub={cleanSub} stages={stages} inputFor={inputFor} types={types}
            raw={raw} dropCols={dropCols} setDropCols={setDropCols}
            structCols={structCols} setStructCols={setStructCols} textCols={textCols}
            manualRules={manualRules} setManualRules={setManualRules}
            missThreshold={missThreshold} setMissThreshold={setMissThreshold} missMethod={missMethod} setMissMethod={setMissMethod}
            datePair={datePair} setDatePair={setDatePair} dateCols={dateCols} allCols={cleanedCols}
            run={{ dedup: runDedup, structural: runStruct, missing: runMissing, outliers: runOutliers, validate: runValidate, removeInvalid, undo: undoStep }}
            goNext={(id) => { const i = STEP_ORDER.indexOf(id); if (i < STEP_ORDER.length - 1) setCleanSub(STEP_ORDER[i + 1]); else setMain("analyze"); }}
          />
        )}
        {main === "analyze" && <Analyze sub={analyzeSub} data={cleanedData} columns={cleanedCols} types={types} isClean={!!stages.validate} />}
        {main === "viz" && <Viz data={cleanedData} columns={cleanedCols} types={types} numericCols={numericCols} dateCols={dateCols} textCols={textCols} />}
        {main === "result" && <Result raw={raw} cleanedData={cleanedData} columns={cleanedCols} types={types} stages={stages} numericCols={numericCols} textCols={textCols} dateCols={dateCols} />}
      </div>
    </div>
  );
}

/* ============================================================
   TAB 1 — COLLECT
   ============================================================ */
function Collect({ raw, types, onFile, fileRef, loadSample, reset, uploadMsg, loading }) {
  return (
    <div>
      <SectionTitle sub="Upload a CSV file from your users, or load a sample messy dataset to see the whole pipeline work end to end.">Data Collect</SectionTitle>
      <Card style={{ borderStyle: "dashed", borderColor: C.clay, textAlign: "center", padding: 40, background: "#FBF6EE" }}>
        <div style={{ fontFamily: "'Fraunces', serif", fontSize: 19, marginBottom: 6 }}>Drop your data in</div>
        <p style={{ color: C.inkSoft, fontSize: 13.5, maxWidth: 440, margin: "0 auto 18px" }}>CSV with a header row. Delimiter is auto-detected; messy headers, blank lines and ragged rows are handled. Everything downstream flows from here.</p>
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Btn onClick={() => fileRef.current.click()} disabled={loading}>{loading ? "Reading…" : "Choose CSV file"}</Btn>
          {raw && <Btn kind="ghost" onClick={reset}>Clear</Btn>}
        </div>
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 10, fontFamily: "'IBM Plex Mono', monospace", textTransform: "uppercase", letterSpacing: 0.5 }}>or try a sample dataset</div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {SAMPLE_DATASETS.map((d) => (
              <button key={d.id} onClick={() => loadSample(d.id)} disabled={loading}
                style={{ textAlign: "left", border: `1.5px solid ${C.line}`, borderRadius: 10, padding: "11px 14px", background: "#fff", cursor: loading ? "not-allowed" : "pointer", maxWidth: 210, transition: "all .15s" }}
                onMouseOver={(e) => { if (!loading) { e.currentTarget.style.borderColor = C.clay; e.currentTarget.style.background = "#FBF6EE"; } }}
                onMouseOut={(e) => { e.currentTarget.style.borderColor = C.line; e.currentTarget.style.background = "#fff"; }}>
                <div style={{ fontWeight: 600, fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", color: C.ink }}>{d.label}</div>
                <div style={{ fontSize: 11.5, color: C.inkSoft, lineHeight: 1.4, marginTop: 3 }}>{d.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </Card>

      {uploadMsg && (
        <div style={{ marginTop: 16, padding: 14, borderRadius: 10, fontSize: 13,
          background: uploadMsg.type === "error" ? "#F6E3DC" : "#E8EFE9",
          border: `1px solid ${uploadMsg.type === "error" ? C.clay : C.sage}`, color: C.ink }}>
          <div style={{ fontWeight: 600, color: uploadMsg.type === "error" ? C.clayDk : C.sage }}>
            {uploadMsg.type === "error" ? "⚠ Couldn't load that file" : "✓ " + uploadMsg.text}
          </div>
          {uploadMsg.type === "error" && <div style={{ marginTop: 4 }}>{uploadMsg.text}</div>}
          {uploadMsg.warnings && uploadMsg.warnings.length > 0 && (
            <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: C.inkSoft, lineHeight: 1.6 }}>
              {uploadMsg.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {raw && (
        <div style={{ marginTop: 24 }}>
          <Card>
            <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 18 }}>
              <Stat label="Rows" value={raw.data.length} />
              <Stat label="Columns" value={raw.columns.length} />
              <Stat label="Numeric" value={raw.columns.filter((c) => types[c] === "numeric").length} accent={C.sage} />
              <Stat label="Text" value={raw.columns.filter((c) => types[c] === "text").length} accent={C.blue} />
              <Stat label="Date" value={raw.columns.filter((c) => types[c] === "date").length} accent={C.gold} />
            </div>
            <DataTable data={raw.data} columns={raw.columns} types={types} />
            <p style={{ fontSize: 12.5, color: C.inkSoft, marginTop: 12 }}>Column types are auto-detected. Head to <b style={{ color: C.ink }}>Data Cleaning</b> to start the pipeline.</p>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TAB 2 — CLEANING (with the 5 sub-steps)
   ============================================================ */
function FlowBar({ inputCount, outputCount, stepId }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, flexWrap: "wrap" }}>
      <Pill tone="info">input · {inputCount} rows</Pill>
      <span style={{ color: C.inkSoft }}>──▶</span>
      {outputCount != null ? <Pill tone="good">output · {outputCount} rows</Pill> : <Pill>not run yet</Pill>}
    </div>
  );
}

const STEP_FILES = { dedup: "step1_deduplicated.csv", structural: "step2_structural.csv", outliers: "step3_outliers.csv", missing: "step4_missing.csv", validate: "cleaned_data.csv" };
const STEP_LABELS = { dedup: "Step 1 · deduped", structural: "Step 2 · standardized", outliers: "Step 3 · outliers removed", missing: "Step 4 · missing fixed", validate: "Step 5 · validated" };
function PrevDownloads({ stages, currentStep }) {
  const idx = STEP_ORDER.indexOf(currentStep);
  const done = STEP_ORDER.slice(0, idx).filter((s) => stages[s]);
  if (!done.length) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 18, padding: "10px 12px", background: C.paper2, borderRadius: 10, border: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 11.5, color: C.inkSoft, fontFamily: "'IBM Plex Mono',monospace", textTransform: "uppercase", letterSpacing: 0.5 }}>download earlier outputs:</span>
      {done.map((s) => (
        <Btn key={s} kind="ghost" small onClick={() => downloadCSV(stages[s].data, STEP_FILES[s])}>↓ {STEP_LABELS[s]}</Btn>
      ))}
    </div>
  );
}

function CleanStep(props) {
  const { sub, stages, inputFor, types, dropCols, setDropCols, structCols, setStructCols, textCols, manualRules, setManualRules,
    missThreshold, setMissThreshold, missMethod, setMissMethod, datePair, setDatePair, dateCols, allCols, run, goNext, raw } = props;

  const input = inputFor(sub);
  const stage = stages[sub];
  const inputCols = input && input.length ? Object.keys(input[0]) : (raw ? raw.columns : []);

  // working state for the manual-merge builder (used by the structural sub-tab)
  const [mCol, setMCol] = useState("");
  const [mSel, setMSel] = useState([]);
  const [mTo, setMTo] = useState("");

  const NextBtn = () => stage ? (
    <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Btn onClick={() => goNext(sub)}>Send to next step →</Btn>
      <Btn kind="ghost" onClick={() => run.undo(sub)}>↺ Undo this step</Btn>
    </div>
  ) : null;
  const RemovedPreview = ({ rows }) => (rows && rows.length ? (
    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: "pointer", fontSize: 12.5, color: C.clay, fontWeight: 600 }}>Preview the {rows.length} row(s) this removed</summary>
      <div style={{ marginTop: 8 }}><DataTable data={rows} types={types} max={20} /></div>
    </details>
  ) : null);

  /* ---- 1. dedup ---- */
  if (sub === "dedup") {
    return (
      <div>
        <SectionTitle sub="Drop exact duplicate rows and any columns that aren't useful for analysis. The cleaned output becomes the input to step 2 — and you can download it here.">
          <StepBadge n="1" done={!!stage} />Remove Duplicates & Irrelevant Data
        </SectionTitle>
        <Card>
          <FlowBar inputCount={input?.length || 0} outputCount={stage?.data.length} />
          <PrevDownloads stages={stages} currentStep={sub} />
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Columns to drop as irrelevant</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
            {inputCols.map((c) => {
              const on = dropCols.includes(c);
              return <button key={c} onClick={() => setDropCols(on ? dropCols.filter((x) => x !== c) : [...dropCols, c])}
                style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5,
                  border: `1.5px solid ${on ? C.clay : C.line}`, background: on ? "#F6E7D8" : "#fff", color: on ? C.clayDk : C.ink, textDecoration: on ? "line-through" : "none" }}>{c}</button>;
            })}
          </div>
          <Btn onClick={run.dedup}>Run de-duplication</Btn>
          {stage && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
                <Stat label="Duplicates removed" value={stage.meta.removedDupes} accent={C.clay} />
                <Stat label="Columns dropped" value={stage.meta.droppedCols.length} accent={C.clay} />
                <Stat label="Rows remaining" value={stage.data.length} accent={C.sage} />
              </div>
              <DataTable data={stage.data} types={types} />
              <RemovedPreview rows={stage.meta.removedRows} />
              <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
                <Btn kind="ghost" small onClick={() => downloadCSV(stage.data, "step1_deduplicated.csv")}>↓ Download step 1 output</Btn>
              </div>
              <NextBtn />
            </div>
          )}
        </Card>
      </div>
    );
  }

  /* ---- 2. structural ---- */
  if (sub === "structural") {
    const textInputCols = inputCols.filter((c) => types[c] === "text");
    const colsForMerge = textInputCols.length ? textInputCols : inputCols;
    const activeMergeCol = mCol && colsForMerge.includes(mCol) ? mCol : (colsForMerge[0] || "");
    const stdDistinct = activeMergeCol && input ? formatStandardize(input, activeMergeCol).distinct : [];
    const toggleSel = (v) => setMSel(mSel.includes(v) ? mSel.filter((x) => x !== v) : [...mSel, v]);
    const canonical = mSel.includes(mTo) ? mTo : (mSel[0] || "");
    const addRule = () => {
      if (mSel.length < 2 || !canonical) return;
      setManualRules([...manualRules, { col: activeMergeCol, values: mSel.filter((v) => v !== canonical), to: canonical }]);
      setMSel([]); setMTo("");
    };
    return (
      <div>
        <SectionTitle sub="Two things happen here. Formatting is unified automatically (case, punctuation, spacing) — so country/Country become one, and UK/U.K become one. Genuinely different spellings like US vs USA are never merged automatically; for those, add a manual rule below.">
          <StepBadge n="2" done={!!stage} />Fix Structural Errors
        </SectionTitle>
        <Card>
          <FlowBar inputCount={input?.length || 0} outputCount={stage?.data.length} />
          <PrevDownloads stages={stages} currentStep={sub} />

          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>1 · Columns to standardize formatting</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            {colsForMerge.map((c) => {
              const on = structCols.includes(c);
              return <button key={c} onClick={() => setStructCols(on ? structCols.filter((x) => x !== c) : [...structCols, c])}
                style={{ padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5,
                  border: `1.5px solid ${on ? C.clay : C.line}`, background: on ? "#F6E7D8" : "#fff", color: on ? C.clayDk : C.ink }}>{c}</button>;
            })}
          </div>
          <p style={{ fontSize: 12, color: C.inkSoft, margin: "0 0 18px", lineHeight: 1.5 }}>Within each group of formatting variants, the most frequent spelling wins.</p>

          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>2 · Manual merges <span style={{ fontWeight: 400, color: C.inkSoft }}>— for synonyms like US = USA (optional)</span></div>
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, background: "#fff", marginBottom: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, color: C.inkSoft }}>Column:</span>
              <select value={activeMergeCol} onChange={(e) => { setMCol(e.target.value); setMSel([]); setMTo(""); }} style={{ ...selStyle, padding: "5px 8px", fontSize: 12.5 }}>
                {colsForMerge.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {stdDistinct.length === 0 ? <p style={{ fontSize: 12.5, color: C.inkSoft, margin: 0 }}>No values to merge.</p> : (
              <>
                <div style={{ fontSize: 12, color: C.inkSoft, marginBottom: 6 }}>Tick the values that mean the same thing:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 130, overflow: "auto", marginBottom: 12 }}>
                  {stdDistinct.map((v) => {
                    const on = mSel.includes(v);
                    return <button key={v} onClick={() => toggleSel(v)}
                      style={{ padding: "5px 11px", borderRadius: 16, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12,
                        border: `1.5px solid ${on ? C.blue : C.line}`, background: on ? "#E1E8F1" : "#fff", color: on ? C.blue : C.ink }}>
                      {on ? "✓ " : ""}{v}</button>;
                  })}
                </div>
                {mSel.length >= 2 && (
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: C.inkSoft }}>Make them all:</span>
                    <select value={canonical} onChange={(e) => setMTo(e.target.value)} style={{ ...selStyle, padding: "5px 8px", fontSize: 12.5 }}>
                      {mSel.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                    <Btn small onClick={addRule}>+ Add merge rule</Btn>
                  </div>
                )}
              </>
            )}
          </div>
          {manualRules.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {manualRules.map((r, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", marginBottom: 5 }}>
                  <Pill tone="info">{r.col}</Pill>
                  <span>{[...r.values, r.to].filter((v, j, a) => a.indexOf(v) === j).join(", ")} → <b style={{ color: C.sage }}>{r.to}</b></span>
                  <button onClick={() => setManualRules(manualRules.filter((_, j) => j !== i))} style={{ border: "none", background: "none", cursor: "pointer", color: C.clay, fontSize: 15 }}>×</button>
                </div>
              ))}
            </div>
          )}

          <Btn onClick={run.structural}>Standardize entries</Btn>
          {stage && (
            <div style={{ marginTop: 20 }}>
              <Stat label="Values rewritten" value={stage.meta.changes.length} accent={C.clay} />
              {stage.meta.changes.length > 0 && (
                <div style={{ margin: "14px 0", maxHeight: 200, overflow: "auto", border: `1px solid ${C.line}`, borderRadius: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
                    <thead><tr style={{ background: C.paper2 }}><th style={{ textAlign: "left", padding: "8px 12px" }}>Column</th><th style={{ textAlign: "left", padding: "8px 12px" }}>From</th><th style={{ padding: "8px" }}></th><th style={{ textAlign: "left", padding: "8px 12px" }}>To</th></tr></thead>
                    <tbody>{stage.meta.changes.slice(0, 40).map((ch, i) => (
                      <tr key={i} style={{ background: i % 2 ? C.card : "#fff" }}>
                        <td style={{ padding: "6px 12px", color: C.inkSoft }}>{ch.col}</td>
                        <td style={{ padding: "6px 12px" }}>"{ch.from}"</td><td style={{ color: C.clay, textAlign: "center" }}>→</td>
                        <td style={{ padding: "6px 12px", color: C.sage, fontWeight: 600 }}>"{ch.to}"</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              )}
              <DataTable data={stage.data} types={types} />
              <div style={{ marginTop: 14 }}><Btn kind="ghost" small onClick={() => downloadCSV(stage.data, "step2_structural.csv")}>↓ Download step 2 output</Btn></div>
              <NextBtn />
            </div>
          )}
        </Card>
      </div>
    );
  }

  /* ---- 3. missing ---- */
  if (sub === "missing") {
    return (
      <div>
        <SectionTitle sub="Decide what happens to incomplete rows. If they're a small share of the data (below your threshold) they're dropped. If dropping them would cost too much data (above the threshold) values are imputed instead — mean/median for numbers, most-common for categories.">
          <StepBadge n="4" done={!!stage} />Fix Missing Values
        </SectionTitle>
        <Card>
          <FlowBar inputCount={input?.length || 0} outputCount={stage?.data.length} />
          <PrevDownloads stages={stages} currentStep={sub} />
          {input && input.length > 0 && (() => {
            const cols = Object.keys(input[0]);
            const byCol = cols.map((c) => { const n = input.filter((r) => isMissing(r[c])).length; return { c, n, pct: (n / input.length) * 100 }; }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
            const incomplete = input.filter((r) => cols.some((c) => isMissing(r[c]))).length;
            const incPct = (incomplete / input.length) * 100;
            return (
              <div style={{ marginBottom: 20, padding: 14, background: "#FBF6EE", border: `1px solid ${C.line}`, borderRadius: 10 }}>
                <div style={{ fontSize: 12.5, marginBottom: byCol.length ? 12 : 0 }}>
                  <b style={{ color: incPct > missThreshold ? C.blue : C.sage, fontFamily: "'IBM Plex Mono',monospace" }}>{incPct.toFixed(1)}%</b> of rows ({incomplete} of {input.length}) have at least one missing value — currently above your {missThreshold}% threshold means <b>{incPct > missThreshold ? "impute" : "drop"}</b>.
                </div>
                {byCol.map(({ c, n, pct }) => (
                  <div key={c} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2, fontFamily: "'IBM Plex Mono',monospace" }}><span>{c}</span><span style={{ color: C.inkSoft }}>{n} · {pct.toFixed(1)}%</span></div>
                    <div style={{ height: 5, background: C.paper2, borderRadius: 4 }}><div style={{ width: `${pct}%`, height: "100%", background: C.clay, borderRadius: 4 }} /></div>
                  </div>
                ))}
                {!byCol.length && <span style={{ color: C.sage, fontSize: 12.5 }}>✓ no missing values in this data</span>}
              </div>
            );
          })()}
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Drop-vs-impute threshold: <span style={{ color: C.clay, fontFamily: "'IBM Plex Mono', monospace" }}>{missThreshold}%</span></div>
              <input type="range" min="1" max="60" value={missThreshold} onChange={(e) => setMissThreshold(+e.target.value)} style={{ width: "100%" }} />
              <p style={{ fontSize: 12, color: C.inkSoft, marginTop: 6, lineHeight: 1.5 }}>If incomplete rows ≤ {missThreshold}% of the data → drop them. If &gt; {missThreshold}% → keep rows and impute.</p>
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Imputation method (numeric)</div>
              <div style={{ display: "flex", gap: 8 }}>
                {["mean", "median"].map((m) => (
                  <button key={m} onClick={() => setMissMethod(m)} style={{ padding: "7px 16px", borderRadius: 8, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, textTransform: "capitalize",
                    border: `1.5px solid ${missMethod === m ? C.clay : C.line}`, background: missMethod === m ? C.clay : "#fff", color: missMethod === m ? "#fff" : C.ink }}>{m}</button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ marginTop: 18 }}><Btn onClick={run.missing}>Handle missing values</Btn></div>
          {stage && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
                <Stat label="Incomplete rows" value={stage.meta.affected} accent={C.clay} />
                <Stat label="Share missing" value={stage.meta.missPct.toFixed(1) + "%"} />
                <Stat label="Action taken" value={stage.meta.action} accent={stage.meta.action === "imputed" ? C.blue : C.sage} />
                <Stat label="Rows remaining" value={stage.data.length} accent={C.sage} />
              </div>
              <Pill tone={stage.meta.action === "imputed" ? "info" : "good"}>
                {stage.meta.action === "imputed"
                  ? `${stage.meta.missPct.toFixed(1)}% > ${missThreshold}% → imputed (dropping would lose too much)`
                  : `${stage.meta.missPct.toFixed(1)}% ≤ ${missThreshold}% → dropped incomplete rows`}
              </Pill>
              {stage.meta.fills && (
                <div style={{ margin: "14px 0", fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", color: C.inkSoft }}>
                  Fill values: {Object.entries(stage.meta.fills).map(([k, v]) => `${k}=${typeof v.value === "number" ? v.value : `"${v.value}"`} (${v.how})`).join("  ·  ")}
                </div>
              )}
              <div style={{ marginTop: 14 }}><DataTable data={stage.data} types={types} /></div>
              <RemovedPreview rows={stage.meta.removedRows} />
              <div style={{ marginTop: 14 }}><Btn kind="ghost" small onClick={() => downloadCSV(stage.data, "step4_missing.csv")}>↓ Download step 4 output</Btn></div>
              <NextBtn />
            </div>
          )}
        </Card>
      </div>
    );
  }

  /* ---- 4. outliers ---- */
  if (sub === "outliers") {
    return (
      <div>
        <SectionTitle sub="Discard extreme numeric values using the IQR rule — anything beyond 1.5×IQR below Q1 or above Q3 is treated as an outlier and removed.">
          <StepBadge n="3" done={!!stage} />Discard Outliers
        </SectionTitle>
        <Card>
          <FlowBar inputCount={input?.length || 0} outputCount={stage?.data.length} />
          <PrevDownloads stages={stages} currentStep={sub} />
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 13, color: C.inkSoft, marginBottom: 14 }}>Numeric columns scanned:&nbsp;{inputCols.filter((c) => types[c] === "numeric").map((c) => <Pill key={c}>{c}</Pill>)}</div>
          <Btn onClick={run.outliers}>Detect & remove outliers</Btn>
          {stage && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 }}>
                <Stat label="Outlier rows removed" value={stage.meta.removed} accent={C.clay} />
                <Stat label="Rows remaining" value={stage.data.length} accent={C.sage} />
              </div>
              <div style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", color: C.inkSoft, marginBottom: 14 }}>
                {Object.entries(stage.meta.perCol).map(([col, n]) => (
                  <div key={col}>{col}: removed {n} · bounds [{stage.meta.bounds[col].lower.toFixed(1)}, {stage.meta.bounds[col].upper.toFixed(1)}]</div>
                ))}
              </div>
              <DataTable data={stage.data} types={types} />
              <RemovedPreview rows={stage.meta.removedRows} />
              <div style={{ marginTop: 14 }}><Btn kind="ghost" small onClick={() => downloadCSV(stage.data, "step3_outliers.csv")}>↓ Download step 3 output</Btn></div>
              <NextBtn />
            </div>
          )}
        </Card>
      </div>
    );
  }

  /* ---- 5. validate ---- */
  if (sub === "validate") {
    return (
      <div>
        <SectionTitle sub="Final checks: every column holds one consistent type, no missing values remain, and logical rules hold — e.g. an end date can't fall before its start date. Any records that fail can be removed in one click, then the data is re-checked.">
          <StepBadge n="5" done={!!stage} />Validate
        </SectionTitle>
        <Card>
          <FlowBar inputCount={input?.length || 0} outputCount={stage?.data.length} />
          <PrevDownloads stages={stages} currentStep={sub} />
          {dateCols.length >= 2 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Date logic rule (end ≥ start)</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
                <select value={datePair.start} onChange={(e) => setDatePair({ ...datePair, start: e.target.value })} style={selStyle}>
                  <option value="">start date…</option>{dateCols.map((c) => <option key={c}>{c}</option>)}
                </select>
                <span>≤</span>
                <select value={datePair.end} onChange={(e) => setDatePair({ ...datePair, end: e.target.value })} style={selStyle}>
                  <option value="">end date…</option>{dateCols.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
          )}
          <Btn onClick={run.validate}>Run validation</Btn>
          {stage && (
            <div style={{ marginTop: 20 }}>
              <div style={{ marginBottom: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {stage.meta.passed
                  ? <Pill tone="good">✓ All checks passed — data is clean</Pill>
                  : <Pill tone="warn">⚠ {stage.meta.typeIssues.length + stage.meta.dateIssues.length + (stage.meta.missingLeft ? 1 : 0)} issue group(s) · {stage.meta.invalidCount} record(s) affected</Pill>}
                {stage.meta.removed > 0 && <Pill tone="info">removed {stage.meta.removed} invalid record(s)</Pill>}
              </div>
              <ul style={{ fontSize: 13, lineHeight: 1.7, color: C.ink, paddingLeft: 18, margin: 0 }}>
                {stage.meta.typeIssues.map((t, i) => <li key={"t" + i}><b>{t.col}</b>: {t.count} {t.kind}</li>)}
                {stage.meta.dateIssues.map((d, i) => <li key={"d" + i}><b>{d.end}</b> falls before <b>{d.start}</b> in {d.count} row(s)</li>)}
                {stage.meta.missingLeft > 0 && <li>{stage.meta.missingLeft} missing cell(s) still present</li>}
                {stage.meta.passed && <li style={{ color: C.sage }}>Types consistent · no missing cells · date logic holds</li>}
              </ul>
              {!stage.meta.passed && stage.meta.invalidCount > 0 && (
                <div style={{ marginTop: 16, padding: 14, background: "#FBF6EE", border: `1px solid ${C.line}`, borderRadius: 10 }}>
                  <div style={{ fontSize: 13, marginBottom: 10 }}>Fix by removing the <b>{stage.meta.invalidCount}</b> record(s) that fail these checks. Everything that passes is kept.</div>
                  <Btn onClick={run.removeInvalid}>Remove {stage.meta.invalidCount} invalid record(s)</Btn>
                </div>
              )}
              <div style={{ marginTop: 16 }}><DataTable data={stage.data} types={types} /></div>
              <RemovedPreview rows={stage.meta.removedRows} />
              <div style={{ marginTop: 14 }}><Btn kind="ghost" small onClick={() => downloadCSV(stage.data, "cleaned_data.csv")}>↓ Download final clean data</Btn></div>
              <NextBtn />
            </div>
          )}
        </Card>
      </div>
    );
  }
  return null;
}
const selStyle = { padding: "7px 12px", borderRadius: 8, border: `1.5px solid ${C.line}`, background: "#fff", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: C.ink };

/* ============================================================
   TAB 3 — ANALYZE
   ============================================================ */
function Analyze({ sub, data, columns, types, isClean }) {
  if (!data) return <Empty msg="No data yet." />;
  return (
    <div>
      {!isClean && <div style={{ marginBottom: 16 }}><Pill tone="warn">Heads up — analyzing data that hasn't passed validation yet. Finish the cleaning steps for trustworthy results.</Pill></div>}
      {sub === "patterns" && <Patterns data={data} columns={columns} types={types} />}
      {sub === "correlation" && <Correlation data={data} columns={columns} types={types} />}
      {sub === "anomaly" && <Anomaly data={data} columns={columns} types={types} />}
    </div>
  );
}

function MiniBox({ s }) {
  const range = s.max - s.min || 1;
  const pos = (x) => ((x - s.min) / range) * 100;
  const meanPos = pos(s.mean);
  return (
    <div style={{ margin: "12px 0 10px" }}>
      <div style={{ position: "relative", height: 26 }}>
        <div style={{ position: "absolute", top: 12, left: 0, right: 0, height: 2, background: C.line }} />
        <div style={{ position: "absolute", top: 6, left: `${pos(s.q1)}%`, width: `${pos(s.q3) - pos(s.q1)}%`, height: 14, background: "rgba(189,86,56,0.18)", border: `1.5px solid ${C.clay}`, borderRadius: 3 }} />
        <div style={{ position: "absolute", top: 4, left: `${pos(s.median)}%`, width: 2.5, height: 18, background: C.clayDk }} title={`median ${s.median.toFixed(1)}`} />
        <div style={{ position: "absolute", top: 9, left: `calc(${meanPos}% - 3px)`, width: 6, height: 6, borderRadius: "50%", background: C.blue }} title={`mean ${s.mean.toFixed(1)}`} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.inkSoft, fontFamily: "'IBM Plex Mono',monospace", marginTop: 2 }}>
        <span>{(+s.min.toFixed(1))}</span><span>median {(+s.median.toFixed(1))}</span><span>{(+s.max.toFixed(1))}</span>
      </div>
    </div>
  );
}

function Patterns({ data, columns, types }) {
  const headlines = useMemo(() => generateHeadlines(data, columns, types), [data, columns, types]);
  const cards = useMemo(() => columns.map((col) => {
    if (types[col] === "numeric") {
      const nums = data.map((r) => toNum(r[col])).filter((n) => !isNaN(n));
      return { col, type: "numeric", s: nums.length ? numericSummary(nums) : null };
    }
    const vals = data.map((r) => (isMissing(r[col]) ? null : String(r[col]))).filter((v) => v !== null);
    return { col, type: types[col], s: catSummary(vals) };
  }), [data, columns, types]);

  return (
    <div>
      <SectionTitle sub="A read on the shape of every column — distribution, spread and concentration — with the most notable findings called out first.">Patterns & Trends</SectionTitle>

      {headlines.length > 0 && (
        <Card style={{ marginBottom: 18, background: "#FBF6EE" }}>
          <div style={{ fontFamily: "'Fraunces',serif", fontSize: 17, fontWeight: 600, marginBottom: 10 }}>What stands out</div>
          <div style={{ display: "grid", gap: 8 }}>
            {headlines.map((h, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13.5, lineHeight: 1.5 }}>
                <span style={{ color: C.clay, fontSize: 15 }}>{h.icon}</span><span>{h.text}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 16 }}>
        {cards.map((p) => (
          <Card key={p.col} style={{ padding: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 14 }}>{p.col}</span><Pill tone="info">{p.type}</Pill>
            </div>
            {p.type === "numeric" ? (p.s ? (
              <div>
                <MiniBox s={p.s} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "6px 14px", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, margin: "10px 0" }}>
                  {[["min", p.s.min], ["Q1", p.s.q1], ["median", p.s.median], ["mean", p.s.mean], ["Q3", p.s.q3], ["max", p.s.max], ["std", p.s.std], ["IQR", p.s.iqr], ["CV", (p.s.cv * 100)]].map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: C.inkSoft }}>{k}</span><b>{k === "CV" ? (+v).toFixed(0) + "%" : (+(+v).toFixed(2))}</b></div>
                  ))}
                </div>
                <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.5, paddingTop: 8, borderTop: `1px solid ${C.paper2}` }}>{interpretNumeric(p.s)}</div>
              </div>
            ) : <span style={{ color: C.inkSoft, fontSize: 13 }}>No numeric values.</span>) : (
              <div>
                <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 8, fontFamily: "'IBM Plex Mono', monospace" }}>{p.s.distinct} distinct values · top {Math.min(p.s.top.length, 6)}</div>
                {p.s.top.map((t) => (
                  <div key={t.value} style={{ marginBottom: 7 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 2 }}><span style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{t.value}</span><span style={{ color: C.inkSoft }}>{t.count} · {t.pct.toFixed(1)}%</span></div>
                    <div style={{ height: 6, background: C.paper2, borderRadius: 4 }}><div style={{ width: `${t.pct}%`, height: "100%", background: C.clay, borderRadius: 4 }} /></div>
                  </div>
                ))}
                <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.5, paddingTop: 8, marginTop: 4, borderTop: `1px solid ${C.paper2}` }}>{interpretCategorical(p.s)}</div>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function Correlation({ data, columns, types }) {
  const numericCols = columns.filter((c) => types[c] === "numeric");
  const matrix = useMemo(() => correlationMatrix(data, numericCols), [data, numericCols]);
  if (numericCols.length < 2) return <Empty msg="Need at least two numeric columns to compute correlation." />;
  const color = (v) => (v >= 0 ? `rgba(79,111,90,${Math.abs(v)})` : `rgba(189,86,56,${Math.abs(v)})`);
  const pairs = [];
  for (let i = 0; i < numericCols.length; i++)
    for (let j = i + 1; j < numericCols.length; j++)
      pairs.push({ a: numericCols[i], b: numericCols[j], r: matrix[i][numericCols[j]] });
  const ranked = _.orderBy(pairs, (p) => Math.abs(p.r), "desc");
  const notable = ranked.filter((p) => Math.abs(p.r) >= 0.3);

  return (
    <div>
      <SectionTitle sub="How strongly each pair of numeric variables moves together, measured by Pearson's r (−1 to +1). Sage = move in the same direction, clay = opposite; the deeper the colour, the stronger the link.">Correlation</SectionTitle>

      <Card style={{ overflow: "auto", marginBottom: 18 }}>
        <table style={{ borderCollapse: "collapse", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5 }}>
          <thead><tr><th style={{ padding: 8 }}></th>{numericCols.map((c) => <th key={c} style={{ padding: 8, color: C.inkSoft }}>{c}</th>)}</tr></thead>
          <tbody>{matrix.map((row, i) => (
            <tr key={row.col}><td style={{ padding: 8, color: C.inkSoft, fontWeight: 600 }}>{row.col}</td>
              {numericCols.map((c) => (
                <td key={c} style={{ padding: "10px 14px", textAlign: "center", background: color(row[c]), color: Math.abs(row[c]) > 0.5 ? "#fff" : C.ink, fontWeight: 600 }}>{row[c].toFixed(2)}</td>
              ))}</tr>
          ))}</tbody>
        </table>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14, fontSize: 11.5, color: C.inkSoft, fontFamily: "'IBM Plex Mono',monospace" }}>
          <span>−1</span>
          <div style={{ flex: 1, maxWidth: 220, height: 10, borderRadius: 5, background: `linear-gradient(to right, ${C.clay}, ${C.paper2}, ${C.sage})` }} />
          <span>+1</span>
          <span style={{ marginLeft: 8 }}>opposite ← → together</span>
        </div>
      </Card>

      <Card>
        <div style={{ fontWeight: 600, marginBottom: 4, fontFamily: "'Fraunces',serif", fontSize: 17 }}>Notable relationships</div>
        <div style={{ fontSize: 11.5, color: C.inkSoft, marginBottom: 14 }}>Based on {data.length} rows. Correlation shows association, not causation.</div>
        {notable.length ? notable.slice(0, 8).map((p, i) => (
          <div key={i} style={{ marginBottom: 13 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
              <Pill tone={p.r > 0 ? "good" : "warn"}>{p.r > 0 ? "+" : ""}{p.r.toFixed(2)}</Pill>
              <span style={{ fontSize: 13.5 }}><b style={{ fontFamily: "'IBM Plex Mono',monospace" }}>{p.a}</b> &amp; <b style={{ fontFamily: "'IBM Plex Mono',monospace" }}>{p.b}</b></span>
              <span style={{ fontSize: 12.5, color: C.inkSoft }}>— {corrStrength(p.r)} {p.r > 0 ? "positive" : "negative"} link; as {p.a} rises, {p.b} tends to {p.r > 0 ? "rise" : "fall"}.</span>
            </div>
            <div style={{ height: 6, background: C.paper2, borderRadius: 4 }}>
              <div style={{ width: `${Math.abs(p.r) * 100}%`, height: "100%", background: p.r > 0 ? C.sage : C.clay, borderRadius: 4 }} />
            </div>
          </div>
        )) : <p style={{ color: C.inkSoft, fontSize: 13 }}>No correlations above 0.3 — these variables look largely independent of one another.</p>}
      </Card>
    </div>
  );
}

function Anomaly({ data, columns, types }) {
  const numericCols = columns.filter((c) => types[c] === "numeric");
  const res = useMemo(() => findAnomalies(data, numericCols, types, columns), [data, numericCols, types, columns]);
  return (
    <div>
      <SectionTitle sub="Points that don't fit. Numeric anomalies are values more than 3 standard deviations from the mean; categorical anomalies are values that appear only once.">Anomaly Detection</SectionTitle>
      {!res.numeric.length && !res.rare.length && <Card><Pill tone="good">✓ No statistical anomalies detected</Pill></Card>}
      {res.numeric.map((a) => (
        <Card key={a.col} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <b style={{ fontFamily: "'IBM Plex Mono',monospace" }}>{a.col}</b><Pill tone="warn">{a.count} numeric anomal{a.count === 1 ? "y" : "ies"}</Pill>
          </div>
          <div style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", color: C.inkSoft }}>
            {a.examples.map((e, i) => <span key={i}>row {e.row}: {e.value} (z={e.z})&nbsp;&nbsp;</span>)}
          </div>
        </Card>
      ))}
      {res.rare.map((a) => (
        <Card key={a.col} style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <b style={{ fontFamily: "'IBM Plex Mono',monospace" }}>{a.col}</b><Pill tone="info">{a.count} rare value(s)</Pill>
          </div>
          <div style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono',monospace", color: C.inkSoft }}>appears once: {a.examples.join(", ")}</div>
        </Card>
      ))}
    </div>
  );
}

/* ============================================================
   TAB 4 — VISUALIZATION
   ============================================================ */
function Viz({ data, columns, types, numericCols, dateCols, textCols }) {
  const [chartType, setChartType] = useState("bar");
  const [cat, setCat] = useState("");
  const [num, setNum] = useState("");
  const [num2, setNum2] = useState("");
  const [dx, setDx] = useState("");
  const chartRef = useRef(null);

  // effective columns (fall back to sensible defaults if state is empty/stale)
  const catCol = cat && columns.includes(cat) ? cat : (textCols[0] || columns[0] || "");
  const numCol = num && numericCols.includes(num) ? num : (numericCols[0] || "");
  const num2Col = num2 && numericCols.includes(num2) ? num2 : (numericCols[1] || numericCols[0] || "");
  const dateXCol = dx && dateCols.includes(dx) ? dx : (dateCols[0] || "");

  const barData = useMemo(() => {
    if (!data || !catCol) return [];
    const counts = _.countBy(data.map((r) => (isMissing(r[catCol]) ? "(missing)" : String(r[catCol]))));
    return _.orderBy(Object.entries(counts).map(([name, value]) => ({ name, value })), "value", "desc").slice(0, 12);
  }, [data, catCol]);

  const histData = useMemo(() => {
    if (!data || !numCol) return [];
    const nums = data.map((r) => toNum(r[numCol])).filter((n) => !isNaN(n));
    if (!nums.length) return [];
    const min = Math.min(...nums), max = Math.max(...nums), bins = 8, w = (max - min) / bins || 1;
    const arr = Array.from({ length: bins }, (_, i) => ({ name: `${Math.round(min + i * w)}`, value: 0 }));
    nums.forEach((n) => { const idx = Math.min(bins - 1, Math.floor((n - min) / w)); arr[idx].value++; });
    return arr;
  }, [data, numCol]);

  const scatterData = useMemo(() => {
    if (!data || !numCol || !num2Col) return [];
    return data.map((r) => ({ x: toNum(r[numCol]), y: toNum(r[num2Col]) })).filter((p) => !isNaN(p.x) && !isNaN(p.y));
  }, [data, numCol, num2Col]);

  const lineData = useMemo(() => {
    if (!data || !dateXCol || !numCol) return [];
    const groups = _.groupBy(data.filter((r) => !isMissing(r[dateXCol])), (r) => r[dateXCol]);
    const rows = Object.entries(groups).map(([date, rs]) => {
      const nums = rs.map((r) => toNum(r[numCol])).filter((n) => !isNaN(n));
      return { name: date, value: nums.length ? +mean(nums).toFixed(2) : 0 };
    });
    return _.sortBy(rows, (r) => new Date(r.name).getTime());
  }, [data, dateXCol, numCol]);

  if (!data) return <Empty msg="No data yet." />;

  const ALL_TYPES = [
    { id: "bar", label: "Bar", icon: "▦", ok: columns.length > 0, hint: "Frequency of each category" },
    { id: "histogram", label: "Histogram", icon: "▮", ok: numericCols.length > 0, hint: "Distribution of a number" },
    { id: "line", label: "Line", icon: "〜", ok: dateCols.length > 0 && numericCols.length > 0, hint: "A measure over time" },
    { id: "scatter", label: "Scatter", icon: "✦", ok: numericCols.length >= 2, hint: "Two measures vs each other" },
    { id: "pie", label: "Pie", icon: "◔", ok: columns.length > 0, hint: "Share of each category" },
  ];
  const active = ALL_TYPES.find((t) => t.id === chartType && t.ok) ? chartType : (ALL_TYPES.find((t) => t.ok) || {}).id;

  const scrollToChart = () => setTimeout(() => { if (chartRef.current) chartRef.current.scrollIntoView({ behavior: "smooth", block: "center" }); }, 60);

  const ideas = [];
  if (numericCols.length) ideas.push({ icon: "▮", t: `Distribution of ${numericCols[0]}`, d: "shape, skew and spread", go: () => { setChartType("histogram"); setNum(numericCols[0]); scrollToChart(); } });
  if (textCols.length) ideas.push({ icon: "▦", t: `Bar chart of ${textCols[0]}`, d: "which groups dominate", go: () => { setChartType("bar"); setCat(textCols[0]); scrollToChart(); } });
  if (numericCols.length >= 2) ideas.push({ icon: "✦", t: `${numericCols[0]} vs ${numericCols[1]}`, d: "relationship between two measures", go: () => { setChartType("scatter"); setNum(numericCols[0]); setNum2(numericCols[1]); scrollToChart(); } });
  if (dateCols.length && numericCols.length) ideas.push({ icon: "〜", t: `${numericCols[0]} over ${dateCols[0]}`, d: "trend across time", go: () => { setChartType("line"); setNum(numericCols[0]); setDx(dateCols[0]); scrollToChart(); } });
  if (textCols.length) ideas.push({ icon: "◔", t: `Share of ${textCols[0]}`, d: "category proportions", go: () => { setChartType("pie"); setCat(textCols[0]); scrollToChart(); } });

  return (
    <div>
      <SectionTitle sub="Pick a chart type, choose the columns it should use, and it renders live from the cleaned data. The suggestions below set it up for you in one click.">Data Visualization</SectionTitle>

      <Card style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 12, fontFamily: "'Fraunces',serif", fontSize: 17 }}>Suggested for this dataset</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))", gap: 10 }}>
          {ideas.map((it, i) => (
            <button key={i} onClick={it.go} style={{ textAlign: "left", border: `1px solid ${C.line}`, borderRadius: 10, padding: 14, background: "#fff", cursor: "pointer", transition: "all .15s" }}
              onMouseOver={(e) => { e.currentTarget.style.borderColor = C.clay; e.currentTarget.style.background = "#FBF6EE"; }}
              onMouseOut={(e) => { e.currentTarget.style.borderColor = C.line; e.currentTarget.style.background = "#fff"; }}>
              <div style={{ fontSize: 20, color: C.clay }}>{it.icon}</div>
              <div style={{ fontWeight: 600, fontSize: 13.5, margin: "4px 0 2px", fontFamily: "'IBM Plex Mono',monospace" }}>{it.t}</div>
              <div style={{ fontSize: 12, color: C.inkSoft, lineHeight: 1.4 }}>{it.d}</div>
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Chart type</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 }}>
          {ALL_TYPES.map((t) => (
            <button key={t.id} disabled={!t.ok} onClick={() => { setChartType(t.id); scrollToChart(); }} title={t.ok ? t.hint : "Not available for this data"}
              style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 14px", borderRadius: 9, cursor: t.ok ? "pointer" : "not-allowed",
                fontFamily: "'IBM Plex Sans',sans-serif", fontSize: 13, fontWeight: 600, opacity: t.ok ? 1 : 0.4,
                border: `1.5px solid ${active === t.id ? C.clay : C.line}`, background: active === t.id ? C.clay : "#fff", color: active === t.id ? "#fff" : C.ink }}>
              <span style={{ fontSize: 15 }}>{t.icon}</span>{t.label}
            </button>
          ))}
        </div>

        {/* contextual column controls */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 16, fontSize: 12.5, color: C.inkSoft }}>
          {(active === "bar" || active === "pie") && <label>Category column: <Sel value={catCol} set={setCat} opts={columns} /></label>}
          {active === "histogram" && <label>Numeric column: <Sel value={numCol} set={setNum} opts={numericCols} /></label>}
          {active === "scatter" && <><label>X: <Sel value={numCol} set={setNum} opts={numericCols} /></label><label>Y: <Sel value={num2Col} set={setNum2} opts={numericCols} /></label></>}
          {active === "line" && <><label>Date: <Sel value={dateXCol} set={setDx} opts={dateCols} /></label><label>Measure (avg): <Sel value={numCol} set={setNum} opts={numericCols} /></label></>}
        </div>

        {/* the chart */}
        <div ref={chartRef}>
        {active === "bar" && (
          <ResponsiveContainer width="100%" height={335}>
            <BarChart data={barData} margin={{ top: 10, right: 24, bottom: 26, left: 18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: catCol, position: "insideBottom", offset: -14, style: { fontSize: 12.5, fill: C.ink, fontWeight: 600 } }} />
              <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: "Count", angle: -90, position: "insideLeft", style: { fontSize: 12.5, fill: C.ink, fontWeight: 600, textAnchor: "middle" } }} />
              <Tooltip /><Bar dataKey="value" fill={C.clay} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
        {active === "histogram" && (numCol ? (
          <ResponsiveContainer width="100%" height={335}>
            <BarChart data={histData} margin={{ top: 10, right: 24, bottom: 26, left: 18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: numCol, position: "insideBottom", offset: -14, style: { fontSize: 12.5, fill: C.ink, fontWeight: 600 } }} />
              <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: "Frequency", angle: -90, position: "insideLeft", style: { fontSize: 12.5, fill: C.ink, fontWeight: 600, textAnchor: "middle" } }} />
              <Tooltip /><Bar dataKey="value" fill={C.sage} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : <Empty msg="No numeric column available." />)}
        {active === "line" && (dateXCol && numCol ? (
          <ResponsiveContainer width="100%" height={335}>
            <LineChart data={lineData} margin={{ top: 10, right: 24, bottom: 26, left: 18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: C.inkSoft }} label={{ value: dateXCol, position: "insideBottom", offset: -14, style: { fontSize: 12.5, fill: C.ink, fontWeight: 600 } }} />
              <YAxis tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: `Avg ${numCol}`, angle: -90, position: "insideLeft", style: { fontSize: 12.5, fill: C.ink, fontWeight: 600, textAnchor: "middle" } }} />
              <Tooltip /><Line type="monotone" dataKey="value" stroke={C.blue} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : <Empty msg="Need a date column and a numeric column." />)}
        {active === "scatter" && (numCol && num2Col ? (
          <ResponsiveContainer width="100%" height={335}>
            <ScatterChart margin={{ top: 10, right: 24, bottom: 26, left: 18 }}>
              <CartesianGrid stroke={C.line} />
              <XAxis type="number" dataKey="x" name={numCol} tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: numCol, position: "insideBottom", offset: -14, style: { fontSize: 12.5, fill: C.ink, fontWeight: 600 } }} />
              <YAxis type="number" dataKey="y" name={num2Col} tick={{ fontSize: 11, fill: C.inkSoft }} label={{ value: num2Col, angle: -90, position: "insideLeft", style: { fontSize: 12.5, fill: C.ink, fontWeight: 600, textAnchor: "middle" } }} />
              <Tooltip cursor={{ strokeDasharray: "3 3" }} /><Scatter data={scatterData} fill={C.blue} />
            </ScatterChart>
          </ResponsiveContainer>
        ) : <Empty msg="Need two numeric columns." />)}
        {active === "pie" && (
          <ResponsiveContainer width="100%" height={320}>
            <PieChart>
              <Pie data={barData.slice(0, 6)} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label={{ fontSize: 11 }}>
                {barData.slice(0, 6).map((e, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
              </Pie><Tooltip /><Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        )}
        </div>
      </Card>
    </div>
  );
}
const Sel = ({ value, set, opts }) => (
  <select value={value} onChange={(e) => set(e.target.value)} style={{ ...selStyle, padding: "5px 8px", fontSize: 12 }}>
    {opts.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);

/* ============================================================
   TAB 5 — RESULT
   ============================================================ */
function Result({ raw, cleanedData, columns, types, stages, numericCols, textCols, dateCols }) {
  if (!raw) return <Empty msg="No data yet." />;
  const before = raw.data.length, after = cleanedData.length;
  const removed = before - after;
  const completed = STEP_ORDER.filter((s) => stages[s]);

  const log = [];
  if (stages.dedup) log.push(`Removed ${stages.dedup.meta.removedDupes} duplicate row(s)${stages.dedup.meta.droppedCols.length ? ` and dropped ${stages.dedup.meta.droppedCols.length} column(s)` : ""}.`);
  if (stages.structural) log.push(`Standardized ${stages.structural.meta.changes.length} inconsistent text value(s).`);
  if (stages.missing) log.push(stages.missing.meta.action === "imputed" ? `Imputed missing values (${stages.missing.meta.missPct.toFixed(1)}% of rows were incomplete).` : `Dropped ${stages.missing.meta.affected} incomplete row(s).`);
  if (stages.outliers) log.push(`Discarded ${stages.outliers.meta.removed} outlier row(s) via IQR.`);
  if (stages.validate) log.push(stages.validate.meta.passed ? "Validation passed — types consistent, no missing cells, date logic holds." : "Validation flagged remaining issues (see Validate tab).");

  const pats = useMemo(() => topPatterns(cleanedData, columns, types), [cleanedData, columns, types]);
  const corr = useMemo(() => numericCols.length >= 2 ? correlationMatrix(cleanedData, numericCols) : [], [cleanedData, numericCols]);
  const strongPairs = [];
  for (let i = 0; i < numericCols.length; i++) for (let j = i + 1; j < numericCols.length; j++) {
    const r = corr[i] ? corr[i][numericCols[j]] : 0;
    if (Math.abs(r) >= 0.3) strongPairs.push({ a: numericCols[i], b: numericCols[j], r });
  }
  const topStrong = _.orderBy(strongPairs, (p) => Math.abs(p.r), "desc").slice(0, 3);
  const summaryBar = useMemo(() => {
    const c = textCols[0]; if (!c) return [];
    const counts = _.countBy(cleanedData.map((r) => String(r[c])));
    return _.orderBy(Object.entries(counts).map(([name, value]) => ({ name, value })), "value", "desc").slice(0, 6);
  }, [cleanedData, textCols]);

  return (
    <div>
      <SectionTitle sub="The full story: what the raw data was, what cleaning did to it, what the analysis found, and a snapshot view.">Result & Report</SectionTitle>

      <div className="cr-no-print" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Btn onClick={() => window.print()}>↓ Download PDF report</Btn>
        <span style={{ fontSize: 12, color: C.inkSoft }}>Opens your print dialog — choose “Save as PDF”.</span>
      </div>

      <Card style={{ marginBottom: 18, background: "#FBF6EE" }}>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <Stat label="Rows in" value={before} />
          <Stat label="Rows out" value={after} accent={C.sage} />
          <Stat label="Removed" value={removed + ` (${before ? ((removed / before) * 100).toFixed(0) : 0}%)`} accent={C.clay} />
          <Stat label="Steps done" value={`${completed.length}/5`} accent={C.blue} />
          <Stat label="Status" value={stages.validate?.meta.passed ? "Clean ✓" : "In progress"} accent={stages.validate?.meta.passed ? C.sage : C.gold} />
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 18 }}>
        <Card>
          <H>Cleaning log</H>
          {log.length ? <ol style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.8, margin: 0 }}>{log.map((l, i) => <li key={i}>{l}</li>)}</ol> : <p style={{ color: C.inkSoft, fontSize: 13 }}>No cleaning steps run yet.</p>}
        </Card>
        <Card>
          <H>Key insights</H>
          <ul style={{ paddingLeft: 18, fontSize: 13.5, lineHeight: 1.8, margin: 0 }}>
            {topStrong.length ? topStrong.map((p, i) => <li key={i}><b>{p.a}</b> & <b>{p.b}</b>: {p.r > 0 ? "positive" : "negative"} correlation ({p.r.toFixed(2)})</li>)
              : <li style={{ color: C.inkSoft }}>No strong correlations among numeric fields.</li>}
            {pats.filter((p) => p.type !== "numeric").slice(0, 2).map((p) => p.top && p.top[0] && <li key={p.col}>Most common <b>{p.col}</b>: "{p.top[0].value}" ({p.top[0].pct}%)</li>)}
            {numericCols.slice(0, 1).map((c) => { const s = pats.find((p) => p.col === c); return s && <li key={c}>Avg <b>{c}</b> ≈ {s.stats.mean} (median {s.stats.median})</li>; })}
          </ul>
        </Card>
      </div>

      {summaryBar.length > 0 && (
        <Card style={{ marginTop: 18 }}>
          <H>Snapshot of the full dataset</H>
          <p style={{ fontSize: 12.5, color: C.inkSoft, marginTop: -6, marginBottom: 10 }}>Distribution of <b>{textCols[0]}</b> across all {after} cleaned rows.</p>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={summaryBar} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.line} /><XAxis type="number" tick={{ fontSize: 11, fill: C.inkSoft }} /><YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: C.inkSoft }} width={90} /><Tooltip />
              <Bar dataKey="value" fill={C.clay} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      <Card style={{ marginTop: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <H>Clean data</H>
          <Btn small onClick={() => downloadCSV(cleanedData, "final_report_data.csv")}>↓ Download clean data</Btn>
        </div>
        <DataTable data={cleanedData} columns={columns} types={types} max={20} />
      </Card>
    </div>
  );
}
const H = ({ children }) => <div style={{ fontFamily: "'Fraunces',serif", fontSize: 18, fontWeight: 600, marginBottom: 12 }}>{children}</div>;

const Empty = ({ msg }) => (
  <Card style={{ textAlign: "center", padding: 40, color: C.inkSoft, fontStyle: "italic" }}>{msg}</Card>
);
