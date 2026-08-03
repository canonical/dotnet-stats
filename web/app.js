/* app.js - dashboard controller for dotnet-stats.
 *
 * Loads data/downloads.json, wires up the Vanilla Framework layout (side
 * navigation, filters), and renders each view with Plotly.
 */
(function () {
  "use strict";

  // Ubuntu brand palette for charts.
  var UBUNTU = {
    orange: "#E95420",
    purple: "#772953",
    aubergine: "#5E2750",
    warmGrey: "#AEA79F",
    coolGrey: "#333333",
    blue: "#0066cc",
    green: "#0e8420",
    teal: "#00807a",
    yellow: "#f99b11",
    red: "#c7162b",
  };
  var SERIES_COLORS = [
    UBUNTU.orange, UBUNTU.blue, UBUNTU.green, UBUNTU.purple, UBUNTU.teal,
    UBUNTU.yellow, UBUNTU.red, UBUNTU.aubergine, UBUNTU.warmGrey, UBUNTU.coolGrey,
  ];

  var PLOTLY_CONFIG = { responsive: true, displaylogo: false };
  var PLOTLY_FONT = { family: "Ubuntu, sans-serif", size: 13, color: UBUNTU.coolGrey };

  var VIEWS = [
    { id: "overview", label: "Overview", icon: "switcher-dashboard" },
    { id: "timeseries", label: "Time series", icon: "statistics" },
    { id: "calendar", label: "Calendar", icon: "history" },
    { id: "trends", label: "Trends", icon: "change-version" },
    { id: "market", label: "Version share", icon: "plans" },
    { id: "breakdowns", label: "Breakdowns", icon: "units" },
    { id: "peaks", label: "Peaks & anomalies", icon: "warning" },
    { id: "lifecycle", label: "Lifecycle", icon: "revisions" },
    { id: "forecast", label: "Forecast", icon: "share" },
    { id: "report", label: "Monthly report", icon: "topic" },
  ];

  // Views that ignore the global filter bar because their output must be
  // reproducible (see Views.report).
  var UNFILTERED_VIEWS = ["report"];

  // Friendly labels for known origins; unknown origins fall back to the raw value.
  var ORIGIN_LABELS = {
    "backports-ppa": "Backports PPA",
    "ubuntu-archive": "Ubuntu archive",
  };

  function originLabel(origin) {
    return ORIGIN_LABELS[origin] || origin;
  }

  // Distinct origins present in the loaded data, in a stable order.
  function detectedOrigins() {
    var seen = {};
    var order = [];
    state.binaries.forEach(function (b) {
      if (!seen[b.origin]) {
        seen[b.origin] = true;
        order.push(b.origin);
      }
    });
    order.sort();
    return order;
  }

  var state = {
    binaries: [],
    lastUpdated: null,
    filters: { origin: "all", pocket: "all", version: "all", type: "all", debug: false },
    calendarFilter: { year: "all", month: "all" },
    view: "overview",
    // Monthly report state.
    reportMonth: null,
    reportAppendix: false,
    reportSubView: "report",
    manifest: null,
    manifestBase: "",
  };

  /* Print mode is driven by the query string so that a headless browser can
   * render an archived PDF of exactly what a user sees on screen:
   *   ?month=2026-07&print=1[&appendix=1]
   */
  var printMode = { active: false, month: null, appendix: false };

  // --------------------------------------------------------------------- //
  // Utilities
  // --------------------------------------------------------------------- //

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }
  function fmt(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function fmtSigned(n) {
    if (n == null) return "n/a";
    var s = n >= 0 ? "+" : "";
    return s + n.toFixed(1) + "%";
  }

  // Wrap a stat card in a responsive grid column and append it to `grid`.
  function appendCard(grid, card) {
    var col = el("div", "col-3 col-medium-3 col-small-2");
    col.appendChild(card);
    grid.appendChild(col);
  }

  // Name of the weekday with the highest aggregate download total.
  function busiestWeekday(dates, counts) {
    var DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    var totals = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < dates.length; i++) {
      var d = new Date(dates[i] + "T00:00:00Z");
      totals[(d.getUTCDay() + 6) % 7] += counts[i];
    }
    var maxIdx = 0;
    for (var j = 1; j < 7; j++) if (totals[j] > totals[maxIdx]) maxIdx = j;
    return DAY_NAMES[maxIdx];
  }

  var MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // Distinct years present in a sorted date array (YYYY-MM-DD strings).
  function availableYears(dates) {
    var years = new Set();
    for (var i = 0; i < dates.length; i++) years.add(dates[i].slice(0, 4));
    return Array.from(years).sort();
  }

  // Distinct months (MM) present, optionally restricted to a given year.
  function availableMonths(dates, year) {
    var months = new Set();
    for (var i = 0; i < dates.length; i++) {
      if (year !== "all" && dates[i].slice(0, 4) !== year) continue;
      months.add(dates[i].slice(5, 7));
    }
    return Array.from(months).sort();
  }

  // Filter a daily series to the selected year and/or month.
  function filterByYearMonth(dates, counts, year, month) {
    if (year === "all" && month === "all") return { dates: dates, counts: counts };
    var fd = [], fc = [];
    for (var i = 0; i < dates.length; i++) {
      if (year !== "all" && dates[i].slice(0, 4) !== year) continue;
      if (month !== "all" && dates[i].slice(5, 7) !== month) continue;
      fd.push(dates[i]);
      fc.push(counts[i]);
    }
    return { dates: fd, counts: fc };
  }

  // --------------------------------------------------------------------- //
  // Filtering
  // --------------------------------------------------------------------- //

  function applyFilters() {
    var f = state.filters;
    return state.binaries.filter(function (b) {
      if (!f.debug && b.is_debug) return false;
      if (f.origin !== "all" && b.origin !== f.origin) return false;
      if (f.pocket !== "all" && b.pocket !== f.pocket) return false;
      if (f.version !== "all" && Stats.majorVersion(b.source_package) !== f.version)
        return false;
      if (f.type !== "all" && Stats.packageType(b.name) !== f.type) return false;
      return true;
    });
  }

  // --------------------------------------------------------------------- //
  // Rendering helpers
  // --------------------------------------------------------------------- //

  function statCard(title, value, sub) {
    var card = el("div", "p-card");
    card.appendChild(el("h3", "p-heading--5 u-no-margin--bottom u-text--muted", title));
    var display = typeof value === "number" ? fmt(value) : value;
    card.appendChild(el("p", "p-heading--2 u-no-margin", display));
    if (sub) card.appendChild(el("p", "u-text--muted u-no-margin", sub));
    return card;
  }

  function chartContainer(id) {
    var wrap = el("div", "p-card u-no-padding chart-card");
    var inner = el("div", "p-card__inner");
    var plot = el("div", "chart");
    plot.id = id;
    inner.appendChild(plot);
    wrap.appendChild(inner);
    return wrap;
  }

  function baseLayout(extra) {
    var layout = {
      font: PLOTLY_FONT,
      margin: { l: 60, r: 20, t: 30, b: 50 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      legend: { orientation: "h", y: -0.2 },
      hovermode: "x unified",
    };
    return Object.assign(layout, extra || {});
  }

  // --------------------------------------------------------------------- //
  // Data shaping
  // --------------------------------------------------------------------- //

  /** Group filtered binaries by a key function, returning Map<key, binaries[]>. */
  function groupBy(binaries, keyFn) {
    var map = new Map();
    for (var i = 0; i < binaries.length; i++) {
      var k = keyFn(binaries[i]);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(binaries[i]);
    }
    return map;
  }

  function totalCount(binaries) {
    var t = 0;
    for (var i = 0; i < binaries.length; i++) {
      var counts = binaries[i].counts;
      for (var j = 0; j < counts.length; j++) t += counts[j][1];
    }
    return t;
  }

  function countsOf(binaries) {
    return binaries.map(function (b) {
      return b.counts;
    });
  }

  // --------------------------------------------------------------------- //
  // Views
  // --------------------------------------------------------------------- //

  var Views = {};

  Views.overview = function (root, binaries) {
    var total = totalCount(binaries);
    var byOrigin = groupBy(binaries, function (b) {
      return b.origin;
    });
    var versions = new Set(binaries.map(function (b) { return Stats.majorVersion(b.source_package); }));

    var cards = [statCard("Total downloads", total, "across all selected packages")];
    // One card per origin present in the (filtered) data.
    Array.from(byOrigin.keys()).sort().forEach(function (origin) {
      var originTotal = totalCount(byOrigin.get(origin));
      cards.push(
        statCard(
          originLabel(origin),
          originTotal,
          total ? ((originTotal / total) * 100).toFixed(1) + "% of total" : ""
        )
      );
    });
    cards.push(statCard("Tracked binaries", binaries.length, versions.size + " .NET versions"));

    var grid = el("div", "row stat-cards");
    cards.forEach(function (card) { appendCard(grid, card); });
    root.appendChild(grid);

    // Top packages table.
    var byPkg = groupBy(binaries, function (b) { return b.name; });
    var rows = [];
    byPkg.forEach(function (bins, name) {
      rows.push({ name: name, type: Stats.packageType(name), total: totalCount(bins) });
    });
    rows.sort(function (a, b) { return b.total - a.total; });

    var section = el("div", "u-fixed-width");
    section.appendChild(el("h2", "p-heading--4", "Top packages by lifetime downloads"));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML =
      "<thead><tr><th>Package</th><th>Type</th><th class='u-align--right'>Lifetime downloads</th></tr></thead>";
    var tbody = el("tbody");
    rows.slice(0, 15).forEach(function (r) {
      var tr = el("tr");
      tr.innerHTML =
        "<td data-heading='Package'>" + r.name + "</td>" +
        "<td data-heading='Type'><span class='p-chip'><span class='p-chip__value'>" + r.type + "</span></span></td>" +
        "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  };

  Views.timeseries = function (root, binaries) {
    var agg = Stats.aggregateDaily(countsOf(binaries));
    if (!agg.dates.length) return emptyState(root);

    var container = chartContainer("chart-ts");
    root.appendChild(container);
    var ma7 = Stats.movingAverage(agg.counts, 7);
    var ma30 = Stats.movingAverage(agg.counts, 30);
    Plotly.newPlot(
      "chart-ts",
      [
        { x: agg.dates, y: agg.counts, name: "Daily", type: "scatter", mode: "lines",
          line: { color: UBUNTU.warmGrey, width: 1 } },
        { x: agg.dates, y: ma7, name: "7-day avg", type: "scatter", mode: "lines",
          line: { color: UBUNTU.orange, width: 2 } },
        { x: agg.dates, y: ma30, name: "30-day avg", type: "scatter", mode: "lines",
          line: { color: UBUNTU.purple, width: 2 } },
      ],
      baseLayout({ title: "Daily downloads with moving averages", yaxis: { title: "Downloads/day" } }),
      PLOTLY_CONFIG
    );

    var cumWrap = chartContainer("chart-cum");
    root.appendChild(cumWrap);
    Plotly.newPlot(
      "chart-cum",
      [{ x: agg.dates, y: Stats.cumulative(agg.counts), name: "Cumulative",
         type: "scatter", mode: "lines", fill: "tozeroy", line: { color: UBUNTU.blue } }],
      baseLayout({ title: "Cumulative downloads", yaxis: { title: "Total downloads" } }),
      PLOTLY_CONFIG
    );
  };

  Views.calendar = function (root, binaries) {
    var agg = Stats.aggregateDaily(countsOf(binaries));
    if (!agg.dates.length) return emptyState(root);

    // Determine available years/months from the data and reset stale selections.
    var years = availableYears(agg.dates);
    if (state.calendarFilter.year !== "all" && years.indexOf(state.calendarFilter.year) === -1) {
      state.calendarFilter.year = "all";
      state.calendarFilter.month = "all";
    }
    var months = availableMonths(agg.dates, state.calendarFilter.year);
    if (state.calendarFilter.month !== "all" && months.indexOf(state.calendarFilter.month) === -1) {
      state.calendarFilter.month = "all";
    }

    // Year/month selector.
    var selector = el("div", "row p-filters");
    var yearCol = el("div", "col-3 col-medium-2");
    yearCol.appendChild(el("label", "u-text--muted", "Year"));
    var yearSel = el("select");
    yearSel.id = "cal-year";
    var yearOpt = el("option"); yearOpt.value = "all"; yearOpt.textContent = "All years"; yearSel.appendChild(yearOpt);
    years.forEach(function (y) {
      var o = el("option"); o.value = y; o.textContent = y; yearSel.appendChild(o);
    });
    yearSel.value = state.calendarFilter.year;
    yearSel.addEventListener("change", function (e) {
      state.calendarFilter.year = e.target.value;
      state.calendarFilter.month = "all";
      render();
    });
    yearCol.appendChild(yearSel);
    selector.appendChild(yearCol);

    var monthCol = el("div", "col-3 col-medium-2");
    monthCol.appendChild(el("label", "u-text--muted", "Month"));
    var monthSel = el("select");
    monthSel.id = "cal-month";
    var monthOpt = el("option"); monthOpt.value = "all"; monthOpt.textContent = "All months"; monthSel.appendChild(monthOpt);
    months.forEach(function (m) {
      var o = el("option"); o.value = m; o.textContent = MONTH_LABELS[parseInt(m, 10) - 1]; monthSel.appendChild(o);
    });
    monthSel.value = state.calendarFilter.month;
    monthSel.addEventListener("change", function (e) {
      state.calendarFilter.month = e.target.value;
      render();
    });
    monthCol.appendChild(monthSel);
    selector.appendChild(monthCol);
    root.appendChild(selector);

    // Filter the daily series by the selected year/month.
    var filtered = filterByYearMonth(agg.dates, agg.counts, state.calendarFilter.year, state.calendarFilter.month);
    if (!filtered.dates.length) {
      emptyState(root);
      return;
    }

    var hm = Stats.calendarHeatmap(filtered.dates, filtered.counts);
    var peakDay = Stats.topPeaks(filtered.dates, filtered.counts, 1)[0];
    var avg = Stats.mean(filtered.counts);

    var grid = el("div", "row stat-cards");
    appendCard(grid, statCard("Days with data", filtered.dates.length, fmt(hm.total) + " total downloads"));
    appendCard(grid, statCard("Peak day", fmt(peakDay.count), peakDay.date + " \u00b7 downloads"));
    appendCard(grid, statCard("Avg / day", fmt(Math.round(avg)), "downloads/day in selection"));
    appendCard(grid, statCard("Busiest weekday", busiestWeekday(filtered.dates, filtered.counts), "by total downloads"));
    root.appendChild(grid);

    var container = chartContainer("chart-cal");
    root.appendChild(container);
    Plotly.newPlot(
      "chart-cal",
      [{
        z: hm.z,
        x: hm.x,
        y: hm.y,
        customdata: hm.customdata,
        type: "heatmap",
        colorscale: [
          [0, "#f2f2f2"], [0.15, "#fde6dc"], [0.35, "#fbb297"],
          [0.6, "#f0784a"], [0.85, "#e95420"], [1, "#a32810"],
        ],
        showscale: true,
        hoverongaps: false,
        hovertemplate: "%{customdata}<br>%{z} downloads<extra></extra>",
        colorbar: { title: "Downloads/day", thickness: 12, len: 0.7 },
      }],
      baseLayout({
        title: "Download calendar (daily intensity)",
        margin: { l: 50, r: 20, t: 40, b: 60 },
        xaxis: {
          type: "date",
          side: "bottom",
          tickformat: "%b %Y",
          tickangle: -45,
          nticks: 12,
          showgrid: false,
        },
        yaxis: {
          autorange: "reversed",
          dtick: 1,
          showgrid: false,
        },
        hovermode: "closest",
      }),
      PLOTLY_CONFIG
    );
  };

  Views.trends = function (root, binaries) {
    var byVersion = groupBy(binaries, function (b) { return Stats.majorVersion(b.source_package); });
    var names = [];
    var wow = [];
    var mom = [];
    var slopes = [];
    byVersion.forEach(function (bins, version) {
      var agg = Stats.aggregateDaily(countsOf(bins));
      names.push(version);
      wow.push(Stats.periodGrowth(agg.counts, 7));
      mom.push(Stats.periodGrowth(agg.counts, 30));
      slopes.push(Stats.linearRegression(agg.counts).slope);
    });

    var chart = chartContainer("chart-growth");
    root.appendChild(chart);
    Plotly.newPlot(
      "chart-growth",
      [
        { x: names, y: wow, name: "Week over week %", type: "bar", marker: { color: UBUNTU.orange } },
        { x: names, y: mom, name: "Month over month %", type: "bar", marker: { color: UBUNTU.purple } },
      ],
      baseLayout({ barmode: "group", title: "Growth by version", yaxis: { title: "% change" }, hovermode: "closest" }),
      PLOTLY_CONFIG
    );

    var section = el("div", "u-fixed-width");
    section.appendChild(el("h2", "p-heading--4", "Trend detail"));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML =
      "<thead><tr><th>Version</th><th class='u-align--right'>Trend (dl/day&sup2;)</th>" +
      "<th class='u-align--right'>WoW</th><th class='u-align--right'>MoM</th></tr></thead>";
    var tbody = el("tbody");
    names.forEach(function (n, i) {
      var tr = el("tr");
      tr.innerHTML =
        "<td data-heading='Version'>" + n + "</td>" +
        "<td data-heading='Trend' class='u-align--right'>" + slopes[i].toFixed(2) + "</td>" +
        "<td data-heading='WoW' class='u-align--right'>" + fmtSigned(wow[i]) + "</td>" +
        "<td data-heading='MoM' class='u-align--right'>" + fmtSigned(mom[i]) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  };

  Views.market = function (root, binaries) {
    var byVersion = groupBy(binaries, function (b) { return Stats.majorVersion(b.source_package); });
    var allDates = new Set();
    var seriesData = [];
    byVersion.forEach(function (bins, version) {
      var agg = Stats.aggregateDaily(countsOf(bins));
      var map = new Map();
      agg.dates.forEach(function (d, i) { map.set(d, agg.counts[i]); });
      agg.dates.forEach(function (d) { allDates.add(d); });
      seriesData.push({ version: version, map: map });
    });
    var dates = Array.from(allDates).sort();
    seriesData.sort(function (a, b) { return a.version.localeCompare(b.version, undefined, { numeric: true }); });

    var traces = seriesData.map(function (s, i) {
      return {
        x: dates,
        y: dates.map(function (d) { return s.map.get(d) || 0; }),
        name: s.version,
        type: "scatter",
        mode: "lines",
        stackgroup: "one",
        groupnorm: "percent",
        line: { color: SERIES_COLORS[i % SERIES_COLORS.length], width: 0.5 },
      };
    });

    var chart = chartContainer("chart-market");
    root.appendChild(chart);
    Plotly.newPlot(
      "chart-market",
      traces,
      baseLayout({ title: "Version market share over time (%)", yaxis: { title: "Share", ticksuffix: "%", range: [0, 100] } }),
      PLOTLY_CONFIG
    );
  };

  Views.breakdowns = function (root, binaries) {
    renderBreakdown(root, binaries, "chart-bd-origin", "By origin", function (b) { return b.origin; });
    renderBreakdown(root, binaries, "chart-bd-series", "By Ubuntu series", function (b) { return b.series; });
    renderBreakdown(root, binaries, "chart-bd-arch", "By architecture", function (b) { return b.architecture; });
    renderBreakdown(root, binaries, "chart-bd-type", "By package type", function (b) { return Stats.packageType(b.name); });
    renderBreakdown(root, binaries, "chart-bd-pocket", "By pocket", function (b) { return b.pocket; });
  };

  function renderBreakdown(root, binaries, id, title, keyFn) {
    var grouped = groupBy(binaries, keyFn);
    var labels = [];
    var values = [];
    grouped.forEach(function (bins, key) {
      labels.push(key);
      values.push(totalCount(bins));
    });
    if (!labels.length) return;
    var col = el("div", "col-6 col-medium-3");
    var container = chartContainer(id);
    container.classList.add("chart-card--grid-item");
    col.appendChild(container);
    if (!root._grid) {
      root._grid = el("div", "row breakdowns-grid");
      root.appendChild(root._grid);
    }
    root._grid.appendChild(col);
    Plotly.newPlot(
      id,
      [{ labels: labels, values: values, type: "pie", hole: 0.4,
         marker: { colors: SERIES_COLORS }, textinfo: "label+percent" }],
      baseLayout({ title: title, margin: { l: 10, r: 10, t: 40, b: 10 }, showlegend: false }),
      PLOTLY_CONFIG
    );
  }

  Views.peaks = function (root, binaries) {
    var agg = Stats.aggregateDaily(countsOf(binaries));
    if (!agg.dates.length) return emptyState(root);
    var anomalies = Stats.anomalies(agg.dates, agg.counts, 2);

    var chart = chartContainer("chart-peaks");
    root.appendChild(chart);
    Plotly.newPlot(
      "chart-peaks",
      [
        { x: agg.dates, y: agg.counts, name: "Daily", type: "scatter", mode: "lines",
          line: { color: UBUNTU.warmGrey } },
        { x: anomalies.map(function (a) { return a.date; }),
          y: anomalies.map(function (a) { return a.count; }),
          name: "Anomaly (>2σ)", type: "scatter", mode: "markers",
          marker: { color: UBUNTU.red, size: 9, symbol: "circle-open", line: { width: 2 } } },
      ],
      baseLayout({ title: "Download spikes and anomalies", yaxis: { title: "Downloads/day" } }),
      PLOTLY_CONFIG
    );

    var peaks = Stats.topPeaks(agg.dates, agg.counts, 10);
    var section = el("div", "u-fixed-width");
    section.appendChild(el("h2", "p-heading--4", "Top 10 peak days"));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML = "<thead><tr><th>Date</th><th class='u-align--right'>Downloads</th></tr></thead>";
    var tbody = el("tbody");
    peaks.forEach(function (p) {
      var tr = el("tr");
      tr.innerHTML = "<td data-heading='Date'>" + p.date + "</td>" +
        "<td data-heading='Downloads' class='u-align--right'>" + fmt(p.count) + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  };

  Views.lifecycle = function (root, binaries) {
    var byVersion = groupBy(binaries, function (b) { return Stats.majorVersion(b.source_package); });
    var traces = [];
    var lifeRows = [];
    var i = 0;
    var versionsSorted = Array.from(byVersion.keys()).sort(function (a, b) {
      return a.localeCompare(b, undefined, { numeric: true });
    });
    versionsSorted.forEach(function (version) {
      var bins = byVersion.get(version);
      var agg = Stats.aggregateDaily(countsOf(bins));
      var ma = Stats.movingAverage(agg.counts, 7);
      traces.push({ x: agg.dates, y: ma, name: version, type: "scatter", mode: "lines",
        line: { color: SERIES_COLORS[i % SERIES_COLORS.length] } });
      var hl = Stats.halfLife(agg.counts, 0.5);
      lifeRows.push({ version: version, hl: hl, total: totalCount(bins) });
      i++;
    });

    var chart = chartContainer("chart-life");
    root.appendChild(chart);
    Plotly.newPlot(
      "chart-life",
      traces,
      baseLayout({ title: "Adoption & decline (7-day avg per version)", yaxis: { title: "Downloads/day" } }),
      PLOTLY_CONFIG
    );

    var section = el("div", "u-fixed-width");
    section.appendChild(el("h2", "p-heading--4", "Decline estimates"));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML =
      "<thead><tr><th>Version</th><th class='u-align--right'>Total</th>" +
      "<th class='u-align--right'>Est. half-life</th></tr></thead>";
    var tbody = el("tbody");
    lifeRows.forEach(function (r) {
      var tr = el("tr");
      tr.innerHTML = "<td data-heading='Version'>" + r.version + "</td>" +
        "<td data-heading='Total' class='u-align--right'>" + fmt(r.total) + "</td>" +
        "<td data-heading='Half-life' class='u-align--right'>" +
        (r.hl ? Math.round(r.hl) + " days" : "<span class='u-text--muted'>growing / stable</span>") + "</td>";
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    section.appendChild(table);
    root.appendChild(section);
  };

  Views.forecast = function (root, binaries) {
    var agg = Stats.aggregateDaily(countsOf(binaries));
    if (agg.dates.length < 10) return emptyState(root);
    var cum = Stats.cumulative(agg.counts);
    var fc = Stats.forecastCumulative(agg.dates, agg.counts, 90, 60);

    var chart = chartContainer("chart-forecast");
    root.appendChild(chart);
    Plotly.newPlot(
      "chart-forecast",
      [
        { x: agg.dates, y: cum, name: "Actual", type: "scatter", mode: "lines",
          line: { color: UBUNTU.blue, width: 2 } },
        { x: fc.dates, y: fc.upper, name: "Upper 95%", type: "scatter", mode: "lines",
          line: { width: 0 }, showlegend: false },
        { x: fc.dates, y: fc.lower, name: "Confidence band", type: "scatter", mode: "lines",
          fill: "tonexty", fillcolor: "rgba(233,84,32,0.15)", line: { width: 0 } },
        { x: fc.dates, y: fc.values, name: "Forecast (90d)", type: "scatter", mode: "lines",
          line: { color: UBUNTU.orange, width: 2, dash: "dash" } },
      ],
      baseLayout({ title: "Cumulative download forecast (next 90 days)", yaxis: { title: "Total downloads" } }),
      PLOTLY_CONFIG
    );
  };

  function emptyState(root) {
    var box = el("div", "p-strip is-shallow");
    box.innerHTML =
      "<div class='p-empty-state'>" +
      "<h3 class='p-empty-state__title'>No data</h3>" +
      "<p class='p-empty-state__message'>No download counts match the current filters.</p></div>";
    root.appendChild(box);
  }

  // --------------------------------------------------------------------- //
  // Monthly executive report
  //
  // All arithmetic comes from Report.buildReport, so this view and the archived
  // PDF (which is this view printed by a headless browser) can never disagree.
  // The view deliberately ignores the global filter bar: an archived report must
  // be reproducible from the month alone.
  // --------------------------------------------------------------------- //

  /* Printable width of A4 in CSS pixels with the 14mm margins declared in
   * style.css: 210mm - 28mm = 182mm = 7.17in = 688px at the 96dpi browsers use
   * for print layout. A little is held back so no chart is clipped at the right
   * edge. Plotly needs an explicit width when printing because its responsive
   * resizing does not run during print layout. */
  var PRINT_CHART_WIDTH = 676;
  var PRINT_CHART_WIDTH_HALF = 330;

  function shortMonth(month) {
    return MONTH_LABELS[parseInt(month.slice(5, 7), 10) - 1] + " " + month.slice(0, 4);
  }

  function fmtPp(value) {
    if (value == null) return "n/a";
    return (value >= 0 ? "+" : "") + value.toFixed(1) + "pp";
  }

  // Coloured delta, for use inside table cells and card subtitles.
  function deltaHtml(pct, formatter) {
    if (pct == null) return "<span class='u-text--muted'>n/a</span>";
    var f = formatter || fmtSigned;
    var cls = pct > 0 ? "report-delta--up" : pct < 0 ? "report-delta--down" : "";
    return "<span class='report-delta " + cls + "'>" + f(pct) + "</span>";
  }

  function reportSection(root, title, subtitle, extraClass) {
    var section = el("section", "report-page" + (extraClass ? " " + extraClass : ""));
    var head = el("div", "u-fixed-width report-page__head");
    head.appendChild(el("h2", "p-heading--3 u-no-margin--bottom", title));
    if (subtitle) head.appendChild(el("p", "u-text--muted", subtitle));
    section.appendChild(head);
    root.appendChild(section);
    return section;
  }

  /* Create a report note paragraph. In print mode, Vanilla's `p { max-width:
   * 40em }` reasserts despite CSS overrides (Chrome's print-to-pdf can drop
   * @media-print properties), so the max-width is set inline too. */
  function reportNote(text) {
    return el("p", "u-text--muted report-note", text);
  }

  function reportTable(parent, title, head, rowsHtml, note) {
    var wrap = el("div", "u-fixed-width report-table");
    if (title) wrap.appendChild(el("h3", "p-heading--5", title));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML = "<thead><tr>" + head + "</tr></thead><tbody>" + rowsHtml + "</tbody>";
    wrap.appendChild(table);
    if (note) wrap.appendChild(reportNote(note));
    parent.appendChild(wrap);
    return wrap;
  }

  /* Plot a report chart. Returns a promise so the caller can signal readiness to
   * the headless renderer once every chart has drawn.
   *
   * opts: { height, printHeight, printWidth }
   * Print sizes are explicit because Plotly's responsive resizing does not run
   * during print layout, and because a half-width chart needs a narrower SVG.
   */
  function reportPlot(parent, id, opts, traces, layout) {
    var o = opts || {};
    var screenHeight = o.height || 300;
    var printHeight = o.printHeight || Math.round(screenHeight * 0.8);
    var card = chartContainer(id);
    card.classList.add("chart-card--report");
    var plot = card.querySelector(".chart");
    plot.style.height = (printMode.active ? printHeight : screenHeight) + "px";
    parent.appendChild(card);

    var l = baseLayout(layout);
    var cfg = PLOTLY_CONFIG;
    if (printMode.active) {
      l.width = o.printWidth || PRINT_CHART_WIDTH;
      l.height = printHeight;
      l.autosize = false;
      cfg = { staticPlot: true, displayModeBar: false, responsive: false };
    }
    return Plotly.newPlot(id, traces, l, cfg);
  }

  /* A row holding two half-width charts side by side, on screen and on paper. */
  function chartRow(parent) {
    var row = el("div", "row report-chart-row");
    parent.appendChild(row);
    return {
      cell: function () {
        var col = el("div", "col-6 col-medium-3");
        row.appendChild(col);
        return col;
      },
    };
  }

  Views.report = function (root, binaries) {
    // The archive sub-view is reachable from the report toolbar's "Report
    // archive" button. It renders within the same nav item ("Monthly report"
    // stays active) rather than navigating to a separate page.
    if (state.reportSubView === "archive") {
      renderArchiveView(root);
      return;
    }

    var months = Report.monthRange(binaries);
    if (!months.length) return emptyState(root);

    // Resolve the month to report on: explicit selection, print-mode request,
    // else the most recent month the dataset fully covers.
    var month = state.reportMonth;
    if (!month || months.indexOf(month) === -1) {
      month = Report.latestCompleteMonth(binaries) || months[months.length - 1];
      if (months.indexOf(month) === -1) month = months[months.length - 1];
      state.reportMonth = month;
    }

    var facts = Report.buildReport(binaries, month, { windowMonths: 13, topN: 10 });
    var plots = [];

    /* Printed only if the browser prints before every chart has drawn; see the
     * .is-report-ready guard in style.css. */
    var warning = el("div", "u-fixed-width report-render-warning",
      "This report did not finish rendering: the charts had not drawn when the " +
      "page was printed. Do not use this file. Regenerate it with " +
      "scripts/print_report.py.");
    root.appendChild(warning);

    if (!printMode.active) renderReportToolbar(root, months, facts);
    renderReportCover(root, facts);
    renderReportGlance(root, facts, plots);
    if (facts.status !== "no_data") {
      renderReportComposition(root, facts, plots);
      renderReportTrajectory(root, facts, plots);
    }
    renderReportMethod(root, facts);
    if (state.reportAppendix || printMode.appendix) renderReportAppendix(root, facts);

    // Signal completion for the headless PDF renderer (and the test harness).
    window.__reportReady = false;
    window.__reportMonth = month;
    Promise.all(plots)
      .then(function () {
        window.__reportReady = true;
        document.body.classList.add("is-report-ready");
      })
      .catch(function (err) {
        window.__reportError = String((err && err.message) || err);
        window.__reportReady = true;
      });
  };

  // The archive sub-view: year-separated tables of every archived report.
  // Reads from the manifest loaded at boot. "Monthly report" stays active in
  // the sidebar; a "Back to report" button returns to the month view.
  function renderArchiveView(root) {
    var bar = el("div", "u-fixed-width report-toolbar u-no-print");
    var actions = el("div", "report-toolbar__actions");
    var back = el("button", "p-button", "Back to report");
    back.addEventListener("click", function () {
      state.reportSubView = "report";
      render();
    });
    actions.appendChild(back);
    bar.appendChild(actions);
    root.appendChild(bar);

    if (!state.manifest || !state.manifest.reports || !state.manifest.reports.length) {
      var box = el("div", "u-fixed-width");
      box.appendChild(el("p", "u-text--muted",
        "No archived reports. Reports are generated by the monthly workflow; " +
        "until one has run you can still build any month on demand from the " +
        "toolbar above."));
      root.appendChild(box);
      return;
    }

    var manifest = state.manifest;
    var meta = el("div", "u-fixed-width");
    meta.appendChild(el("p", "u-text--muted",
      "Manifest generated " +
      (manifest.generated_at || "").replace("T", " ").replace("Z", " UTC") +
      " · data window " + (manifest.data_window || {}).first + " to " +
      (manifest.data_window || {}).last + " · " + manifest.reports.length +
      " months"));
    root.appendChild(meta);

    var STATUS = {
      ok: { label: "Complete", cls: "positive" },
      partial: { label: "Partial month", cls: "caution" },
      insufficient_data: { label: "Insufficient data", cls: "caution" },
      no_data: { label: "No data", cls: "negative" },
    };

    var head =
      "<thead><tr><th>Month</th>" +
      "<th class='u-align--right'>Downloads</th>" +
      "<th class='u-align--right'>Coverage</th>" +
      "<th>Status</th><th>Archived PDF</th><th>On demand</th></tr></thead>";

    // Group entries by year. The manifest is newest-first, so years come out
    // in descending order naturally.
    var years = [];
    var byYear = {};
    manifest.reports.forEach(function (r) {
      var y = r.month.slice(0, 4);
      if (!byYear[y]) { byYear[y] = []; years.push(y); }
      byYear[y].push(r);
    });

    var list = el("div", "u-fixed-width");
    years.forEach(function (year) {
      var section = el("div", "report-archive-year");
      section.appendChild(el("h2", "p-heading--3", year));

      var rows = byYear[year].map(function (r) {
        var status = STATUS[r.status] || { label: r.status, cls: "" };
        var pdf = r.pdf
          ? "<a href='" + state.manifestBase + r.pdf + "' download>PDF</a>" +
            (r.pdf_bytes
              ? " <span class='u-text--muted'>(" +
                Math.round(r.pdf_bytes / 1024) + " kB)</span>"
              : "")
          : "<span class='u-text--muted'>not archived</span>";
        return (
          "<tr>" +
          "<td data-heading='Month'>" + (r.label || "").split(" ")[0] + "</td>" +
          "<td data-heading='Downloads' class='u-align--right'>" +
          (r.total ? fmt(r.total) : "&mdash;") + "</td>" +
          "<td data-heading='Coverage' class='u-align--right'>" +
          r.days_with_data + "/" + r.days_expected +
          " days (" + r.coverage_pct.toFixed(0) + "%)</td>" +
          "<td data-heading='Status'><span class='p-status-label--" +
          status.cls + "'>" + status.label + "</span></td>" +
          "<td data-heading='Archived'>" + pdf + "</td>" +
          "<td data-heading='Live'><a href='index.html?month=" + r.month +
          "'>Open in dashboard</a></td>" +
          "</tr>"
        );
      }).join("");

      var table = el("table", "p-table--mobile-card");
      table.innerHTML = head + "<tbody>" + rows + "</tbody>";
      section.appendChild(table);
      list.appendChild(section);
    });
    root.appendChild(list);

    // Signal readiness immediately — no charts to wait for.
    window.__reportReady = true;
    document.body.classList.add("is-report-ready");
  }

  function renderReportToolbar(root, months, facts) {
    var bar = el("div", "u-fixed-width report-toolbar u-no-print");

    // Two-level month picker: a Year select, then a Month select restricted to
    // that year. Mirrors the Calendar view's year/month pattern. Months with no
    // data stay selectable (a gap month is worth reporting on) but are marked.
    var yearWrap = el("div", "report-toolbar__field");
    var yearLabel = el("label", "u-text--muted", "Year");
    yearLabel.setAttribute("for", "report-year");
    yearWrap.appendChild(yearLabel);
    var yearSel = el("select", "u-no-margin--bottom");
    yearSel.id = "report-year";
    yearWrap.appendChild(yearSel);

    var monthWrap = el("div", "report-toolbar__field");
    var monthLabel = el("label", "u-text--muted", "Month");
    monthLabel.setAttribute("for", "report-month");
    monthWrap.appendChild(monthLabel);
    var monthSel = el("select", "u-no-margin--bottom");
    monthSel.id = "report-month";
    monthWrap.appendChild(monthSel);

    // Distinct years, newest first.
    var years = [];
    months.forEach(function (m) {
      var y = m.slice(0, 4);
      if (years.indexOf(y) === -1) years.push(y);
    });
    years.reverse();
    years.forEach(function (y) {
      var o = el("option");
      o.value = y;
      o.textContent = y;
      yearSel.appendChild(o);
    });

    // Months of the currently selected year, newest first.
    function fillMonths(year) {
      monthSel.innerHTML = "";
      months.slice().reverse().forEach(function (m) {
        if (m.slice(0, 4) !== year) return;
        var o = el("option");
        o.value = m;
        o.textContent = Report.monthLabel(m).split(" ")[0] +
          (monthHasData(m) ? "" : " (no data)");
        monthSel.appendChild(o);
      });
    }

    yearSel.value = facts.month.slice(0, 4);
    fillMonths(yearSel.value);
    monthSel.value = facts.month;

    yearSel.addEventListener("change", function (e) {
      fillMonths(e.target.value);
      // Jump to the most recent month of the newly selected year.
      if (monthSel.options.length) {
        state.reportMonth = monthSel.options[0].value;
        render();
      }
    });
    monthSel.addEventListener("change", function (e) {
      state.reportMonth = e.target.value;
      render();
    });

    // Keep the two selects together on the left, as in the Calendar view, with
    // the actions on the right.
    var picker = el("div", "report-toolbar__picker");
    picker.appendChild(yearWrap);
    picker.appendChild(monthWrap);
    bar.appendChild(picker);

    var actions = el("div", "report-toolbar__actions");

    var appendixLabel = el("label", "p-switch");
    appendixLabel.innerHTML =
      "<input type='checkbox' class='p-switch__input' id='report-appendix'" +
      (state.reportAppendix ? " checked" : "") + " />" +
      "<span class='p-switch__slider'></span>" +
      "<span class='p-switch__label'>Appendix</span>";
    appendixLabel.querySelector("input").addEventListener("change", function (e) {
      state.reportAppendix = e.target.checked;
      render();
    });
    actions.appendChild(appendixLabel);

    var archived = archivedReport(facts.month);
    if (archived) {
      var link = el("a", "p-button", "Download archived PDF");
      link.href = archived;
      link.setAttribute("download", "");
      actions.appendChild(link);
    }

    var archive = el("button", "p-button", "Report archive");
    archive.title = "Browse every archived monthly report";
    archive.addEventListener("click", function () {
      state.reportSubView = "archive";
      render();
    });
    actions.appendChild(archive);

    var print = el("button", "p-button--positive u-no-margin--bottom", "Save as PDF");
    print.id = "report-print";
    print.addEventListener("click", function () {
      printReport(facts.month);
    });
    actions.appendChild(print);

    bar.appendChild(actions);
    root.appendChild(bar);
  }

  function monthHasData(month) {
    if (!state._monthTotals) {
      state._monthTotals = Report.monthlyTotals(Report.canonicalBinaries(state.binaries));
    }
    return (state._monthTotals.get(month) || 0) > 0;
  }

  function renderReportCover(root, facts) {
    var cover = el("header", "u-fixed-width report-cover");
    cover.appendChild(el("p", "report-cover__eyebrow", "Executive report"));
    cover.appendChild(el("h2", "p-heading--2 u-no-margin--bottom",
      ".NET on Ubuntu \u2014 " + facts.monthLabel));
    cover.appendChild(el("p", "u-text--muted u-no-margin--bottom",
      "Package download statistics for the dotnet/backports PPA on Launchpad."));

    var meta = el("dl", "report-meta");
    var scope = facts.scope;
    var rows = [
      ["Reporting period", facts.monthLabel + " (" + Report.monthStart(facts.month) +
        " to " + Report.monthEnd(facts.month) + ", UTC)"],
      ["Data window", (scope.datasetFirst || "n/a") + " to " + (scope.datasetLast || "n/a")],
      ["Generated", new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"],
      ["Origin", scope.origins.map(originLabel).join(", ") || "n/a"],
      ["Scope", scope.sourcePackages.join(", ") + " \u00b7 all Ubuntu series and " +
        "architectures \u00b7 debug-symbol packages excluded"],
    ];
    rows.forEach(function (r) {
      meta.appendChild(el("dt", null, r[0]));
      meta.appendChild(el("dd", null, r[1]));
    });
    cover.appendChild(meta);
    root.appendChild(cover);
  }

  // Status banner: the honest read of how usable the month is.
  function renderReportStatus(parent, facts) {
    var cov = facts.coverage;
    if (facts.status === "ok") return;
    var kind = facts.status === "ok" ? "information" : "caution";
    var msg;
    if (facts.status === "no_data") {
      msg = "<strong>No data for " + facts.monthLabel + ".</strong> No download " +
        "counts were recorded for any day of this month, which indicates a " +
        "collection gap rather than an absence of usage. Nothing in this report " +
        "may be read as a decline.";
    } else if (facts.status === "insufficient_data") {
      msg = "<strong>Insufficient data.</strong> Only " + cov.daysWithData + " of " +
        cov.daysExpected + " days carry download counts (" +
        cov.coveragePct.toFixed(0) + "%). Totals and comparisons on this page are " +
        "not representative of the month.";
    } else {
      msg = "<strong>Partial month.</strong> " + cov.daysWithData + " of " +
        cov.daysExpected + " days carry download counts (" +
        cov.coveragePct.toFixed(0) + "%)" +
        (cov.complete ? "" : "; the month is still in progress") +
        ". Totals understate actual volume.";
    }
    var box = el("div", "u-fixed-width report-status");
    box.innerHTML =
      "<div class='p-notification--" + kind + "'><div class='p-notification__content'>" +
      "<p class='p-notification__message'>" + msg + "</p></div></div>";
    parent.appendChild(box);
  }

  // ------------------------------ Page 1 ------------------------------- //

  function renderReportGlance(root, facts, plots) {
    var section = reportSection(root, "At a glance",
      "Headline volume and the month's most material movements.");
    renderReportStatus(section, facts);

    var t = facts.totals;
    var ns = facts.northStar;
    var grid = el("div", "row stat-cards");

    if (facts.status === "no_data") {
      /* A month with no counts at all would otherwise show "0 downloads" and
       * "-100%", which reads as a collapse in usage. Only the figures that stay
       * true across a collection gap are shown. */
      appendCard(grid, statCard("Downloads in month", "no data",
        "collection gap for " + facts.monthLabel));
      appendCard(grid, statCard("Days with data", 0,
        "of " + facts.coverage.daysInMonth + " days in the month"));
      appendCard(grid, statCard("Lifetime to month end", t.cumulativeToEnd,
        "cumulative since " + (facts.scope.datasetFirst || "n/a")));
      appendCard(grid, statCard("Collector last run", facts.scope.datasetLast || "n/a",
        "latest date present in the dataset"));
    } else {
      appendCard(grid, statCard("Downloads in month", t.month,
        "vs " + facts.prevMonthLabel + ": " + deltaHtml(t.momPct)));
      appendCard(grid, statCard("Average per day", Math.round(t.avgPerDay),
        "over " + facts.coverage.daysWithData + " days with data"));
      appendCard(grid, statCard("Year on year", Report.growthLabel(t.yoyPct),
        t.yoyMonth == null ? "no comparable month" : "vs " + facts.yoyMonthLabel +
          " (" + fmt(t.yoyMonth) + ")"));
      appendCard(grid, statCard("Peak day", t.peak ? t.peak.count : "n/a",
        t.peak ? t.peak.date : "no data"));
      appendCard(grid, statCard("Leading version", ns.leadingVersion || "n/a",
        ns.leadingSharePct == null ? "" : ns.leadingSharePct.toFixed(1) +
          "% of the month \u00b7 " + ns.activeVersionCount + " active versions"));
      appendCard(grid, statCard("Newest version share",
        ns.newestSharePct == null ? "n/a" : ns.newestSharePct.toFixed(1) + "%",
        (ns.newestVersion || "n/a") + " \u00b7 " + deltaHtml(ns.newestShareDeltaPp, fmtPp)));
      appendCard(grid, statCard("SDK per runtime download",
        facts.devIntent.ratioNow == null ? "n/a" : facts.devIntent.ratioNow.toFixed(2),
        "developer-intent proxy \u00b7 " + deltaHtml(facts.devIntent.ratioDeltaPct)));
      appendCard(grid, statCard("Lifetime to month end", t.cumulativeToEnd,
        "cumulative since " + (facts.scope.datasetFirst || "n/a")));
    }
    section.appendChild(grid);

    // Key findings.
    var findings = Report.findings(facts, 5);
    if (findings.length) {
      var box = el("div", "u-fixed-width report-findings");
      box.appendChild(el("h3", "p-heading--5", "Key findings"));
      var ul = el("ul", "p-list--divided u-no-margin--bottom");
      findings.forEach(function (f) {
        var li = el("li", "p-list__item report-finding report-finding--" + f.tone);
        li.innerHTML = f.text;
        ul.appendChild(li);
      });
      box.appendChild(ul);
      section.appendChild(box);
    }

    // Hero chart: monthly totals over the trailing window.
    var w = facts.window;
    var colors = w.months.map(function (m) {
      return m === facts.month ? UBUNTU.orange : UBUNTU.warmGrey;
    });
    // Months with no data at all are annotated so a gap is never mistaken for a
    // collapse in usage.
    var annotations = [];
    w.months.forEach(function (m, i) {
      if (w.totals[i] === 0) {
        annotations.push({
          x: shortMonth(m), y: 0, text: "no data", showarrow: false,
          font: { size: 10, color: UBUNTU.red }, textangle: -90,
          yanchor: "bottom", xanchor: "center",
        });
      }
    });
    plots.push(reportPlot(section, "rep-chart-months", { height: 300, printHeight: 235 },
      [{
        x: w.months.map(shortMonth),
        y: w.totals,
        type: "bar",
        name: "Downloads",
        marker: { color: colors },
        hovertemplate: "%{x}<br>%{y:,} downloads<extra></extra>",
      }],
      {
        title: "Monthly downloads, last " + w.months.length + " months",
        yaxis: { title: "Downloads" },
        xaxis: { type: "category", tickangle: -45 },
        margin: { l: 60, r: 20, t: 30, b: 70 },
        showlegend: false,
        annotations: annotations,
        hovermode: "closest",
      }
    ));

    // Daily shape of the month, overlaid on the previous month.
    if (facts.daily.dates.length) {
      var days = Report.daysInMonth(facts.month);
      var byDay = seriesByDayOfMonth(facts.daily, days);
      var prevDays = Report.daysInMonth(facts.prevMonth);
      var prevByDay = seriesByDayOfMonth(facts.prevDaily, prevDays);
      var x = [];
      for (var d = 1; d <= days; d++) x.push(d);
      plots.push(reportPlot(section, "rep-chart-daily", { height: 300, printHeight: 235 },
        [
          { x: x, y: prevByDay.values, name: facts.prevMonthLabel, type: "scatter",
            mode: "lines", line: { color: UBUNTU.warmGrey, width: 1, dash: "dot" } },
          { x: x, y: byDay.values, name: facts.monthLabel, type: "scatter",
            mode: "lines+markers", line: { color: UBUNTU.orange, width: 2 },
            marker: { size: 4 } },
          { x: x, y: byDay.ma7, name: "7-day average", type: "scatter", mode: "lines",
            line: { color: UBUNTU.purple, width: 2 } },
        ],
        {
          // No x-axis title: it would collide with the horizontal legend, and
          // the tick values already read as days of the month.
          title: "Daily downloads through the month (day of month on x axis)",
          xaxis: { dtick: 2 },
          yaxis: { title: "Downloads/day" },
          legend: { orientation: "h", y: -0.22 },
          margin: { l: 60, r: 25, t: 30, b: 55 },
        }
      ));
    }
  }

  /* Map a daily series onto day-of-month positions. Missing days stay null so
   * the line breaks instead of implying zero downloads, and the moving average
   * is suppressed for any window that spans a gap. */
  function seriesByDayOfMonth(daily, days) {
    var byDate = new Map();
    for (var i = 0; i < daily.dates.length; i++) {
      byDate.set(parseInt(daily.dates[i].slice(8, 10), 10), daily.counts[i]);
    }
    var values = [];
    for (var d = 1; d <= days; d++) {
      values.push(byDate.has(d) ? byDate.get(d) : null);
    }
    var filled = values.map(function (v) { return v == null ? 0 : v; });
    var ma = Stats.movingAverage(filled, 7);
    for (var j = 0; j < ma.length; j++) {
      for (var k = Math.max(0, j - 6); k <= j; k++) {
        if (values[k] == null) { ma[j] = null; break; }
      }
    }
    return { values: values, ma7: ma };
  }

  // ------------------------------ Page 2 ------------------------------- //

  function renderReportComposition(root, facts, plots) {
    var section = reportSection(root, "Composition & adoption",
      "Which .NET releases, Ubuntu series and architectures the downloads came " +
      "from, and how the mix moved.");

    // Version mix over the window (100% stacked).
    var w = facts.window;
    var traces = facts.versionSeries.map(function (row, i) {
      return {
        x: w.months.map(shortMonth),
        y: row.totals,
        name: row.key,
        type: "scatter",
        mode: "lines",
        stackgroup: "one",
        groupnorm: "percent",
        line: { color: SERIES_COLORS[i % SERIES_COLORS.length], width: 0.5 },
      };
    });
    plots.push(reportPlot(section, "rep-chart-versionmix",
      { height: 300, printHeight: 240 }, traces, {
      title: "Share of downloads by .NET version",
      xaxis: { type: "category", tickangle: -45 },
      yaxis: { title: "Share", ticksuffix: "%", range: [0, 100] },
      margin: { l: 60, r: 45, t: 30, b: 70 },
    }));

    reportTable(section, "Version detail",
      "<th>Version</th><th class='u-align--right'>Downloads</th>" +
      "<th class='u-align--right'>Share</th><th class='u-align--right'>MoM</th>" +
      "<th class='u-align--right'>Share change</th>",
      facts.versions.rows.filter(function (r) { return r.total > 0; }).map(function (r) {
        return "<tr><td data-heading='Version'>" + r.key + "</td>" +
          "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>" +
          "<td data-heading='Share' class='u-align--right'>" + r.sharePct.toFixed(1) + "%</td>" +
          "<td data-heading='MoM' class='u-align--right'>" + deltaHtml(r.momPct) + "</td>" +
          "<td data-heading='Share change' class='u-align--right'>" +
          deltaHtml(r.shareDeltaPp, fmtPp) + "</td></tr>";
      }).join(""),
      "Share change is in percentage points against " + facts.prevMonthLabel + "."
    );

    // Ubuntu series and architecture, current versus previous month, paired so
    // the platform picture fits on one page.
    var platformRowLayout = {
      xaxis: { type: "category" },
      yaxis: { title: "Downloads" },
      barmode: "group",
      hovermode: "closest",
      legend: { orientation: "h", y: -0.25 },
      margin: { l: 55, r: 30, t: 30, b: 60 },
    };
    var row = chartRow(section);
    var halfPrint = {
      height: 280, printHeight: 220, printWidth: PRINT_CHART_WIDTH_HALF,
    };
    plots.push(reportPlot(row.cell(), "rep-chart-series", halfPrint,
      pairedBars(facts.series, facts, 5),
      Object.assign({ title: "By Ubuntu series" }, platformRowLayout)
    ));
    plots.push(reportPlot(row.cell(), "rep-chart-arch", halfPrint,
      pairedBars(facts.arch, facts, 5),
      Object.assign({ title: "By architecture" }, platformRowLayout)
    ));

    var platformHead =
      "<th>Value</th><th class='u-align--right'>Downloads</th>" +
      "<th class='u-align--right'>Share</th>" +
      "<th class='u-align--right'>" + facts.prevMonthLabel + "</th>" +
      "<th class='u-align--right'>MoM</th>";

    reportTable(section, "Ubuntu series detail", platformHead,
      facts.series.rows.filter(function (r) { return r.total > 0; })
        .map(platformRow).join(""),
      "LTS series (" + (facts.northStar.ltsSeries.join(", ") || "none known") +
      ") account for " + facts.northStar.ltsSharePct.toFixed(1) + "% of the month, " +
      deltaHtml(facts.northStar.ltsShareDeltaPp, fmtPp) + " on " + facts.prevMonthLabel + "."
    );

    reportTable(section, "Architecture detail", platformHead,
      facts.arch.rows.filter(function (r) { return r.total > 0; })
        .map(platformRow).join("")
    );

    // Developer intent: SDK versus runtime-only volume, and the ratio.
    var di = facts.devIntent;
    plots.push(reportPlot(section, "rep-chart-devintent",
      { height: 300, printHeight: 240 },
      [
        { x: di.months.map(shortMonth), y: di.sdkTotals, name: "SDK", type: "bar",
          marker: { color: UBUNTU.orange } },
        { x: di.months.map(shortMonth), y: di.runtimeTotals, name: "Runtime only",
          type: "bar", marker: { color: UBUNTU.blue } },
        { x: di.months.map(shortMonth), y: di.ratio, name: "SDK per runtime",
          type: "scatter", mode: "lines+markers", yaxis: "y2",
          line: { color: UBUNTU.purple, width: 2 } },
      ],
      {
        title: "Developer intent: SDK versus runtime-only downloads",
        xaxis: { type: "category", tickangle: -45 },
        yaxis: { title: "Downloads" },
        yaxis2: { title: "Ratio", overlaying: "y", side: "right", rangemode: "tozero" },
        barmode: "group",
        legend: { orientation: "h", y: -0.38 },
        margin: { l: 60, r: 60, t: 30, b: 95 },
      }
    ));

    reportTable(section, "Top packages this month",
      "<th>Package</th><th>Type</th><th class='u-align--right'>Downloads</th>" +
      "<th class='u-align--right'>MoM</th>",
      facts.topBinaries.map(function (r) {
        return "<tr><td data-heading='Package'>" + r.name + "</td>" +
          "<td data-heading='Type'><span class='p-chip'><span class='p-chip__value'>" +
          r.type + "</span></span></td>" +
          "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>" +
          "<td data-heading='MoM' class='u-align--right'>" + deltaHtml(r.momPct) +
          "</td></tr>";
      }).join(""),
      "SDK downloads indicate development and build environments; runtime-only " +
      "downloads indicate deployment targets. Neither is a count of people."
    );
  }

  function platformRow(r) {
    return "<tr><td data-heading='Value'>" + r.key + "</td>" +
      "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>" +
      "<td data-heading='Share' class='u-align--right'>" + r.sharePct.toFixed(1) + "%</td>" +
      "<td data-heading='Previous' class='u-align--right'>" + fmt(r.prevTotal) + "</td>" +
      "<td data-heading='MoM' class='u-align--right'>" + deltaHtml(r.momPct) + "</td></tr>";
  }

  // Current month against the previous month for the top-N keys of a dimension.
  function pairedBars(dim, facts, topN) {
    var rows = dim.rows.filter(function (r) { return r.total > 0 || r.prevTotal > 0; })
      .slice(0, topN);
    return [
      { x: rows.map(function (r) { return r.key; }),
        y: rows.map(function (r) { return r.prevTotal; }),
        name: facts.prevMonthLabel, type: "bar",
        marker: { color: UBUNTU.warmGrey } },
      { x: rows.map(function (r) { return r.key; }),
        y: rows.map(function (r) { return r.total; }),
        name: facts.monthLabel, type: "bar",
        marker: { color: UBUNTU.orange } },
    ];
  }

  // ------------------------------ Page 3 ------------------------------- //

  function renderReportTrajectory(root, facts, plots) {
    var section = reportSection(root, "Trajectory & watch items",
      "Where the trend is heading, and what needs a human explanation.");

    if (facts.forecast) {
      var fc = facts.forecast;
      // Actual cumulative history at month-end resolution, stopping at the
      // reported month so the projection continues from the right point.
      var hist = facts.history;
      var histX = [];
      var histY = [];
      var running = 0;
      for (var i = 0; i < hist.months.length; i++) {
        if (hist.months[i] > facts.month) break;
        running += hist.totals[i];
        histX.push(Report.monthEnd(hist.months[i]));
        histY.push(running);
      }
      plots.push(reportPlot(section, "rep-chart-forecast",
        { height: 300, printHeight: 240 },
        [
          { x: histX, y: histY, name: "Actual (month ends)", type: "scatter",
            mode: "lines", line: { color: UBUNTU.blue, width: 2 } },
          { x: fc.dates, y: fc.upper, name: "Upper 95%", type: "scatter", mode: "lines",
            line: { width: 0 }, showlegend: false },
          { x: fc.dates, y: fc.lower, name: "Confidence band", type: "scatter",
            mode: "lines", fill: "tonexty", fillcolor: "rgba(233,84,32,0.15)",
            line: { width: 0 } },
          { x: fc.dates, y: fc.values, name: "Projection", type: "scatter", mode: "lines",
            line: { color: UBUNTU.orange, width: 2, dash: "dash" } },
        ],
        {
          title: "Cumulative downloads projected through " + fc.nextMonthLabel,
          yaxis: { title: "Cumulative downloads" },
          xaxis: { type: "date" },
        }
      ));

      var note = el("div", "u-fixed-width report-note");
      note.innerHTML =
        "Projection fits the daily rate of the 60 days to " +
        Report.monthEnd(facts.month) + " and extrapolates linearly; it assumes no " +
        "new release events. Indicative total for " + fc.nextMonthLabel + ": <strong>" +
        fmt(fc.nextMonthTotal) + "</strong> downloads." +
        (fc.lowConfidence
          ? " <span class='report-delta--down'>Only " +
            fc.fitCoveragePct.toFixed(0) + "% of the fit window carries data, so " +
            "treat this figure as a lower bound at best.</span>"
          : "");
      section.appendChild(note);
    }

    reportTable(section, "Momentum by version",
      "<th>Version</th><th class='u-align--right'>Downloads in month</th>" +
      "<th class='u-align--right'>Last 7d vs prior 7d</th>" +
      "<th class='u-align--right'>Last 30d vs prior 30d</th>" +
      "<th class='u-align--right'>Trend (dl/day&sup2;)</th>" +
      "<th class='u-align--right'>Est. half-life</th>",
      facts.momentum.map(function (r) {
        return "<tr><td data-heading='Version'>" + r.version + "</td>" +
          "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>" +
          "<td data-heading='7d' class='u-align--right'>" + deltaHtml(r.wowPct) + "</td>" +
          "<td data-heading='30d' class='u-align--right'>" + deltaHtml(r.momPct) + "</td>" +
          "<td data-heading='Trend' class='u-align--right'>" + r.slope.toFixed(1) + "</td>" +
          "<td data-heading='Half-life' class='u-align--right'>" +
          (r.halfLifeDays
            ? Math.round(r.halfLifeDays) + " days"
            : "<span class='u-text--muted'>growing / stable</span>") +
          "</td></tr>";
      }).join(""),
      "Windows end on " + Report.monthEnd(facts.month) +
      ". Days without data are treated as zero inside these windows, so a " +
      "collection gap depresses the figures."
    );

    if (facts.anomalies.length) {
      reportTable(section, "Days needing explanation",
        "<th>Date</th><th class='u-align--right'>Downloads</th>" +
        "<th class='u-align--right'>Above month mean</th>",
        facts.anomalies.slice(0, 8).map(function (a) {
          return "<tr><td data-heading='Date'>" + a.date + "</td>" +
            "<td data-heading='Downloads' class='u-align--right'>" + fmt(a.count) + "</td>" +
            "<td data-heading='Sigma' class='u-align--right'>" + a.sigma.toFixed(1) +
            "\u03c3</td></tr>";
        }).join(""),
        "Days more than two standard deviations above the month's mean. Common " +
        "causes are release publications, mirror synchronisation and CI bursts."
      );
    }

    // Data coverage.
    var cov = facts.coverage;
    var gapText = cov.gaps.length
      ? cov.gaps.map(function (g) {
          return g.from === g.to ? g.from : g.from + " to " + g.to;
        }).join(", ")
      : "none";
    reportTable(section, "Data coverage",
      "<th>Measure</th><th class='u-align--right'>Value</th>",
      [
        ["Days in month", cov.daysInMonth],
        ["Days expected in window", cov.daysExpected],
        ["Days with download counts", cov.daysWithData],
        ["Coverage", cov.coveragePct.toFixed(1) + "%"],
        ["Missing days", cov.daysMissing],
        ["Gaps", gapText],
        ["Month fully elapsed in dataset", cov.complete ? "yes" : "no"],
        ["Publications active in month", fmt(facts.scope.activeBinaries)],
        ["Publications first seen in month", fmt(facts.scope.newBinaries)],
        ["Collector last run", facts.scope.datasetLast || "n/a"],
      ].map(function (r) {
        return "<tr><td data-heading='Measure'>" + r[0] +
          "</td><td data-heading='Value' class='u-align--right'>" + r[1] + "</td></tr>";
      }).join(""),
      "A publication is one binary package version in one series and architecture. " +
      "A burst of first-seen publications usually follows a release upload or a " +
      "resumed collection window, not a change in demand."
    );
  }

  function renderReportMethod(root, facts) {
    var section = el("section", "report-page");
    var box = el("div", "u-fixed-width");
    box.appendChild(el("h2", "p-heading--4", "Methodology & limitations"));
    var ul = el("ul", "p-list");
    Report.LIMITATIONS.forEach(function (line) {
      var li = el("li", "p-list__item", line);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var source = reportNote(
      "Source: Launchpad download counts for " +
      facts.scope.origins.map(originLabel).join(", ") +
      ". Collected by scripts/collect.py; figures reproducible from " +
      "data/downloads.json for month " + facts.month + ".");
    box.appendChild(source);
    section.appendChild(box);
    root.appendChild(section);
  }

  function renderReportAppendix(root, facts) {
    // The appendix starts on a fresh page: see .report-page--appendix in the
    // print rules.
    var section = reportSection(root, "Appendix",
      "Full breakdowns for the reported month.", "report-page--appendix");

    [
      ["By .NET version", facts.versions],
      ["By Ubuntu series", facts.series],
      ["By architecture", facts.arch],
      ["By package type", facts.types],
      ["By origin", facts.origins],
    ].forEach(function (pair) {
      reportTable(section, pair[0],
        "<th>Value</th><th class='u-align--right'>Downloads</th>" +
        "<th class='u-align--right'>Share</th>" +
        "<th class='u-align--right'>" + facts.prevMonthLabel + "</th>" +
        "<th class='u-align--right'>MoM</th>",
        pair[1].rows.map(function (r) {
          return "<tr><td data-heading='Value'>" + r.key + "</td>" +
            "<td data-heading='Downloads' class='u-align--right'>" + fmt(r.total) + "</td>" +
            "<td data-heading='Share' class='u-align--right'>" +
            r.sharePct.toFixed(1) + "%</td>" +
            "<td data-heading='Previous' class='u-align--right'>" + fmt(r.prevTotal) +
            "</td>" +
            "<td data-heading='MoM' class='u-align--right'>" + deltaHtml(r.momPct) +
            "</td></tr>";
        }).join("")
      );
    });

    reportTable(section, "Package type glossary",
      "<th>Type</th><th>Meaning</th>",
      [
        ["sdk", "Full .NET SDK: compilers and build tooling. Indicates development or build environments."],
        ["runtime", "Base .NET runtime required to execute applications."],
        ["aspnetcore-runtime", "ASP.NET Core runtime for web workloads."],
        ["targeting-pack", "Reference assemblies used when building against a specific version."],
        ["apphost-pack", "Native application host used to produce executables."],
        ["host", "dotnet host executable and shared components."],
        ["hostfxr", "Host resolver library selecting the runtime version."],
        ["meta", "Version metapackage pulling in a default set."],
        ["other", "Anything not matched above, including templates and source-built artifacts."],
      ].map(function (r) {
        return "<tr><td data-heading='Type'>" + r[0] + "</td><td data-heading='Meaning'>" +
          r[1] + "</td></tr>";
      }).join("")
    );

    var monthlyHistory = facts.history;
    reportTable(section, "Monthly history",
      "<th>Month</th><th class='u-align--right'>Downloads</th>",
      monthlyHistory.months.map(function (m, i) {
        return "<tr><td data-heading='Month'>" + Report.monthLabel(m) + "</td>" +
          "<td data-heading='Downloads' class='u-align--right'>" +
          (monthlyHistory.totals[i]
            ? fmt(monthlyHistory.totals[i])
            : "<span class='report-delta--down'>no data</span>") +
          "</td></tr>";
      }).join("")
    );
  }

  /* Print the report from the dashboard.
   *
   * The charts are re-plotted at print dimensions first: on screen Plotly sizes
   * them to the viewport, and printing that directly would overflow or squash
   * the page. Once every chart has redrawn the print dialog opens, and the
   * responsive layout is restored afterwards. */
  function printReport(month) {
    var target = month || state.reportMonth;
    if (target) state.reportMonth = target;

    var button = $("#report-print");
    if (button) {
      button.disabled = true;
      button.textContent = "Preparing…";
    }

    printMode.active = true;
    document.body.classList.add("is-print");
    render();

    whenReportReady(function () {
      try {
        window.print();
      } finally {
        printMode.active = false;
        document.body.classList.remove("is-print");
        render();
      }
    });
  }

  /* Poll the readiness flag Views.report sets once all charts have drawn. */
  function whenReportReady(done, waited) {
    var elapsed = waited || 0;
    if (window.__reportReady === true || elapsed > 20000) {
      done();
      return;
    }
    window.setTimeout(function () {
      whenReportReady(done, elapsed + 100);
    }, 100);
  }

  /** URL of the archived PDF for a month, when the manifest lists one. */
  function archivedReport(month) {
    if (!state.manifest || !state.manifest.reports) return null;
    for (var i = 0; i < state.manifest.reports.length; i++) {
      var r = state.manifest.reports[i];
      if (r.month === month && r.pdf) return state.manifestBase + r.pdf;
    }
    return null;
  }

  // --------------------------------------------------------------------- //
  // View orchestration
  // --------------------------------------------------------------------- //

  function render() {
    var viewsRoot = $("#views");
    viewsRoot.innerHTML = "";
    viewsRoot._grid = null; // forget the stale breakdowns grid reference
    var meta = VIEWS.find(function (v) { return v.id === state.view; });
    $("#view-title").textContent = meta ? meta.label : "";

    // The report view is unfiltered by design, so the filter bar is hidden to
    // avoid implying that it applies.
    var unfiltered = UNFILTERED_VIEWS.indexOf(state.view) !== -1;
    $("#filter-bar").hidden = unfiltered || !state.binaries.length;

    var data = unfiltered ? Report.canonicalBinaries(state.binaries) : applyFilters();
    if (!data.length) {
      emptyState(viewsRoot);
      return;
    }
    Views[state.view](viewsRoot, data);
  }

  function buildNav() {
    var list = $("#nav-list");
    list.innerHTML = "";
    VIEWS.forEach(function (v) {
      var li = el("li", "p-side-navigation__item");
      var a = el("a", "p-side-navigation__link");
      a.href = "#" + v.id;
      a.setAttribute("aria-current", v.id === state.view ? "page" : "false");
      a.innerHTML =
        "<i class='p-icon--" + v.icon + " p-side-navigation__icon is-light'></i>" +
        "<span class='p-side-navigation__label'>" + v.label + "</span>";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        setView(v.id);
      });
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  function setView(id) {
    state.view = id;
    document.querySelectorAll("#nav-list a").forEach(function (a) {
      a.setAttribute("aria-current", a.hash === "#" + id ? "page" : "false");
    });
    // Collapse mobile drawer.
    $(".l-navigation").classList.add("is-collapsed");
    render();
  }

  function populateFilters() {
    var pockets = new Set();
    var versions = new Set();
    var types = new Set();
    state.binaries.forEach(function (b) {
      pockets.add(b.pocket);
      versions.add(Stats.majorVersion(b.source_package));
      types.add(Stats.packageType(b.name));
    });
    fillSelect("#pocket-filter", pockets);
    fillSelect("#version-filter", versions, true);
    fillSelect("#type-filter", types);
  }

  // Build the origin segmented control from the origins present in the data.
  function buildOriginFilter() {
    var container = $("#origin-filter");
    container.innerHTML = "";
    var origins = ["all"].concat(detectedOrigins());

    origins.forEach(function (origin) {
      var selected = origin === state.filters.origin;
      var btn = el("button", "p-segmented-control__button");
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) btn.classList.add("is-selected");
      btn.dataset.origin = origin;
      btn.textContent = origin === "all" ? "All origins" : originLabel(origin);
      btn.addEventListener("click", function () {
        container.querySelectorAll("button").forEach(function (b) {
          b.classList.remove("is-selected");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("is-selected");
        btn.setAttribute("aria-selected", "true");
        state.filters.origin = origin;
        render();
      });
      container.appendChild(btn);
    });
  }

  function fillSelect(sel, values, numeric) {
    var node = $(sel);
    var arr = Array.from(values).sort(function (a, b) {
      return numeric ? a.localeCompare(b, undefined, { numeric: true }) : a.localeCompare(b);
    });
    arr.forEach(function (v) {
      var opt = el("option");
      opt.value = v;
      opt.textContent = v;
      node.appendChild(opt);
    });
  }

  function resetFilters() {
    state.filters = { origin: "all", pocket: "all", version: "all", type: "all", debug: false };
    state.calendarFilter = { year: "all", month: "all" };

    $("#pocket-filter").value = "all";
    $("#version-filter").value = "all";
    $("#type-filter").value = "all";
    $("#debug-toggle").checked = false;

    buildOriginFilter();
    render();
  }

  function wireControls() {
    $("#pocket-filter").addEventListener("change", function (e) {
      state.filters.pocket = e.target.value;
      render();
    });
    $("#version-filter").addEventListener("change", function (e) {
      state.filters.version = e.target.value;
      render();
    });
    $("#type-filter").addEventListener("change", function (e) {
      state.filters.type = e.target.value;
      render();
    });
    $("#debug-toggle").addEventListener("change", function (e) {
      state.filters.debug = e.target.checked;
      render();
    });
    // Reset all filters to their defaults.
    $("#reset-filters").addEventListener("click", function () {
      resetFilters();
    });
    // Mobile menu toggles.
    document.querySelectorAll(".js-menu-toggle").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        $(".l-navigation").classList.toggle("is-collapsed");
      });
    });
  }

  function showNotice(kind, message) {
    $("#notice").innerHTML =
      "<div class='p-notification--" + kind + "'>" +
      "<div class='p-notification__content'>" +
      "<p class='p-notification__message'>" + message + "</p></div></div>";
  }
  function clearNotice() {
    $("#notice").innerHTML = "";
  }

  // --------------------------------------------------------------------- //
  // Boot
  // --------------------------------------------------------------------- //

  /* Read print-mode instructions from the query string. A headless browser
   * renders `?month=YYYY-MM&print=1` and waits for window.__reportReady. */
  function parsePrintMode() {
    var params = new URLSearchParams(location.search);
    var month = params.get("month");
    printMode.active = params.get("print") === "1";
    printMode.appendix = params.get("appendix") === "1";
    printMode.month = /^\d{4}-\d{2}$/.test(month || "") ? month : null;
    if (printMode.month) state.reportMonth = printMode.month;
    if (printMode.active || printMode.month) state.view = "report";
    if (printMode.active) document.body.classList.add("is-print");
  }

  /* The manifest of archived reports is optional: without it the dashboard just
   * offers on-demand reports, which is what local development sees before the
   * monthly workflow has ever run. The ../ fallback mirrors the data fetch and
   * supports serving the repository root during development. */
  function loadManifest() {
    return fetchManifest("reports/index.json", "")
      .catch(function () {
        return fetchManifest("../reports/index.json", "../");
      })
      .catch(function () {
        state.manifest = null;
        state.manifestBase = "";
      });
  }

  function fetchManifest(url, base) {
    return fetch(url, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (m) {
        state.manifest = m;
        state.manifestBase = base;
      });
  }

  function boot() {
    parsePrintMode();
    buildNav();
    wireControls();
    showNotice("information", "Loading download statistics…");

    fetch("data/downloads.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .catch(function () {
        // Fallback for local dev when serving the repo root (site lives in web/,
        // data lives in ../data/).
        return fetch("../data/downloads.json", { cache: "no-cache" }).then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        });
      })
      .then(function (data) {
        state.binaries = data.binaries || [];
        state.lastUpdated = data.last_updated;
        clearNotice();
        $("#filter-bar").hidden = false;
        $("#freshness").textContent =
          "Updated " + (state.lastUpdated ? state.lastUpdated.replace("T", " ").replace("Z", " UTC") : "unknown");
        var originLabels = detectedOrigins().map(originLabel);
        $("#status-line").textContent =
          "Data source: Launchpad · " +
          (originLabels.length ? originLabels.join(" + ") : "no data") +
          " · " + state.binaries.length + " binaries tracked";
        populateFilters();
        buildOriginFilter();
        // Deep-link support.
        var hash = location.hash.replace("#", "");
        if (VIEWS.some(function (v) { return v.id === hash; })) state.view = hash;
        if (printMode.active || printMode.month) state.view = "report";
        buildNav();
        return loadManifest().then(function () {
          render();
        });
      })
      .catch(function (err) {
        showNotice(
          "negative",
          "Could not load data/downloads.json (" + err.message +
            "). Run <code>python scripts/collect.py</code> first, then serve the repo with " +
            "<code>python -m http.server</code>."
        );
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
