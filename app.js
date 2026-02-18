// PPS Warehouse Locator (Static GitHub Pages)
// Reads warehouse_data.csv from same folder.

const state = {
  tab: "items",
  q: "",
  aisle: "ALL",
  data: null,     // { items:[], bins:Map, aisles:Set, meta:{} }
  map: null,      // optional warehouse_map.json
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

function norm(s) { return (s ?? "").toString().toLowerCase().trim(); }

function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function parseBin(bin) {
  // Expects like A-01-PB (but handles weirdness gracefully)
  const raw = (bin ?? "").toString().trim();
  const parts = raw.split("-");
  const aisle = (parts[0] ?? "").toUpperCase();
  const bay = (parts[1] ?? "").padStart(2, "0");
  const zone = (parts.slice(2).join("-") ?? "").toUpperCase();
  const binNorm = zone ? `${aisle}-${bay}-${zone}` : `${aisle}-${bay}`;
  return { aisle, bay, zone, binNorm };
}

// Minimal CSV parser that handles quoted commas properly
function parseCSV(text) {
  const rows = [];
  let cur = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') { field += '"'; i++; continue; }
    if (c === '"') { inQuotes = !inQuotes; continue; }

    if (c === "," && !inQuotes) { cur.push(field); field = ""; continue; }
    if ((c === "\n" || c === "\r") && !inQuotes) {
      if (field.length || cur.length) cur.push(field);
      field = "";
      if (cur.length) rows.push(cur);
      cur = [];
      // handle CRLF
      if (c === "\r" && next === "\n") i++;
      continue;
    }

    field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
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

async function loadData() {
  const csvText = await fetch("warehouse_data.csv", { cache: "no-store" }).then(r => {
    if (!r.ok) throw new Error("Could not load warehouse_data.csv");
    return r.text();
  });

  const rows = parseCSV(csvText);
  if (rows.length < 2) throw new Error("CSV is empty or malformed.");

  const headers = rows[0];

  // Allow minor header differences
  const iBin  = pickHeaderIndex(headers, ["Bin Name", "Bin", "BinName"]);
  const iCode = pickHeaderIndex(headers, ["Item Code", "Item", "SKU", "ItemCode"]);
  const iUOM  = pickHeaderIndex(headers, ["UOM", "UoM"]);
  const iDesc = pickHeaderIndex(headers, ["Inv Description", "Description", "InvDescription"]);
  const iMfg  = pickHeaderIndex(headers, ["Manufacturer", "MFG", "Vendor"]);

  if (iBin === -1 || iCode === -1 || iDesc === -1) {
    throw new Error(
      "Missing required columns. Need at least: Bin Name, Item Code, Inv Description."
    );
  }

  const items = [];
  const bins = new Map();   // binNorm -> {bin, aisle, bay, zone, items:[]}
  const aisles = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const binRaw = (row[iBin] ?? "").trim();
    const code = (row[iCode] ?? "").trim();
    const desc = (row[iDesc] ?? "").trim();
    const uom  = (iUOM !== -1 ? (row[iUOM] ?? "").trim() : "");
    const mfg  = (iMfg !== -1 ? (row[iMfg] ?? "").trim() : "");

    // Ignore blank item rows (bin separators, empty bins, etc.)
    if (!binRaw || !code) continue;

    const { aisle, bay, zone, binNorm } = parseBin(binRaw);
    if (!aisle) continue;

    aisles.add(aisle);

    const item = { bin: binNorm, aisle, bay, zone, item_code: code, description: desc, uom, manufacturer: mfg };
    items.push(item);

    if (!bins.has(binNorm)) bins.set(binNorm, { bin: binNorm, aisle, bay, zone, items: [] });
    bins.get(binNorm).items.push({ item_code: code, description: desc, uom, manufacturer: mfg });
  }

  // De-dupe by (bin + item_code + uom)
  const seen = new Set();
  const itemsDedup = [];
  for (const it of items) {
    const key = `${it.bin}||${it.item_code}||${it.uom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    itemsDedup.push(it);
  }

  // Sort items inside each bin
  for (const b of bins.values()) {
    b.items.sort((a, z) => (a.item_code || "").localeCompare(z.item_code || ""));
  }

  const meta = {
    loaded_items: itemsDedup.length,
    loaded_bins: bins.size,
    loaded_aisles: aisles.size,
    source: "warehouse_data.csv",
  };

  return { items: itemsDedup, bins, aisles: Array.from(aisles).sort(), meta };
}

async function loadMap() {
  try {
    return await fetch("warehouse_map.json", { cache: "no-store" }).then(r => r.json());
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
  for (const a of state.data.aisles) sel.appendChild(new Option(`Aisle ${a}`, a));
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
  if (!state.map || !state.map.coords || !state.map.coords[bin]) { dot.style.display = "none"; return; }
  const p = state.map.coords[bin];
  dot.style.left = p.x + "%";
  dot.style.top = p.y + "%";
  dot.style.display = "block";
}

function activateTab(tab) {
  state.tab = tab;
  for (const el of document.querySelectorAll(".tab")) el.classList.toggle("active", el.dataset.tab === tab);
  document.getElementById("panel-items").style.display = (tab === "items") ? "" : "none";
  document.getElementById("panel-bins").style.display = (tab === "bins") ? "" : "none";
  document.getElementById("panel-map").style.display  = (tab === "map")  ? "" : "none";
  if (tab === "items") renderItems();
  if (tab === "bins") renderBins();
  if (tab === "map" && state.selectedBin) showMapDotForBin(state.selectedBin);
}

function renderItems() {
  const panel = document.getElementById("panel-items");
  const q = norm(state.q);
  const items = state.data.items.filter(it => aisleOk(it) && itemMatches(it, q)).slice(0, 250);

  panel.innerHTML = "";
  if (items.length === 0) {
    panel.innerHTML = `<div class="card"><div class="h">No matches</div><div class="muted small">Try a different search term.</div></div>`;
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
    .filter(b => !q || norm(b.bin).includes(q) || b.items.some(it => itemMatches({ ...it, bin: b.bin }, q)))
    .sort((a, b) =>
      a.aisle.localeCompare(b.aisle) ||
      (parseInt(a.bay || "9999", 10) - parseInt(b.bay || "9999", 10)) ||
      (a.zone || "").localeCompare(b.zone || "")
    )
    .slice(0, 150);

  panel.innerHTML = "";
  if (binsArr.length === 0) {
    panel.innerHTML = `<div class="card"><div class="h">No bins found</div><div class="muted small">Try a different search term.</div></div>`;
    return;
  }

  for (const b of binsArr) {
    const card = document.createElement("div");
    card.className = "card";
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
      <div class="small">
        ${b.items.slice(0, 25).map(it => `• <span class="pill">${escapeHtml(it.item_code)}</span> ${escapeHtml(it.description)}`).join("<br>")}
        ${b.items.length > 25 ? `<div class="muted small" style="margin-top:8px;">Showing first 25 items for speed.</div>` : ""}
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

  state.data = await loadData();
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
  document.getElementById("context").textContent = "Error: " + (err?.message || err);
  document.getElementById("panel-items").innerHTML =
    `<div class="card"><div class="h">Could not load data</div><div class="muted small">${escapeHtml(err?.message || err)}</div></div>`;
});
