import type { Candidate } from "./gauntlet.js";

/**
 * The strategy space an AI — or a person — actually proposes.
 *
 * These are deliberately ordinary: moving-average crossovers, RSI reversion, channel breakouts,
 * Bollinger dips, momentum lookbacks, and a trend/oscillator combo. Exotic rules are not the point.
 * The point is that this is the space real candidate generators search, and the gauntlet in
 * `gauntlet.ts` cannot tell these apart from noise when they are fitted to noise.
 */

function sma(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < x.length; i++) {
    sum += x[i];
    if (i >= n) sum -= x[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function rsi(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let up = 0, down = 0;
  for (let i = 1; i < x.length; i++) {
    const delta = x[i] - x[i - 1];
    const gain = Math.max(delta, 0);
    const loss = Math.max(-delta, 0);
    if (i <= n) {
      up += gain / n;
      down += loss / n;
    } else {
      up = (up * (n - 1) + gain) / n;
      down = (down * (n - 1) + loss) / n;
    }
    if (i >= n) out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  }
  return out;
}

function rollingStdev(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = n; i < x.length; i++) {
    const w = x.slice(i - n, i);
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1));
  }
  return out;
}

export type Family = "ma_cross" | "rsi_revert" | "breakout" | "bollinger" | "momentum" | "trend_dip";

/** A parameterized rule. `jitter` perturbs the numbers; the rule shape stays fixed. */
class RuleCandidate implements Candidate {
  constructor(readonly family: Family, readonly params: number[]) {}

  describe(): string {
    const p = this.params;
    const r = (i: number) => Math.round(p[i]);
    switch (this.family) {
      case "ma_cross": return `MA cross ${r(0)}/${r(1)}`;
      case "rsi_revert": return `RSI(${r(0)}) buy<${r(1)} sell>${r(2)}`;
      case "breakout": return `breakout ${r(0)}d, exit ${r(1)}d`;
      case "bollinger": return `Bollinger ${r(0)}d ${p[1].toFixed(1)}sd`;
      case "momentum": return `momentum ${r(0)}d`;
      case "trend_dip": return `above SMA${r(0)} & RSI(${r(1)})<${r(2)}`;
    }
  }

  jitter(rand: () => number): Candidate {
    const nudged = this.params.map((x, i) => {
      const v = x * (1 + (rand() - 0.5) * 0.2); // ±10%
      // The Bollinger width is a real number; every other parameter is a bar count.
      return this.family === "bollinger" && i === 1 ? Math.max(0.5, v) : Math.max(2, Math.round(v));
    });
    return new RuleCandidate(this.family, nudged);
  }

  signals(close: number[]): number[] {
    const n = close.length;
    const sig = new Array(n).fill(0);
    const p = this.params;

    switch (this.family) {
      case "ma_cross": {
        const fast = sma(close, Math.round(p[0]));
        const slow = sma(close, Math.round(p[1]));
        for (let i = 0; i < n; i++) sig[i] = !Number.isNaN(slow[i]) && fast[i] > slow[i] ? 1 : 0;
        break;
      }
      case "rsi_revert": {
        const r = rsi(close, Math.round(p[0]));
        let pos = 0;
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(r[i])) continue;
          if (pos === 0 && r[i] < p[1]) pos = 1;
          else if (pos === 1 && r[i] > p[2]) pos = 0;
          sig[i] = pos;
        }
        break;
      }
      case "breakout": {
        const enter = Math.round(p[0]);
        const exit = Math.round(p[1]);
        let pos = 0;
        for (let i = Math.max(enter, exit); i < n; i++) {
          let hh = -Infinity, ll = Infinity;
          for (let j = i - enter; j < i; j++) hh = Math.max(hh, close[j]);
          for (let j = i - exit; j < i; j++) ll = Math.min(ll, close[j]);
          // Strictly greater: on a flat stretch the current price equals the channel high, and
          // `>=` would turn that non-event into a phantom breakout.
          if (pos === 0 && close[i] > hh) pos = 1;
          else if (pos === 1 && close[i] < ll) pos = 0;
          sig[i] = pos;
        }
        break;
      }
      case "bollinger": {
        const w = Math.round(p[0]);
        const k = p[1];
        const mid = sma(close, w);
        const sd = rollingStdev(close, w);
        let pos = 0;
        for (let i = 0; i < n; i++) {
          if (Number.isNaN(mid[i]) || Number.isNaN(sd[i]) || sd[i] <= 0) continue;
          if (pos === 0 && close[i] < mid[i] - k * sd[i]) pos = 1;
          else if (pos === 1 && close[i] > mid[i]) pos = 0;
          sig[i] = pos;
        }
        break;
      }
      case "momentum": {
        const lb = Math.round(p[0]);
        for (let i = lb; i < n; i++) sig[i] = close[i] > close[i - lb] ? 1 : 0;
        break;
      }
      case "trend_dip": {
        const m = sma(close, Math.round(p[0]));
        const r = rsi(close, Math.round(p[1]));
        for (let i = 0; i < n; i++) {
          sig[i] = !Number.isNaN(m[i]) && !Number.isNaN(r[i]) && close[i] > m[i] && r[i] < p[2] ? 1 : 0;
        }
        break;
      }
    }
    return sig;
  }
}

/** Draws one plausible candidate. Ranges are the ones people actually reach for. */
export function randomCandidate(rand: () => number): Candidate {
  const families: Family[] = ["ma_cross", "rsi_revert", "breakout", "bollinger", "momentum", "trend_dip"];
  const family = families[Math.floor(rand() * families.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  switch (family) {
    case "ma_cross": {
      const fast = int(5, 50);
      return new RuleCandidate(family, [fast, fast + int(10, 150)]);
    }
    case "rsi_revert":
      return new RuleCandidate(family, [int(2, 21), int(15, 40), int(55, 85)]);
    case "breakout": {
      const enter = int(10, 100);
      return new RuleCandidate(family, [enter, int(5, Math.max(6, Math.floor(enter / 2)))]);
    }
    case "bollinger":
      return new RuleCandidate(family, [int(10, 40), 1 + rand() * 2]);
    case "momentum":
      return new RuleCandidate(family, [int(5, 200)]);
    case "trend_dip":
      return new RuleCandidate(family, [int(20, 200), int(2, 14), int(20, 45)]);
  }
}

export function generateCandidates(count: number, rand: () => number): Candidate[] {
  return Array.from({ length: count }, () => randomCandidate(rand));
}
