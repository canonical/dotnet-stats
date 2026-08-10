/* report.js - monthly executive report computation for dotnet-stats.
 *
 * Pure, side-effect free and DOM free (same rules as stats.js). This module is
 * the SINGLE implementation of the report's arithmetic: the on-screen report
 * view and the archived PDF are both rendered from `Report.buildReport`, so the
 * numbers can never drift between them.
 *
 * Exposed on the global `Report` object (no module bundler in use).
 */
(function (global) {
  "use strict";

  const S = global.Stats;
  if (!S) throw new Error("report.js requires stats.js to be loaded first");

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  /* Known long-term-support Ubuntu series. Used only for the "LTS share"
   * indicator; unknown series are treated as non-LTS. Extend as new LTS
   * releases ship. */
  const LTS_SERIES = { jammy: "22.04 LTS", noble: "24.04 LTS" };

  /* Package types counted as "runtime only" (deployment targets) when deriving
   * the SDK:runtime developer-intent ratio. */
  const RUNTIME_TYPES = ["runtime", "aspnetcore-runtime"];

  /* Coverage thresholds driving the report status gate. */
  const COVERAGE_OK = 95;
  const COVERAGE_MIN = 50;

  // ----------------------------------------------------------------------- //
  // Month / date arithmetic (all UTC, all string based)
  // ----------------------------------------------------------------------- //

  function monthOf(dateStr) {
    return dateStr.slice(0, 7);
  }

  function parseMonth(month) {
    return [parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10)];
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function formatMonth(year, month) {
    return String(year) + "-" + pad2(month);
  }

  /** Shift a "YYYY-MM" string by n months (n may be negative). */
  function addMonths(month, n) {
    const [y, m] = parseMonth(month);
    const t = y * 12 + (m - 1) + n;
    const mm = ((t % 12) + 12) % 12;
    return formatMonth(Math.floor(t / 12), mm + 1);
  }

  function daysInMonth(month) {
    const [y, m] = parseMonth(month);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function monthStart(month) {
    return month + "-01";
  }

  function monthEnd(month) {
    return month + "-" + pad2(daysInMonth(month));
  }

  function monthLabel(month) {
    const [y, m] = parseMonth(month);
    return MONTH_NAMES[m - 1] + " " + y;
  }

  /** Inclusive list of ISO dates between two ISO dates. */
  function dateRange(from, to) {
    const out = [];
    if (from > to) return out;
    const cursor = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    while (cursor <= end) {
      out.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return out;
  }

  /** Inclusive list of "YYYY-MM" months between two months. */
  function monthsBetween(from, to) {
    const out = [];
    let cursor = from;
    while (cursor <= to) {
      out.push(cursor);
      cursor = addMonths(cursor, 1);
    }
    return out;
  }

  // ----------------------------------------------------------------------- //
  // Generic helpers
  // ----------------------------------------------------------------------- //

  function countsOf(binaries) {
    return binaries.map((b) => b.counts);
  }

  function groupBy(binaries, keyFn) {
    const map = new Map();
    for (const b of binaries) {
      const k = keyFn(b);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(b);
    }
    return map;
  }

  /** Percentage change, or null when it is not meaningful. */
  function pctChange(current, previous) {
    if (previous == null || previous === 0) return null;
    return ((current - previous) / previous) * 100;
  }

  function compareNumericKey(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  }

  /** Turn a sparse daily series into a contiguous one, missing days as 0. */
  function fillDaily(dates, counts, from, to) {
    const byDate = new Map();
    for (let i = 0; i < dates.length; i++) byDate.set(dates[i], counts[i]);
    const outDates = dateRange(from, to);
    return { dates: outDates, counts: outDates.map((d) => byDate.get(d) || 0) };
  }

  /** Restrict a daily series to dates <= `to`. */
  function truncateDaily(agg, to) {
    const dates = [];
    const counts = [];
    for (let i = 0; i < agg.dates.length; i++) {
      if (agg.dates[i] > to) continue;
      dates.push(agg.dates[i]);
      counts.push(agg.counts[i]);
    }
    return { dates, counts };
  }

  /** Restrict a daily series to a single month. */
  function sliceMonth(agg, month) {
    const dates = [];
    const counts = [];
    for (let i = 0; i < agg.dates.length; i++) {
      if (monthOf(agg.dates[i]) !== month) continue;
      dates.push(agg.dates[i]);
      counts.push(agg.counts[i]);
    }
    return { dates, counts };
  }

  // ----------------------------------------------------------------------- //
  // Monthly aggregation (stats.js only knows about daily series)
  // ----------------------------------------------------------------------- //

  /** Total downloads per calendar month. Returns Map<"YYYY-MM", number>. */
  function monthlyTotals(binaries) {
    const byMonth = new Map();
    for (const b of binaries) {
      for (const pair of b.counts) {
        const m = monthOf(pair[0]);
        byMonth.set(m, (byMonth.get(m) || 0) + pair[1]);
      }
    }
    return byMonth;
  }

  /** Total downloads per key per month. Returns Map<key, Map<month, number>>. */
  function monthlyByKey(binaries, keyFn) {
    const byKey = new Map();
    for (const b of binaries) {
      const k = keyFn(b);
      if (!byKey.has(k)) byKey.set(k, new Map());
      const inner = byKey.get(k);
      for (const pair of b.counts) {
        const m = monthOf(pair[0]);
        inner.set(m, (inner.get(m) || 0) + pair[1]);
      }
    }
    return byKey;
  }

  /** Every month from the first to the last month with data, gaps included. */
  function monthRange(binaries) {
    const totals = monthlyTotals(binaries);
    const months = Array.from(totals.keys()).sort();
    if (!months.length) return [];
    return monthsBetween(months[0], months[months.length - 1]);
  }

  /** Months that actually carry at least one download count. */
  function monthsPresent(binaries) {
    return Array.from(monthlyTotals(binaries).keys()).sort();
  }

  /** Latest month whose full calendar span is covered by the dataset. */
  function latestCompleteMonth(binaries) {
    const agg = S.aggregateDaily(countsOf(binaries));
    if (!agg.dates.length) return null;
    const last = agg.dates[agg.dates.length - 1];
    const m = monthOf(last);
    return last >= monthEnd(m) ? m : addMonths(m, -1);
  }

  // ----------------------------------------------------------------------- //
  // Coverage
  // ----------------------------------------------------------------------- //

  /**
   * Data coverage for a month: how many of its days carry counts, and where the
   * gaps are. `datasetLast` clips expectations for an in-progress month.
   */
  function coverage(dates, month, datasetLast) {
    const start = monthStart(month);
    const end = monthEnd(month);
    const expectedEnd = datasetLast && datasetLast < end ? datasetLast : end;
    const expected = dateRange(start, expectedEnd);
    const present = new Set(dates.filter((d) => monthOf(d) === month));

    const missing = expected.filter((d) => !present.has(d));
    // Collapse missing days into contiguous ranges for readable reporting.
    const gaps = [];
    for (const d of missing) {
      const last = gaps.length ? gaps[gaps.length - 1] : null;
      if (last && dateRange(last.to, d).length === 2) last.to = d;
      else gaps.push({ from: d, to: d });
    }

    return {
      daysInMonth: daysInMonth(month),
      daysExpected: expected.length,
      daysWithData: expected.length - missing.length,
      daysMissing: missing.length,
      coveragePct: expected.length
        ? ((expected.length - missing.length) / expected.length) * 100
        : 0,
      gaps: gaps,
      complete: !!datasetLast && datasetLast >= end,
    };
  }

  // ----------------------------------------------------------------------- //
  // Dimensional breakdowns
  // ----------------------------------------------------------------------- //

  /**
   * Per-key month totals, shares and month-over-month movement, plus the
   * per-key series over `window` months for stacked charts.
   */
  function dimension(binaries, keyFn, month, window) {
    const byKey = monthlyByKey(binaries, keyFn);
    const prev = addMonths(month, -1);

    let total = 0;
    let prevTotal = 0;
    byKey.forEach((inner) => {
      total += inner.get(month) || 0;
      prevTotal += inner.get(prev) || 0;
    });

    const rows = [];
    byKey.forEach((inner, key) => {
      const cur = inner.get(month) || 0;
      const was = inner.get(prev) || 0;
      const sharePct = total ? (cur / total) * 100 : 0;
      const prevSharePct = prevTotal ? (was / prevTotal) * 100 : 0;
      rows.push({
        key: key,
        total: cur,
        prevTotal: was,
        momPct: pctChange(cur, was),
        sharePct: sharePct,
        prevSharePct: prevSharePct,
        shareDeltaPp: prevTotal ? sharePct - prevSharePct : null,
        months: window.slice(),
        totals: window.map((m) => inner.get(m) || 0),
      });
    });

    rows.sort((a, b) => b.total - a.total || compareNumericKey(a.key, b.key));
    return { total: total, prevTotal: prevTotal, rows: rows };
  }

  function rowFor(dim, key) {
    for (const r of dim.rows) if (r.key === key) return r;
    return null;
  }

  function shareOfKeys(dim, keys) {
    let cur = 0;
    let was = 0;
    for (const r of dim.rows) {
      if (keys.indexOf(r.key) === -1) continue;
      cur += r.total;
      was += r.prevTotal;
    }
    const sharePct = dim.total ? (cur / dim.total) * 100 : 0;
    const prevSharePct = dim.prevTotal ? (was / dim.prevTotal) * 100 : 0;
    return {
      total: cur,
      prevTotal: was,
      sharePct: sharePct,
      prevSharePct: prevSharePct,
      shareDeltaPp: dim.prevTotal ? sharePct - prevSharePct : null,
      momPct: pctChange(cur, was),
    };
  }

  // ----------------------------------------------------------------------- //
  // Derived indicators
  // ----------------------------------------------------------------------- //

  /**
   * SDK downloads divided by runtime-only downloads, per month. A proxy for
   * "developer machines / build agents" versus "deployment targets" — not a
   * headcount of any kind.
   */
  function devIntentRatio(typeDim, window) {
    const sdk = rowFor(typeDim, "sdk");
    const runtimeRows = typeDim.rows.filter((r) => RUNTIME_TYPES.indexOf(r.key) !== -1);
    const sdkTotals = window.map((m, i) => (sdk ? sdk.totals[i] : 0));
    const runtimeTotals = window.map((m, i) =>
      runtimeRows.reduce((acc, r) => acc + r.totals[i], 0)
    );
    const ratio = window.map((m, i) =>
      runtimeTotals[i] ? sdkTotals[i] / runtimeTotals[i] : null
    );
    const runtime = shareOfKeys(typeDim, RUNTIME_TYPES);
    const now = runtime.total ? (sdk ? sdk.total : 0) / runtime.total : null;
    const before = runtime.prevTotal
      ? (sdk ? sdk.prevTotal : 0) / runtime.prevTotal
      : null;
    return {
      months: window.slice(),
      sdkTotals: sdkTotals,
      runtimeTotals: runtimeTotals,
      ratio: ratio,
      sdkTotal: sdk ? sdk.total : 0,
      sdkMomPct: sdk ? sdk.momPct : null,
      runtimeTotal: runtime.total,
      ratioNow: now,
      ratioPrev: before,
      ratioDeltaPct: before ? ((now - before) / before) * 100 : null,
    };
  }

  /** Per-version momentum as of the end of the reported month. */
  function momentum(binaries, month) {
    const end = monthEnd(month);
    const start = monthStart(month);
    const byVersion = groupBy(binaries, (b) => S.majorVersion(b.source_package));
    const rows = [];
    byVersion.forEach((bins, version) => {
      const agg = truncateDaily(S.aggregateDaily(countsOf(bins)), end);
      if (!agg.dates.length) return;
      // Contiguous windows: gaps count as zero-download days so the trailing
      // windows below line up with calendar time rather than row counts.
      const inMonth = fillDaily(agg.dates, agg.counts, start, end);
      const last90 = fillDaily(agg.dates, agg.counts, shiftDays(end, -89), end);
      const momPct = S.periodGrowth(last90.counts, 30);
      /* A half-life is a decline estimate. The log-linear fit can still return
       * one for a series that grew over the month, which reads as a
       * contradiction next to a positive 30-day change, so it is suppressed. */
      const decline = momPct == null || momPct <= 0;
      rows.push({
        version: version,
        total: S.sum(inMonth.counts),
        wowPct: S.periodGrowth(last90.counts, 7),
        momPct: momPct,
        slope: S.linearRegression(inMonth.counts).slope,
        halfLifeDays: decline ? S.halfLife(last90.counts, 0.5) : null,
      });
    });
    rows.sort((a, b) => compareNumericKey(a.version, b.version));
    return rows;
  }

  function shiftDays(dateStr, n) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Top binaries by downloads in the month, with month-over-month movement. */
  function topBinaries(binaries, month, n) {
    const byName = monthlyByKey(binaries, (b) => b.name);
    const prev = addMonths(month, -1);
    const rows = [];
    byName.forEach((inner, name) => {
      const cur = inner.get(month) || 0;
      if (!cur) return;
      const was = inner.get(prev) || 0;
      rows.push({
        name: name,
        type: S.packageType(name),
        total: cur,
        prevTotal: was,
        momPct: pctChange(cur, was),
      });
    });
    rows.sort((a, b) => b.total - a.total);
    return rows.slice(0, n || 10);
  }

  /** In-month anomaly days, annotated with how many sigma they sit above the mean. */
  function monthAnomalies(daily, k) {
    const m = S.mean(daily.counts);
    const sd = S.stdDev(daily.counts);
    if (!sd) return [];
    const out = [];
    for (let i = 0; i < daily.counts.length; i++) {
      const sigma = (daily.counts[i] - m) / sd;
      if (sigma > (k == null ? 2 : k)) {
        out.push({ date: daily.dates[i], count: daily.counts[i], sigma: sigma });
      }
    }
    out.sort((a, b) => b.sigma - a.sigma);
    return out;
  }

  // ----------------------------------------------------------------------- //
  // Report assembly
  // ----------------------------------------------------------------------- //

  /**
   * Binaries the report is always computed from: everything tracked, minus
   * debug-symbol packages. Deliberately independent of the dashboard's filter
   * bar so an archived report is reproducible.
   */
  function canonicalBinaries(binaries) {
    return binaries.filter((b) => !b.is_debug);
  }

  /**
   * Build the complete facts bundle for one month. Pure: the same binaries and
   * month always yield the same object.
   *
   * @param {Array} binaries - canonical binaries (see canonicalBinaries)
   * @param {string} month - "YYYY-MM"
   * @param {Object} [options] - { windowMonths: 13, topN: 10, forecast: true }
   */
  function buildReport(binaries, month, options) {
    const opts = options || {};
    const windowMonths = opts.windowMonths || 13;
    const prev = addMonths(month, -1);
    const yoy = addMonths(month, -12);
    const next = addMonths(month, 1);
    const end = monthEnd(month);

    const allDaily = S.aggregateDaily(countsOf(binaries));
    const datasetFirst = allDaily.dates.length ? allDaily.dates[0] : null;
    const datasetLast = allDaily.dates.length
      ? allDaily.dates[allDaily.dates.length - 1]
      : null;

    const totalsByMonth = monthlyTotals(binaries);
    const historyMonths = monthRange(binaries);

    // 13-month window ending at the reported month, clipped to the dataset.
    const windowStart = addMonths(month, -(windowMonths - 1));
    const from = datasetFirst && monthOf(datasetFirst) > windowStart
      ? monthOf(datasetFirst)
      : windowStart;
    const window = monthsBetween(from, month);

    const daily = sliceMonth(allDaily, month);
    const prevDaily = sliceMonth(allDaily, prev);
    const cov = coverage(allDaily.dates, month, datasetLast);

    const monthTotal = totalsByMonth.get(month) || 0;
    const prevTotal = totalsByMonth.has(prev) ? totalsByMonth.get(prev) : null;
    const yoyTotal = totalsByMonth.has(yoy) ? totalsByMonth.get(yoy) : null;

    let status;
    if (!daily.dates.length) status = "no_data";
    else if (cov.coveragePct < COVERAGE_MIN) status = "insufficient_data";
    else if (!cov.complete || cov.coveragePct < COVERAGE_OK) status = "partial";
    else status = "ok";

    const toEnd = truncateDaily(allDaily, end);
    const cumulativeToEnd = S.sum(toEnd.counts);

    const versions = dimension(
      binaries, (b) => S.majorVersion(b.source_package), month, window
    );
    const seriesDim = dimension(binaries, (b) => b.series, month, window);
    const archDim = dimension(binaries, (b) => b.architecture, month, window);
    const typeDim = dimension(binaries, (b) => S.packageType(b.name), month, window);
    const originDim = dimension(binaries, (b) => b.origin, month, window);

    // Versions in numeric order for the stacked-share chart.
    const versionSeries = versions.rows
      .slice()
      .sort((a, b) => compareNumericKey(a.key, b.key));

    const activeVersions = versions.rows.filter((r) => r.total > 0);
    const newest = activeVersions
      .slice()
      .sort((a, b) => compareNumericKey(b.key, a.key))[0] || null;
    const leader = activeVersions.length ? activeVersions[0] : null;

    const ltsKeys = Object.keys(LTS_SERIES).filter((k) => rowFor(seriesDim, k));
    const lts = shareOfKeys(seriesDim, ltsKeys);
    const arm64 = rowFor(archDim, "arm64");
    const devIntent = devIntentRatio(typeDim, window);

    // Binaries first seen in this month (release/publication activity).
    let newBinaries = 0;
    let activeBinaries = 0;
    for (const b of binaries) {
      let first = null;
      let seen = false;
      for (const pair of b.counts) {
        if (first === null || pair[0] < first) first = pair[0];
        if (monthOf(pair[0]) === month) seen = true;
      }
      if (seen) activeBinaries++;
      if (first !== null && monthOf(first) === month) newBinaries++;
    }

    let forecast = null;
    if (opts.forecast !== false && toEnd.dates.length >= 10) {
      const horizon = daysInMonth(next);
      const fc = S.forecastCumulative(toEnd.dates, toEnd.counts, horizon, 60);
      // How much of the 60-day fit window actually carries data: a sparse fit
      // window makes the projection unreliable and is flagged as such.
      const fitFrom = shiftDays(end, -59);
      const fitDays = toEnd.dates.filter((d) => d >= fitFrom).length;
      forecast = {
        dates: fc.dates,
        values: fc.values,
        lower: fc.lower,
        upper: fc.upper,
        nextMonth: next,
        nextMonthLabel: monthLabel(next),
        nextMonthTotal: fc.values.length
          ? fc.values[fc.values.length - 1] - cumulativeToEnd
          : null,
        fitCoveragePct: (fitDays / 60) * 100,
        lowConfidence: fitDays / 60 < 0.9,
      };
    }

    const peak = daily.dates.length ? S.topPeaks(daily.dates, daily.counts, 1)[0] : null;

    return {
      month: month,
      monthLabel: monthLabel(month),
      prevMonth: prev,
      prevMonthLabel: monthLabel(prev),
      yoyMonth: yoy,
      yoyMonthLabel: monthLabel(yoy),
      status: status,
      coverage: cov,
      scope: {
        origins: originDim.rows.map((r) => r.key),
        pockets: Array.from(new Set(binaries.map((b) => b.pocket))).sort(),
        sourcePackages: Array.from(new Set(binaries.map((b) => b.source_package))).sort(
          compareNumericKey
        ),
        trackedBinaries: binaries.length,
        activeBinaries: activeBinaries,
        newBinaries: newBinaries,
        debugExcluded: true,
        datasetFirst: datasetFirst,
        datasetLast: datasetLast,
      },
      daily: daily,
      prevDaily: prevDaily,
      history: { months: historyMonths, totals: historyMonths.map((m) => totalsByMonth.get(m) || 0) },
      window: { months: window, totals: window.map((m) => totalsByMonth.get(m) || 0) },
      totals: {
        month: monthTotal,
        prevMonth: prevTotal,
        yoyMonth: yoyTotal,
        momPct: pctChange(monthTotal, prevTotal),
        yoyPct: pctChange(monthTotal, yoyTotal),
        avgPerDay: cov.daysWithData ? monthTotal / cov.daysWithData : 0,
        medianPerDay: S.median(daily.counts),
        peak: peak || null,
        cumulativeToEnd: cumulativeToEnd,
        lifetime: S.sum(allDaily.counts),
      },
      versions: versions,
      versionSeries: versionSeries,
      series: seriesDim,
      arch: archDim,
      types: typeDim,
      origins: originDim,
      devIntent: devIntent,
      northStar: {
        sdkTotal: devIntent.sdkTotal,
        sdkMomPct: devIntent.sdkMomPct,
        newestVersion: newest ? newest.key : null,
        newestSharePct: newest ? newest.sharePct : null,
        newestShareDeltaPp: newest ? newest.shareDeltaPp : null,
        newestMomPct: newest ? newest.momPct : null,
        leadingVersion: leader ? leader.key : null,
        leadingSharePct: leader ? leader.sharePct : null,
        activeVersionCount: activeVersions.length,
        arm64SharePct: arm64 ? arm64.sharePct : null,
        arm64ShareDeltaPp: arm64 ? arm64.shareDeltaPp : null,
        ltsSharePct: lts.sharePct,
        ltsShareDeltaPp: lts.shareDeltaPp,
        ltsSeries: ltsKeys.map((k) => k + " (" + LTS_SERIES[k] + ")"),
        leadingSeries: seriesDim.rows.length ? seriesDim.rows[0].key : null,
        leadingSeriesSharePct: seriesDim.rows.length ? seriesDim.rows[0].sharePct : null,
      },
      momentum: momentum(binaries, month),
      topBinaries: topBinaries(binaries, month, opts.topN || 10),
      anomalies: monthAnomalies(daily, 2),
      forecast: forecast,
    };
  }

  // ----------------------------------------------------------------------- //
  // Findings: deterministic, threshold-driven sentences
  //
  // Every rule is a pure (facts) -> {text, tone} | null function and every
  // number it prints comes from `facts`. No prose is generated freehand, so a
  // reader can always trace a sentence back to a figure in the tables.
  // ----------------------------------------------------------------------- //

  function n0(value) {
    return Math.round(value).toLocaleString("en-US");
  }
  function p1(value) {
    return (value >= 0 ? "+" : "") + value.toFixed(1) + "%";
  }
  function pp1(value) {
    return (value >= 0 ? "+" : "") + value.toFixed(1) + "pp";
  }
  /* Very large percentage changes read as noise ("+20105.3%") and usually mean
   * the comparison base was near zero. Express those as a multiple instead. */
  function growthLabel(pct) {
    if (pct == null) return "n/a";
    if (pct >= 500) return (pct / 100 + 1).toFixed(0) + "\u00d7";
    return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
  }
  function growth(pct) {
    if (pct >= 500) return growthLabel(pct) + " higher than";
    return p1(pct) + " versus";
  }

  const RULES = [
    // Data quality first: it qualifies everything that follows.
    {
      id: "dataQuality",
      needs: "always",
      rank: 0,
      pinned: true,
      run: function (f) {
        if (f.status === "no_data") {
          return {
            tone: "caution",
            text:
              "No download counts were recorded for " + f.monthLabel +
              ". This is a collection gap, not an absence of usage — no figure " +
              "in this report may be read as a decline in " + f.monthLabel + ".",
          };
        }
        if (f.coverage.coveragePct >= COVERAGE_OK) return null;
        return {
          tone: "caution",
          text:
            "Data covers " + f.coverage.daysWithData + " of " +
            f.coverage.daysExpected + " days (" + f.coverage.coveragePct.toFixed(0) +
            "%); " + f.coverage.daysMissing + " day(s) are missing, so monthly " +
            "totals understate actual volume and month-on-month comparisons are " +
            "not like for like.",
        };
      },
    },

    {
      id: "volume",
      needs: "volume",
      rank: 10,
      pinned: true,
      run: function (f) {
        const t = f.totals;
        if (!t.month) return null;
        const base =
          n0(t.month) + " downloads in " + f.monthLabel + " (" +
          n0(t.avgPerDay) + "/day)";
        if (t.momPct == null) {
          return { tone: "neutral", text: base + "." };
        }
        const tone = t.momPct >= 10 ? "positive" : t.momPct <= -10 ? "negative" : "neutral";
        const verb =
          t.momPct >= 10 ? "up" : t.momPct <= -10 ? "down" : "broadly flat, ";
        // A year-on-year figure is only worth printing against a base that was
        // itself substantial; early PPA months are too small to compare against.
        const yoyPart =
          t.yoyPct == null || t.yoyMonth < 1000
            ? ""
            : " Year on year the month is " + growth(t.yoyPct) + " " + f.yoyMonthLabel + ".";
        return {
          tone: tone,
          text:
            base + ", " + verb + " " + p1(t.momPct) + " against " + f.prevMonthLabel +
            "." + yoyPart,
        };
      },
    },

    {
      id: "newestVersionAdoption",
      needs: "composition",
      rank: 20,
      run: function (f) {
        const ns = f.northStar;
        if (!ns.newestVersion || ns.newestSharePct == null) return null;
        if (ns.newestShareDeltaPp == null) {
          return {
            tone: "neutral",
            text:
              ns.newestVersion + " accounts for " + ns.newestSharePct.toFixed(1) +
              "% of the month's downloads.",
          };
        }
        if (ns.newestShareDeltaPp >= 3) {
          return {
            tone: "positive",
            text:
              "Adoption of " + ns.newestVersion + " is accelerating: " +
              ns.newestSharePct.toFixed(1) + "% of the month's volume, " +
              pp1(ns.newestShareDeltaPp) + " on " + f.prevMonthLabel +
              (ns.newestMomPct == null
                ? "."
                : " (" + p1(ns.newestMomPct) + " in absolute terms)."),
          };
        }
        if (ns.newestShareDeltaPp <= -3) {
          return {
            tone: "negative",
            text:
              ns.newestVersion + " lost share this month, down to " +
              ns.newestSharePct.toFixed(1) + "% (" + pp1(ns.newestShareDeltaPp) + ").",
          };
        }
        return null;
      },
    },

    {
      id: "migration",
      needs: "composition",
      rank: 30,
      run: function (f) {
        const declining = f.versions.rows
          .filter((r) => r.total > 0 && r.shareDeltaPp != null && r.shareDeltaPp <= -5)
          .sort((a, b) => a.shareDeltaPp - b.shareDeltaPp)[0];
        if (!declining) return null;
        return {
          tone: "neutral",
          text:
            declining.key + " is being displaced: " + declining.sharePct.toFixed(1) +
            "% of volume, " + pp1(declining.shareDeltaPp) + " on " + f.prevMonthLabel +
            " — consistent with migration to newer releases.",
        };
      },
    },

    {
      id: "leadership",
      needs: "composition",
      rank: 40,
      run: function (f) {
        const ns = f.northStar;
        if (!ns.leadingVersion || ns.leadingSharePct == null) return null;
        if (ns.leadingVersion === ns.newestVersion) return null;
        return {
          tone: "neutral",
          text:
            ns.leadingVersion + " remains the most downloaded release at " +
            ns.leadingSharePct.toFixed(1) + "% of the month, across " +
            ns.activeVersionCount + " active .NET versions.",
        };
      },
    },

    {
      id: "developerIntent",
      needs: "composition",
      rank: 50,
      run: function (f) {
        const di = f.devIntent;
        if (di.ratioNow == null) return null;
        // Phrase the ratio in whichever direction reads correctly.
        const level =
          di.ratioNow >= 1
            ? "SDK downloads outnumber runtime-only downloads " +
              di.ratioNow.toFixed(2) + ":1"
            : "Every runtime-only download came with " + di.ratioNow.toFixed(2) +
              " SDK downloads";
        const detail =
          " (" + n0(di.sdkTotal) + " SDK vs " + n0(di.runtimeTotal) + " runtime)";
        if (di.ratioDeltaPct == null || Math.abs(di.ratioDeltaPct) < 10) {
          return {
            tone: "neutral",
            text:
              level + detail + " — a proxy for developer-side rather than " +
              "deployment-side pull.",
          };
        }
        return {
          tone: di.ratioDeltaPct > 0 ? "positive" : "negative",
          text:
            level + detail + ", " + p1(di.ratioDeltaPct) + " on " + f.prevMonthLabel +
            " — the mix shifted towards " +
            (di.ratioDeltaPct > 0 ? "development and build environments" : "deployment targets") +
            ".",
        };
      },
    },

    {
      id: "platform",
      needs: "composition",
      rank: 60,
      run: function (f) {
        const ns = f.northStar;
        if (ns.arm64ShareDeltaPp != null && Math.abs(ns.arm64ShareDeltaPp) >= 2) {
          return {
            tone: ns.arm64ShareDeltaPp > 0 ? "positive" : "neutral",
            text:
              "arm64 is now " + ns.arm64SharePct.toFixed(1) + "% of downloads (" +
              pp1(ns.arm64ShareDeltaPp) + " on " + f.prevMonthLabel + ").",
          };
        }
        if (ns.leadingSeries && ns.leadingSeriesSharePct != null) {
          return {
            tone: "neutral",
            text:
              "Ubuntu " + ns.leadingSeries + " takes " +
              ns.leadingSeriesSharePct.toFixed(1) + "% of the month's downloads; LTS " +
              "releases account for " + ns.ltsSharePct.toFixed(1) + "% in total.",
          };
        }
        return null;
      },
    },

    {
      id: "anomaly",
      needs: "composition",
      rank: 70,
      run: function (f) {
        const big = f.anomalies.filter((a) => a.sigma >= 3);
        if (!big.length) return null;
        const a = big[0];
        return {
          tone: "caution",
          text:
            "Unusual spike on " + a.date + " (" + n0(a.count) + " downloads, " +
            a.sigma.toFixed(1) + "\u03c3 above the month's mean)" +
            (big.length > 1 ? " and " + (big.length - 1) + " other day(s)" : "") +
            " — worth confirming the cause before quoting the monthly total.",
        };
      },
    },

    {
      id: "outlook",
      needs: "composition",
      rank: 80,
      run: function (f) {
        if (!f.forecast || f.forecast.nextMonthTotal == null) return null;
        if (f.forecast.lowConfidence) return null;
        const projected = f.forecast.nextMonthTotal;
        const delta = pctChange(projected, f.totals.month);
        return {
          tone: "neutral",
          text:
            "Linear extrapolation of the last 60 days projects roughly " +
            n0(projected) + " downloads in " + f.forecast.nextMonthLabel +
            (delta == null ? "." : " (" + p1(delta) + " on " + f.monthLabel + ")."),
        };
      },
    },
  ];

  /* How much data a rule needs before its sentence is meaningful. Composition
   * rules compare shares against the previous month, which is nonsense when the
   * month is a collection gap, so they are suppressed rather than allowed to
   * report "0% of volume, -63pp". */
  const NEED_LEVEL = { always: 0, volume: 1, composition: 2 };

  function statusLevel(status) {
    if (status === "no_data") return 0;
    if (status === "insufficient_data") return 1;
    return 2;
  }

  /** Run the rule set and return the findings for a month.
   *
   * Cautions are always kept -- honesty items must never be squeezed out by the
   * cap. Everything else is ordered by the rule's own importance, with notable
   * movement (a clear rise or fall) promoted a little, and capped at `max`.
   */
  function findings(facts, max) {
    const level = statusLevel(facts.status);
    const cautions = [];
    const others = [];
    for (const rule of RULES) {
      if (NEED_LEVEL[rule.needs] > level) continue;
      const result = rule.run(facts);
      if (!result || !result.text) continue;
      result.id = rule.id;
      const notable = result.tone === "positive" || result.tone === "negative";
      result.score = rule.pinned ? rule.rank : rule.rank - (notable ? 5 : 0);
      (result.tone === "caution" ? cautions : others).push(result);
    }
    cautions.sort((a, b) => a.score - b.score);
    others.sort((a, b) => a.score - b.score);
    return cautions.concat(others.slice(0, max || 5));
  }

  // ----------------------------------------------------------------------- //
  // Methodology boilerplate (fixed text, shown on every report)
  // ----------------------------------------------------------------------- //

  const LIMITATIONS = [
    "Figures count package downloads recorded by Launchpad for the dotnet/backports PPA only.",
    "The primary Ubuntu archive publishes no download telemetry, so packages installed from it are not represented here. This report is a directional indicator, not total .NET usage on Ubuntu.",
    "Downloads are not users. CI/CD pipelines, container image builds, mirrors and repeated installations all inflate counts, and one developer may generate many downloads.",
    "Counts are deduplicated per publication and day, keeping the maximum value reported by Launchpad; recent days may still rise as Launchpad reporting settles.",
    "Debug-symbol packages are excluded from every figure in this report.",
    "No data is collected for any other programming language, so this report makes no cross-language comparison.",
  ];

  global.Report = {
    // month/date helpers
    monthOf: monthOf,
    addMonths: addMonths,
    daysInMonth: daysInMonth,
    monthStart: monthStart,
    monthEnd: monthEnd,
    monthLabel: monthLabel,
    monthsBetween: monthsBetween,
    dateRange: dateRange,
    shiftDays: shiftDays,
    // aggregation
    monthlyTotals: monthlyTotals,
    monthlyByKey: monthlyByKey,
    monthRange: monthRange,
    monthsPresent: monthsPresent,
    latestCompleteMonth: latestCompleteMonth,
    coverage: coverage,
    dimension: dimension,
    devIntentRatio: devIntentRatio,
    momentum: momentum,
    topBinaries: topBinaries,
    monthAnomalies: monthAnomalies,
    fillDaily: fillDaily,
    truncateDaily: truncateDaily,
    sliceMonth: sliceMonth,
    pctChange: pctChange,
    // report
    canonicalBinaries: canonicalBinaries,
    buildReport: buildReport,
    findings: findings,
    growthLabel: growthLabel,
    LIMITATIONS: LIMITATIONS,
    LTS_SERIES: LTS_SERIES,
    RUNTIME_TYPES: RUNTIME_TYPES,
    COVERAGE_OK: COVERAGE_OK,
    COVERAGE_MIN: COVERAGE_MIN,
  };
})(window);
