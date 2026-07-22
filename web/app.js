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
    { id: "overview", label: "Overview", icon: "dashboard" },
    { id: "timeseries", label: "Time series", icon: "timed-out" },
    { id: "calendar", label: "Calendar", icon: "calendar" },
    { id: "trends", label: "Trends", icon: "change-version" },
    { id: "market", label: "Version share", icon: "priority-high" },
    { id: "breakdowns", label: "Breakdowns", icon: "units" },
    { id: "peaks", label: "Peaks & anomalies", icon: "warning" },
    { id: "lifecycle", label: "Lifecycle", icon: "revisions" },
    { id: "forecast", label: "Forecast", icon: "share" },
  ];

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
  };

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
  // View orchestration
  // --------------------------------------------------------------------- //

  function render() {
    var viewsRoot = $("#views");
    viewsRoot.innerHTML = "";
    viewsRoot._grid = null; // forget the stale breakdowns grid reference
    var meta = VIEWS.find(function (v) { return v.id === state.view; });
    $("#view-title").textContent = meta ? meta.label : "";

    var filtered = applyFilters();
    if (!filtered.length) {
      emptyState(viewsRoot);
      return;
    }
    Views[state.view](viewsRoot, filtered);
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

  function boot() {
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
        buildNav();
        render();
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
