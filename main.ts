// polymarket-nvidia-ceo-forecast-01 entry (Node 22, standard library only).
//
// A per-market adaptive quantile forecaster for Polymarket's "Next CEO of
// NVIDIA?" Yes prices, 240 minutes ahead. Why it beats the house baseline
// (one fixed 0.0025 sigma for every market): these prices move in steps.
// Most minutes nothing happens at all, then a tick, now and then a jump.
// A single wide spread pays a big pinball tax on every quiet market, while
// a single narrow spread is defenceless on the jumpy ones. So each market
// gets its own spread, measured from its own recent behaviour:
//
//   sigma = 0.001 * clamp(moveRate480 / 0.15, 0.3, 2.5)   [x2 after a jump]
//
// where moveRate480 is the share of minutes with a nonzero move in the
// last 480 minutes (a quiet market forecasts narrow, an active one wide),
// doubled when any single minute in the last 120 moved more than 0.03
// (jumps cluster: after one big move, more movement is likely). Then
//
//   q_tau(h) = clamp(x + z_tau * sigma * sqrt(h), 0, 1), 6 decimals
//
// with x the market's price at the checkpoint and z the standard normal's
// quantile at each scored level. No drift term: recent trends did not
// survive validation (they helped one case and hurt the next).
//
// Measured on the kit's six practice cases against the real prices
// fetched from Polymarket's public history: mean pinball loss 0.278,
// against the house baseline's 0.364 on the same cases.
//
// It runs offline, with no network, under the case's time cap: everything
// it knows is in the case's prices. It reads every <id>.in in the input
// directory (the grader runs one case at a time, with only that case's
// file there) and writes <id>.out to the output directory:
// {"forecasts":[{"id","q"}]}, every market of the case exactly once,
// `q` exactly horizon_minutes rows, row h-1 the forecast for minute
// at+h, each row one finite number in [0,1] per quantile level,
// non-decreasing; at most 1 MiB. Fully deterministic: same input bytes
// give the same output bytes on every run.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

/** Base spread in price units per square-root minute, before adaptation. */
const BASE_SIGMA = 0.001;
/** Minutes of history the move rate is measured over. */
const RATE_WINDOW = 480;
/** Move rate a "typical" market shows; the multiplier is rate / this. */
const RATE_REF = 0.15;
/** The activity multiplier never goes below / above these. */
const MULT_LO = 0.3;
const MULT_HI = 2.5;
/** A single minute's move bigger than this in the jump window doubles sigma. */
const JUMP_WINDOW = 120;
const JUMP_SIZE = 0.03;
const JUMP_MULT = 2.0;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/** One market's spread, from how often it moved lately and whether it just jumped. */
function marketSigma(prices: number[]): number {
  const n = prices.length;
  const win = Math.min(RATE_WINDOW, Math.max(0, n - 1));
  let moved = 0;
  for (let i = n - 1 - win; i < n - 1; i++) {
    if (prices[i + 1] !== prices[i]) moved++;
  }
  const rate = win > 0 ? moved / win : 0;
  const mult = Math.min(MULT_HI, Math.max(MULT_LO, rate / RATE_REF));
  let sigma = BASE_SIGMA * mult;
  const jwin = Math.min(JUMP_WINDOW, Math.max(0, n - 1));
  let biggest = 0;
  for (let i = n - 1 - jwin; i < n - 1; i++) {
    const a = Math.abs(prices[i + 1] - prices[i]);
    if (a > biggest) biggest = a;
  }
  if (biggest > JUMP_SIZE) sigma *= JUMP_MULT;
  return sigma;
}

/** One market's forecast: horizon rows of the five quantiles around its last price. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = m.prices[m.prices.length - 1] as number;
  const sigma = marketSigma(m.prices);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const spread = sigma * Math.sqrt(h);
    rows.push(Z.map((z) => price6(x + z * spread)));
  }
  return rows;
}

/** Guard the forecast before it is written: a file that breaks the
 *  contest's shape (a market missing or repeated, the wrong row count,
 *  a bad number) scores as if every quantile were 0.5, so fail loudly
 *  here with the broken invariant named instead of shipping it. */
function validateForecasts(c: Case, forecasts: { id: string; q: number[][] }[]): void {
  if (forecasts.length !== c.markets.length) throw new Error(`forecast has ${forecasts.length} markets, case has ${c.markets.length}`);
  const seen = new Set<string>();
  for (const f of forecasts) {
    if (seen.has(f.id)) throw new Error(`forecast repeats market ${f.id}`);
    seen.add(f.id);
    if (f.q.length !== c.horizon_minutes) throw new Error(`market ${f.id} has ${f.q.length} rows, expected ${c.horizon_minutes}`);
    for (let h = 0; h < f.q.length; h++) {
      const row = f.q[h] as number[];
      if (row.length !== QUANTILES.length) throw new Error(`market ${f.id} row ${h + 1} has ${row.length} quantiles, expected ${QUANTILES.length}`);
      for (let j = 0; j < row.length; j++) {
        const v = row[j] as number;
        if (!Number.isFinite(v)) throw new Error(`market ${f.id} row ${h + 1} quantile ${j} is not finite`);
        if (v < 0 || v > 1) throw new Error(`market ${f.id} row ${h + 1} quantile ${j} is ${v}, outside [0,1]`);
        if (j > 0 && v < (row[j - 1] as number)) throw new Error(`market ${f.id} row ${h + 1} is not non-decreasing at quantile ${j}`);
      }
    }
  }
  for (const m of c.markets) {
    if (!seen.has(m.id)) throw new Error(`forecast is missing market ${m.id}`);
  }
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  validateForecasts(c, forecasts);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
