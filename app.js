// PPS Warehouse Locator (Static GitHub Pages)
// Files expected in the same folder:
// - index.html
// - app.js
// - warehouse_data.csv
// Optional:
// - warehouse_map.png
// - warehouse_map.json  (for bin pin dots)

const state = {
  tab: "items",
  q: "",
  aisle: "ALL",
  data: null,      // { items:[], bins:Map, aisles:[], meta:{} }
  map: null,       // optional
  selectedBin: null,
};

function qs(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

function setQS(key, val) {
  const url = new URL(window.location.href);
  if (!val || val === "ALL") url.searchParams.delete(key);
  else url.searchParams.set(key, val);
  history.replaceState(null, "", url.toString());
}

function norm(s) {
  return (s ?? "").toString().toLowerCase().trim();
}

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseBin(bin) {
  // Expects: A-01-PB, A-01-H, etc.
  const raw = (bin ?? "").toString().trim();
  const parts = raw.split("-");
  const aisle = (parts[0] ?? "").toUpperCase();
  const bayRaw = (parts[1] ?? "").trim();
  const bay = bayRaw && /^\d+$/.test(bayRaw) ? bayRaw.padStart(2, "0") : bayRaw;
  const zone = (parts.slice(2).join("-") ?? "").toUpperCase().trim();
  const binNorm = zone ? `${aisle}-${bay}-${zone}` : `${aisle}-${bay}`;
  return { aisle, bay, zone, binNorm };
}

// Minimal CSV parser that supports quoted fields containing commas.
// Also supports CRLF and LF line endings.
function parseCSV(text) {
  const rows = [];
  let curRow = [];
  let curField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    // Escaped quote inside quoted field
    if (c === '"' && inQuotes && n === '"') {
      curField += '"';
      i++;
      continue;
    }

    // Toggle quotes
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    // Field delimiter
    if (c === "," && !inQuotes) {
      curRow.push(curField);
      curField = "";
      continue;
    }

    // Row delimiter
    if ((c === "\n" || c === "\r") && !inQuotes) {
      // Push last field if row has content
      if (curField.length || curRow.length) curRow.push(curField);
      curField = "";

      if (curRow.length) rows.push(curRow);
      curRow = [];

      // Handle CRLF
      if (c === "\r" && n === "\n") i++;
      continue;
    }

    // Regular character
    curField += c;
  }

  // Final row
  if (curField.length || curRow.length) {
    curRow.push(curField);
    rows.push(curRow);
  }

  return rows;
}

function pickHeaderIndex(headers, candidates) {
  const h = headers.map(norm);
  for (const c of candidates) {
    const idx = h.indexOf(norm(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function loadDataFromCSV() {
  const resp = await fetch("warehouse_data.csv", { cache: "no-store" });
  if (!resp.ok) throw new Error("Could not load warehouse_data.csv (is it in the repo root?)");

  const csvText = await resp.text();
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error("CSV looks empty or malformed.");

  const headers = rows[0];

  // Support a few header naming variants
  const iBin  = pickHeaderIndex(headers, ["Bin Name", "Bin", "BinName"]);
  const iCode = pickHeaderIndex(headers, ["Item Code", "Item", "SKU", "ItemCode"]);
  const iUOM  = pickHeaderIndex(headers, ["UOM", "UoM"]);
  const iDesc = pickHeaderIndex(headers, ["Inv Description", "Description", "InvDescription"]);
  const iMfg  = pickHeaderIndex(headers, ["Manufacturer", "MFG", "Vendor"]);

  if (iBin === -1 || iCode === -1 || iDesc === -1) {
    throw new Error("Missing required columns. Need at least: Bin Name, Item Code, Inv Description.");
  }

  const itemsRaw = [];
  const bins = new Map();      // binNorm -> {bin, aisle, bay, zone, items:[]}
  const aisleSet = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const binRaw = (row[iBin] ?? "").toString().trim();
    const code = (row[iCode] ?? "").toString().trim();
    const desc = (row[iDesc] ?? "").toString().trim();
    const uom  = (iUOM !== -1 ? (row[iUOM] ?? "").toString().trim() : "");
    const mfg  = (iMfg !== -1 ? (row[iMfg] ?? "").toString().trim() : "");

    // Ignore separator/empty rows
    if (!binRaw || !code) continue;

    const { aisle, bay, zone, binNorm } = parseBin(binRaw);
    if (!aisle) continue;

    aisleSet.add(aisle);

    itemsRaw.push({
      bin: binNorm,
      aisle,
      bay,
      zone,
      item_code: code,
      description: desc,
      uom,
      manufacturer: mfg
    });

    if (!bins.has(binNorm)) {
      bins.set(binNorm, { bin: binNorm, aisle, bay, zone, items: [] });
    }
    bins.get(binNorm).items.push({
      item_code: code,
      description: desc,
      uom,
      manufacturer: mfg
    });
  }

  // De-dupe items by (bin + item_code + uom)
  const seen = new Set();
  const items = [];
  for (const it of itemsRaw) {
    const key = `${it.bin}||${it.item_code}||${it.uom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }

  // Sort items inside bins
  for (const b of bins.values()) {
    b.items.sort((a, z) => (a.item_code || "").localeCompare(z.item_code || ""));
  }

  const aisles = Array.from(aisleSet).sort();

  const meta = {
    loaded_items: items.length,
    loaded_bins: bins.size,
    loaded_aisles: aisles.length,
    source: "warehouse_data.csv"
  };

  return { items, bins, aisles, meta };
}

async function loadMap() {
  try {
    const r = await fetch("warehouse_map.json", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function setContextText() {
  const c = document.getElementById("context");
  const m = state.data.meta;
  const parts = [`${m.loaded_items} items`, `${m.loaded_bins} bins`, `${m.loaded_aisles} aisles`];
  if (state.aisle !== "ALL") parts.unshift(`Viewing: Aisle ${state.aisle}`);
  c.textContent = parts.join(" • ");
}

function buildAisleOptions() {
  const sel = document.getElementById("aisleFilter");
  sel.innerHTML = "";
  sel.appendChild(new Option("All aisles", "ALL"));
  for (const a of state.data.aisles) {
    sel.appendChild(new Option(`Aisle ${a}`, a));
  }
  sel.value = state.aisle;
}

function itemMatches(it, q) {
  if (!q) return true;
  const hay = [it.item_code, it.description, it.manufacturer, it.bin].map(norm).join(" | ");
  return hay.includes(q);
}

function aisleOk(it) {
  return (state.aisle === "ALL") || (it.aisle === state.aisle);
}

function showMapDotForBin(bin) {
  const dot = document.getElementById("mapDot");
  if (!dot) return;

  if (!state.map || !state.map.coords || !state.map.coords[bin]) {
    dot.style.display = "none";
    return;
  }

  const p = state.map.coords[bin];
  dot.style.left = p.x + "%";
  dot.style.top  = p.y + "%";
  dot.style.display = "block";
}

function activateTab(tab) {
  state.tab = tab;

  for (const el of document.querySelectorAll(".tab")) {
    el.classList.toggle("active", el.dataset.tab === tab);
  }

  document.getElementById("panel-items").style.display = (tab === "items") ? "" : "none";
  document.getElementById("panel-bins").style.display  = (tab === "bins")  ? "" : "none";
  document.getElementById("panel-map").style.display   = (tab === "map")   ? "" : "none";

  if (tab === "items") renderItems();
  if (tab === "bins") renderBins();
  if (tab === "map" && state.selectedBin) showMapDotForBin(state.selectedBin);
}

function renderItems() {
  const panel = document.getElementById("panel-items");
  const q = norm(state.q);

  const items = state.data.items
    .filter(it => aisleOk(it) && itemMatches(it, q))
    .slice(0, 250);

  panel.innerHTML = "";

  if (items.length === 0) {
    panel.innerHTML =
      `<div class="card"><div class="h">No matches</div><div class="muted small">Try a different search term.</div></div>`;
    return;
  }

  for (const it of items) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="itemline">
        <div>
          <div class="h">${escapeHtml(it.description || "(no description)")}</div>
          <div class="muted small">${escapeHtml(it.item_code)} • ${escapeHtml(it.manufacturer || "—")} • ${escapeHtml(it.uom || "—")}</div>
        </div>
        <div class="pill" title="Bin">${escapeHtml(it.bin)}</div>
      </div>
      <div class="divider"></div>
      <button class="primary">Show bin</button>
    `;

    card.querySelector("button").addEventListener("click", () => {
      state.selectedBin = it.bin;
      activateTab("bins");
      renderBins();
      showMapDotForBin(it.bin);
    });

    panel.appendChild(card);
  }

  if (state.data.items.length > 250) {
    const foot = document.createElement("div");
    foot.className = "muted small";
    foot.textContent = "Showing first 250 matches for speed. Refine search to narrow.";
    panel.appendChild(foot);
  }
}

function renderBins() {
  const panel = document.getElementById("panel-bins");
  const q = norm(state.q);

  const binsArr = Array.from(state.data.bins.values())
    .filter(b => (state.aisle === "ALL" || b.aisle === state.aisle))
    .filter(b => {
      if (!q) return true;
      if (norm(b.bin).includes(q)) return true;
      return b.items.some(it => {
        const itWrap = { ...it, bin: b.bin, manufacturer: it.manufacturer };
        return itemMatches(itWrap, q);
      });
    })
    .sort((a, b) =>
      a.aisle.localeCompare(b.aisle) ||
      (parseInt(a.bay || "9999", 10) - parseInt(b.bay || "9999", 10)) ||
      (a.zone || "").localeCompare(b.zone || "")
    )
    .slice(0, 150);

  panel.innerHTML = "";

  if (binsArr.length === 0) {
    panel.innerHTML =
      `<div class="card"><div class="h">No bins found</div><div class="muted small">Try a different search term.</div></div>`;
    return;
  }

  for (const b of binsArr) {
    const card = document.createElement("div");
    card.className = "card";

    const itemsHtml = b.items.slice(0, 60).map(it => `
      <div style="display:flex; gap:10px; align-items:flex-start; padding:10px 0; border-bottom:1px solid var(--border);">
        <div class="pill" style="flex:0 0 auto;">${escapeHtml(it.item_code)}</div>
        <div style="flex:1 1 auto;">
          <div style="font-weight:800; line-height:1.25;">${escapeHtml(it.description || "(no description)")}</div>
          <div class="muted small" style="margin-top:2px;">
            ${escapeHtml(it.manufacturer || "—")} • ${escapeHtml(it.uom || "—")}
          </div>
        </div>
      </div>
    `).join("");

    card.innerHTML = `
      <div class="itemline">
        <div>
          <div class="h">${escapeHtml(b.bin)} <span class="muted small">(${b.items.length} items)</span></div>
          <div class="muted small">Aisle ${escapeHtml(b.aisle)} • Bay ${escapeHtml(b.bay)} • Zone ${escapeHtml(b.zone || "—")}</div>
        </div>
        <button class="primary">Ping map</button>
      </div>

      <div class="divider"></div>

      <div class="small muted">Items in this bin:</div>
      <div class="small" style="margin-top:8px;">
        ${itemsHtml}
        ${b.items.length > 60 ? `<div class="muted small" style="margin-top:10px;">Showing first 60 items for speed.</div>` : ""}
      </div>
    `;

    card.querySelector("button").addEventListener("click", () => {
      state.selectedBin = b.bin;
      showMapDotForBin(b.bin);
      activateTab("map");
    });

    panel.appendChild(card);
  }
}

async function init() {
  // NFC entry point: ?aisle=A
  const aisleParam = (qs("aisle") || "").toUpperCase();
  if (aisleParam) state.aisle = aisleParam;

  state.data = await loadDataFromCSV();
  state.map  = await loadMap();

  buildAisleOptions();
  setContextText();

  document.getElementById("aisleFilter").addEventListener("change", (e) => {
    state.aisle = e.target.value;
    setQS("aisle", state.aisle === "ALL" ? "" : state.aisle);
    setContextText();
    if (state.tab === "items") renderItems(); else renderBins();
  });

  const qEl = document.getElementById("q");
  qEl.addEventListener("input", () => {
    state.q = qEl.value;
    if (state.tab === "items") renderItems(); else renderBins();
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    state.q = "";
    state.selectedBin = null;
    qEl.value = "";
    renderItems();
    renderBins();
  });

  document.getElementById("copyLinkBtn").addEventListener("click", async () => {
    const url = new URL(window.location.href);
    if (state.aisle && state.aisle !== "ALL") url.searchParams.set("aisle", state.aisle);
    else url.searchParams.delete("aisle");
    await navigator.clipboard.writeText(url.toString());
    alert("Copied: " + url.toString());
  });

  for (const t of document.querySelectorAll(".tab")) {
    t.addEventListener("click", () => activateTab(t.dataset.tab));
  }

  renderItems();
}

init().catch(err => {
  const msg = (err?.message || err || "").toString();
  const context = document.getElementById("context");
  if (context) context.textContent = "Error: " + msg;

  const panel = document.getElementById("panel-items");
  if (panel) {
    panel.innerHTML = `
      <div class="card">
        <div class="h">Could not load data</div>
        <div class="muted small">${escapeHtml(msg)}</div>
        <div class="divider"></div>
        <div class="muted small">
          Checklist:
          <br>• Ensure <span class="pill">warehouse_data.csv</span> exists in repo root
          <br>• Filename must match exactly (case sensitive)
          <br>• CSV must be comma-delimited (Excel: CSV UTF-8)
          <br>• Required headers: Bin Name, Item Code, Inv Description
        </div>
      </div>
    `;
  }
});
