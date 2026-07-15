/* stats.js - pure statistical helpers for the dotnet-stats dashboard.
 *
 * All functions are side-effect free and operate on plain arrays/objects so
 * they are easy to reason about and test. Exposed on the global `Stats`
 * object (no module bundler in use).
 */
(function (global) {
  "use strict";

  // ----------------------------------------------------------------------- //
  // Basic descriptive statistics
  // ----------------------------------------------------------------------- //

  function sum(values) {
    let total = 0;
    for (let i = 0; i < values.length; i++) total += values[i];
    return total;
  }

  function mean(values) {
    return values.length ? sum(values) / values.length : 0;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function stdDev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance =
      sum(values.map((v) => (v - m) * (v - m))) / (values.length - 1);
    return Math.sqrt(variance);
  }

  function describe(values) {
    return {
      count: values.length,
      total: sum(values),
      mean: mean(values),
      median: median(values),
      stdDev: stdDev(values),
      min: values.length ? Math.min.apply(null, values) : 0,
      max: values.length ? Math.max.apply(null, values) : 0,
    };
  }

  // ----------------------------------------------------------------------- //
  // Time-series helpers
  // ----------------------------------------------------------------------- //

  /**
   * Aggregate an array of [date, count] pairs (possibly from many binaries)
   * into a single sorted daily series. Returns { dates: [], counts: [] }.
   */
  function aggregateDaily(pairsArrays) {
    const byDate = new Map();
    for (const pairs of pairsArrays) {
      for (let i = 0; i < pairs.length; i++) {
        const date = pairs[i][0];
        const count = pairs[i][1];
        byDate.set(date, (byDate.get(date) || 0) + count);
      }
    }
    const dates = Array.from(byDate.keys()).sort();
    const counts = dates.map((d) => byDate.get(d));
    return { dates, counts };
  }

  function movingAverage(values, window) {
    const out = new Array(values.length).fill(null);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      if (i >= window) acc -= values[i - window];
      if (i >= window - 1) out[i] = acc / window;
    }
    return out;
  }

  function cumulative(values) {
    const out = new Array(values.length);
    let acc = 0;
    for (let i = 0; i < values.length; i++) {
      acc += values[i];
      out[i] = acc;
    }
    return out;
  }

  // ----------------------------------------------------------------------- //
  // Trends
  // ----------------------------------------------------------------------- //

  /**
   * Ordinary least-squares linear regression on y over integer index x.
   * Returns { slope, intercept, r2 }.
   */
  function linearRegression(values) {
    const n = values.length;
    if (n < 2) return { slope: 0, intercept: values[0] || 0, r2: 0 };
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      sx += i;
      sy += values[i];
      sxy += i * values[i];
      sxx += i * i;
      syy += values[i] * values[i];
    }
    const denom = n * sxx - sx * sx;
    const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    const rNum = n * sxy - sx * sy;
    const rDen = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    const r = rDen === 0 ? 0 : rNum / rDen;
    return { slope, intercept, r2: r * r };
  }

  /** Percentage growth between the sum of the last `window` days vs the prior
   * `window` days. */
  function periodGrowth(counts, window) {
    if (counts.length < window * 2) return null;
    const recent = sum(counts.slice(counts.length - window));
    const previous = sum(counts.slice(counts.length - window * 2, counts.length - window));
    if (previous === 0) return null;
    return ((recent - previous) / previous) * 100;
  }

  // ----------------------------------------------------------------------- //
  // Peaks & anomalies
  // ----------------------------------------------------------------------- //

  function topPeaks(dates, counts, n) {
    const indexed = dates.map((d, i) => ({ date: d, count: counts[i] }));
    indexed.sort((a, b) => b.count - a.count);
    return indexed.slice(0, n);
  }

  /** Days whose count exceeds mean + k*stdDev. */
  function anomalies(dates, counts, k) {
    const m = mean(counts);
    const s = stdDev(counts);
    const threshold = m + k * s;
    const out = [];
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > threshold) {
        out.push({ date: dates[i], count: counts[i], threshold: threshold });
      }
    }
    return out;
  }

  // ----------------------------------------------------------------------- //
  // Lifecycle / forecast
  // ----------------------------------------------------------------------- //

  /**
   * Estimate exponential decline half-life (in days) from a daily series,
   * using log-linear regression on the trailing portion. Returns null when the
   * series is not declining.
   */
  function halfLife(counts, tailFraction) {
    const startIdx = Math.floor(counts.length * (1 - (tailFraction || 0.5)));
    const tail = counts.slice(startIdx).filter((c) => c > 0);
    if (tail.length < 5) return null;
    const logs = tail.map((c) => Math.log(c));
    const { slope } = linearRegression(logs);
    if (slope >= 0) return null; // not declining
    return Math.log(2) / -slope;
  }

  /**
   * Linear forecast of cumulative downloads `horizon` days into the future.
   * Fits a regression on the recent daily rate and projects forward.
   * Returns { dates: [], values: [], lower: [], upper: [] }.
   */
  function forecastCumulative(dates, counts, horizon, fitWindow) {
    const window = Math.min(fitWindow || 60, counts.length);
    const recent = counts.slice(counts.length - window);
    const { slope, intercept } = linearRegression(recent);
    const resid = recent.map((v, i) => v - (intercept + slope * i));
    const sigma = stdDev(resid);

    const lastDate = dates.length ? new Date(dates[dates.length - 1]) : new Date();
    const startCum = sum(counts);
    const outDates = [];
    const values = [];
    const lower = [];
    const upper = [];
    let cum = startCum;
    let cumLo = startCum;
    let cumHi = startCum;
    for (let h = 1; h <= horizon; h++) {
      const rate = Math.max(0, intercept + slope * (window - 1 + h));
      cum += rate;
      cumLo += Math.max(0, rate - 1.96 * sigma);
      cumHi += rate + 1.96 * sigma;
      const d = new Date(lastDate.getTime());
      d.setDate(d.getDate() + h);
      outDates.push(d.toISOString().slice(0, 10));
      values.push(Math.round(cum));
      lower.push(Math.round(cumLo));
      upper.push(Math.round(cumHi));
    }
    return { dates: outDates, values, lower, upper };
  }

  // ----------------------------------------------------------------------- //
  // Package taxonomy helpers
  // ----------------------------------------------------------------------- //

  /** Classify a binary package name into a coarse type. */
  function packageType(name) {
    if (/^aspnetcore-runtime/.test(name)) return "aspnetcore-runtime";
    if (/-sdk-/.test(name) || /^dotnet-sdk/.test(name)) return "sdk";
    if (/-runtime-/.test(name) || /^dotnet-runtime/.test(name)) return "runtime";
    if (/hostfxr/.test(name)) return "hostfxr";
    if (/targeting-pack/.test(name)) return "targeting-pack";
    if (/apphost-pack/.test(name)) return "apphost-pack";
    if (/^dotnet-host/.test(name)) return "host";
    if (/^dotnet\d+$/.test(name)) return "meta";
    return "other";
  }

  /** Derive the .NET major version label from a source package name. */
  function majorVersion(sourcePackage) {
    const m = /(\d+)/.exec(sourcePackage || "");
    return m ? "dotnet" + m[1] : sourcePackage || "unknown";
  }

  global.Stats = {
    sum: sum,
    mean: mean,
    median: median,
    stdDev: stdDev,
    describe: describe,
    aggregateDaily: aggregateDaily,
    movingAverage: movingAverage,
    cumulative: cumulative,
    linearRegression: linearRegression,
    periodGrowth: periodGrowth,
    topPeaks: topPeaks,
    anomalies: anomalies,
    halfLife: halfLife,
    forecastCumulative: forecastCumulative,
    packageType: packageType,
    majorVersion: majorVersion,
  };
})(window);
