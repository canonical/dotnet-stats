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
    { id: "trends", label: "Trends", icon: "change-version" },
    { id: "market", label: "Version share", icon: "priority-high" },
    { id: "breakdowns", label: "Breakdowns", icon: "units" },
    { id: "peaks", label: "Peaks & anomalies", icon: "warning" },
    { id: "lifecycle", label: "Lifecycle", icon: "revisions" },
    { id: "forecast", label: "Forecast", icon: "share" },
  ];

  var state = {
    binaries: [],
    lastUpdated: null,
    filters: { origin: "all", pocket: "all", version: "all", type: "all", debug: false },
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
    card.appendChild(el("p", "p-heading--2 u-no-margin", fmt(value)));
    if (sub) card.appendChild(el("p", "u-text--muted u-no-margin", sub));
    return card;
  }

  function chartContainer(id) {
    var wrap = el("div", "p-card u-no-padding");
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
    var ppaTotal = byOrigin.has("backports-ppa") ? totalCount(byOrigin.get("backports-ppa")) : 0;
    var archiveTotal = byOrigin.has("ubuntu-archive") ? totalCount(byOrigin.get("ubuntu-archive")) : 0;
    var versions = new Set(binaries.map(function (b) { return Stats.majorVersion(b.source_package); }));

    var grid = el("div", "row");
    [
      statCard("Total downloads", total, "across all selected packages"),
      statCard("Backports PPA", ppaTotal, total ? ((ppaTotal / total) * 100).toFixed(1) + "% of total" : ""),
      statCard("Ubuntu archive", archiveTotal, total ? ((archiveTotal / total) * 100).toFixed(1) + "% of total" : ""),
      statCard("Tracked binaries", binaries.length, versions.size + " .NET versions"),
    ].forEach(function (card) {
      var col = el("div", "col-3 col-medium-3 col-small-2");
      col.appendChild(card);
      grid.appendChild(col);
    });
    root.appendChild(grid);

    // Top packages table.
    var byPkg = groupBy(binaries, function (b) { return b.name; });
    var rows = [];
    byPkg.forEach(function (bins, name) {
      rows.push({ name: name, type: Stats.packageType(name), total: totalCount(bins) });
    });
    rows.sort(function (a, b) { return b.total - a.total; });

    var section = el("div", "u-fixed-width");
    section.appendChild(el("h2", "p-heading--4", "Top packages by downloads"));
    var table = el("table", "p-table--mobile-card");
    table.innerHTML =
      "<thead><tr><th>Package</th><th>Type</th><th class='u-align--right'>Downloads</th></tr></thead>";
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
    col.appendChild(container);
    if (!root._grid) {
      root._grid = el("div", "row");
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

  function wireControls() {
    // Origin segmented control.
    document.querySelectorAll("#origin-filter button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.querySelectorAll("#origin-filter button").forEach(function (b) {
          b.classList.remove("is-selected");
          b.setAttribute("aria-selected", "false");
        });
        btn.classList.add("is-selected");
        btn.setAttribute("aria-selected", "true");
        state.filters.origin = btn.dataset.origin;
        render();
      });
    });
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
        $("#status-line").textContent =
          "Data source: Launchpad · dotnet/backports PPA + Ubuntu archive · " +
          state.binaries.length + " binaries tracked";
        populateFilters();
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
