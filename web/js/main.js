// Punto di ingresso: carica i dati, prepara il modello, disegna, collega
// i controlli. Paradigma: overview first, zoom and filter, then details-on-demand.
// Regola: il mock si carica SOLO con ?mock=1; se il file vero manca si mostra
// un errore e non si ripiega in silenzio sui dati finti.

/* global d3 */

import { prepare, SELF_SUFFIX } from "./data.js";
import { layoutTree, drawTree, highlightPath, leafOfModel, isCollapsed, ROW } from "./tree.js";
import { drawColumns, drawRowBands, drawRowHits } from "./columns.js";
import { drawLegend, setFallbackNote } from "./legend.js";
import { drawControls, defaultGpu } from "./controls.js";
import { createTooltip } from "./tooltip.js";
import { fitStatus } from "./vram.js";

const REAL_URL = "../data/processed/tree.json";
// Dati finti: SOLO con ?mock=1 (piccolo) o ?mock=stress (scala dei dati veri).
const MOCK_URLS = { 1: "mock/tree.mock.json", stress: "mock/tree.mock-stress.json" };
const MARGIN = { top: 60, right: 8, bottom: 24, left: 8 }; // margini laterali ridotti in M2: la heatmap deve stare a 1280 px con scala ≥ 0,8
const MIN_READABLE_K = 0.8; // sotto questa scala le etichette da 12 px non si leggono
const MAX_FIT_K = 1.6;

const params = new URLSearchParams(location.search);
const MOCK_URL = MOCK_URLS[params.get("mock")] ?? null;
const useMock = MOCK_URL !== null;

function markReady() {
  const flag = document.createElement("div");
  flag.id = "app-ready";
  flag.hidden = true;
  document.body.appendChild(flag);
}

// Layout dell'albero intero, calcolato al primo disegno: quando si comprime
// un clade si riusano le sue x (livelli, foglie, fine delle etichette), cosi'
// le colonne restano ferme e cambia solo il numero di righe.
let fixedLayout = null;

function render(model) {
  const svg = d3.select("#viz");
  svg.selectAll("*").remove();

  const viewport = svg.append("g").attr("class", "viewport");
  const content = viewport.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
  const bands = content.append("g").attr("class", "row-bands");

  // Intestazione delle colonne: livello separato che segue lo zoom solo in
  // orizzontale e resta in alto quando si scorre in verticale.
  const headerLayer = svg.append("g").attr("class", "header-layer");
  headerLayer.append("rect").attr("class", "header-bg")
    .attr("x", -1e4).attr("y", -1e4).attr("width", 3e4).attr("height", 1e4 + MARGIN.top - ROW / 2 - 3);
  const header = headerLayer.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Misura le etichette dei clade con lo stesso stile CSS con cui verranno
  // disegnate, per dare a ogni livello la larghezza giusta.
  const probe = svg.append("text").attr("class", "clade-label").attr("visibility", "hidden");
  const measure = (t) => probe.text(t).node().getComputedTextLength();
  const layout = layoutTree(model, { measure, fixed: fixedLayout });
  probe.remove();
  const tree = drawTree(content.append("g").attr("class", "tree"), model, layout);
  if (!fixedLayout) fixedLayout = { leafX: layout.leafX, stem: layout.stem, levelX: layout.levelX, levelW: layout.levelW, labelCap: layout.labelCap, labelEnd: tree.labelEnd };
  const cols = drawColumns(content.append("g").attr("class", "columns"), header, model, layout, tree.labelEnd);
  const bandSel = drawRowBands(bands, model, layout, cols.end);
  const hitSel = drawRowHits(content.append("g").attr("class", "row-hits"), model, layout, cols.end);

  const width = MARGIN.left + (cols.extent ?? cols.end) + MARGIN.right;
  const height = MARGIN.top + layout.rowsHeight + MARGIN.bottom;
  return { svg, viewport, headerLayer, content, layout, tree, cols, bandSel, hitSel, width, height };
}

async function start() {
  const status = document.getElementById("status");
  const url = useMock ? MOCK_URL : REAL_URL;
  document.getElementById("mock-banner").hidden = !useMock;
  let raw;
  try {
    raw = await d3.json(url);
  } catch (err) {
    status.textContent = useMock
      ? `Impossibile caricare il mock (${MOCK_URL}): ${err.message}`
      : `Dati reali non ancora disponibili (${REAL_URL}). Per sviluppare con i dati finti apri la pagina con ?mock=1.`;
    status.classList.add("error");
    markReady();
    return;
  }

  const model = prepare(raw);
  const nModels = raw.nodes.filter((n) => n.kind === "model").length;
  status.textContent = `${nModels} modelli, ${raw.nodes.length - nModels} clade, ${model.reticulations.length} reticolazioni · contratto ${raw.meta.version}`;

  // ---------- Stato ----------
  const gpuById = new Map(raw.gpus.map((g) => [g.id, g]));
  const state = {
    gpuId: defaultGpu(raw.gpus)?.id,
    // Q4 di default: e' la quantizzazione piu' leggera, quindi mostra il
    // maggior numero di candidati; l'utente restringe passando a INT8 / FP16.
    quant: "q4",
    found: null, // id del modello trovato con la ricerca
    taskId: null, // task scelto (M2): nessuno all'apertura, overview first
  };
  const taskById = new Map((raw.tasks ?? []).map((t) => [t.id, t]));
  const current = () => ({ gpu: gpuById.get(state.gpuId), quant: state.quant, task: taskById.get(state.taskId) ?? null });

  drawLegend(document.getElementById("legend"), model);
  model.allLeaves = model.root.leaves(); // tutte le righe, a albero espanso
  let view = render(model);
  const tooltip = createTooltip(document.getElementById("viz-wrap"), model, current);

  // ---------- Filtro GPU / quantizzazione ----------
  function applyFilter(animate) {
    const { gpu, quant } = current();
    view.cols.updateVram(gpu, quant, animate);
    // Attenuo solo i modelli open che sicuramente NON entrano. I chiusi sono
    // l'alternativa via API (task 5) e i n.d. non li escludo: non lo sappiamo.
    // Si attenua solo il testo (.dimmable = etichetta, nome dell'org), mai
    // i marks colorati: vedi style.css.
    view.content.selectAll(".dimmable")
      .classed("dim", (d) => fitStatus(d.data.ref, gpu, quant) === "nofit");
    applyTask();
  }

  // ---------- Task: migliori tra quelli che entrano (task 3) ----------
  function applyTask() {
    const { gpu, quant, task } = current();
    const res = view.cols.updateScores(task, gpu, quant);
    view.tree.leafLabelSel.classed("best", (d) => res.best.has(d.data.ref.id));
    controls.setBestAnswer(task, gpu, quant, res);
    setFallbackNote(Boolean(task && res.fallback)); // il ripiego si dichiara in legenda quando scatta
  }

  // ---------- Zoom e pan ----------
  const svgEl = view.svg.node();
  const zoom = d3.zoom()
    .scaleExtent([0.5, 4])
    .on("zoom", (ev) => {
      const t = ev.transform;
      view.viewport.attr("transform", t);
      view.headerLayer.attr("transform", `translate(${t.x},${Math.max(0, t.y)}) scale(${t.k})`);
    });
  view.svg.call(zoom).on("dblclick.zoom", null);

  function fitTransform() {
    const W = svgEl.clientWidth;
    const H = svgEl.clientHeight;
    let k = Math.min(W / view.width, H / view.height, MAX_FIT_K);
    if (k < MIN_READABLE_K) k = Math.max(MIN_READABLE_K, Math.min(1, W / view.width)); // scala leggibile, poi pan verticale
    return d3.zoomIdentity.translate(0, 0).scale(k);
  }
  const fit = (animate = true) => (animate ? view.svg.transition().duration(500) : view.svg).call(zoom.transform, fitTransform());

  const zoomBar = d3.select("#viz-wrap").append("div").attr("class", "zoom-controls").attr("role", "group").attr("aria-label", "Zoom");
  zoomBar.append("button").attr("type", "button").attr("title", "Ingrandisci").text("+")
    .on("click", () => view.svg.transition().duration(250).call(zoom.scaleBy, 1.3));
  zoomBar.append("button").attr("type", "button").attr("title", "Riduci").text("−")
    .on("click", () => view.svg.transition().duration(250).call(zoom.scaleBy, 1 / 1.3));
  zoomBar.append("button").attr("type", "button").attr("title", "Adatta alla finestra").text("Adatta")
    .on("click", () => fit(true));
  // Comprimi / espandi (M2-d): "overview first" anche per gli alberi alti.
  zoomBar.append("span").attr("class", "zoom-sep").attr("aria-hidden", "true");
  zoomBar.append("button").attr("type", "button").attr("data-role", "collapse-orgs")
    .attr("title", "Comprimi l'albero a una riga per organizzazione (cladi di primo livello)")
    .text("Una riga per organizzazione")
    .on("click", () => collapseOrgs());
  zoomBar.append("button").attr("type", "button").attr("data-role", "expand-all")
    .attr("title", "Espandi tutti i cladi").text("Espandi tutto")
    .on("click", () => expandAll());

  // ---------- Ricerca (Locate the node <Name>) ----------
  function locate(query) {
    const q = (query || "").trim().toLowerCase();
    let leaf = null;
    if (q) {
      // Si cerca su tutte le righe, anche quelle dentro un clade compresso:
      // se il modello e' nascosto, si espandono i suoi antenati.
      const leaves = model.allLeaves;
      leaf = leaves.find((d) => d.data.ref.label.toLowerCase() === q)
        ?? leaves.find((d) => d.data.ref.label.toLowerCase().includes(q))
        ?? null;
    }
    if (leaf && !model.leaves.includes(leaf)) {
      for (const a of leaf.ancestors()) if (isCollapsed(a)) expand(a);
      remount();
    }
    state.found = leaf ? leaf.data.ref.id : null;
    const isFound = (d) => state.found !== null && d.data.ref.id === state.found;
    view.content.selectAll(".node, .leaf-label").classed("found", isFound);
    view.bandSel.classed("found", isFound);
    controls.setSearchMessage(q && !leaf ? "Nessun modello con questo nome." : "");
    if (!leaf) return;

    // Centra la riga trovata; ingrandisce fino a scala 1 se serve.
    const W = svgEl.clientWidth;
    const H = svgEl.clientHeight;
    const t0 = d3.zoomTransform(svgEl);
    const k = Math.max(t0.k, 1);
    const fitsWidth = view.width * k <= W;
    const tx = fitsWidth ? 0 : W * 0.35 - k * (MARGIN.left + leaf.sx);
    const ty = H / 2 - k * (MARGIN.top + leaf.sy);
    view.svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }

  // ---------- Controlli ----------
  const controls = drawControls(document.getElementById("controls"), model, state, {
    gpu: (id) => { state.gpuId = id; applyFilter(true); },
    quant: (q) => { state.quant = q; controls.syncQuant(q); applyFilter(true); },
    search: (text) => locate(text),
    task: (id) => { state.taskId = id; controls.syncTask(id); applyTask(); },
  });

  // ---------- Details-on-demand ----------
  // I gestori si ricollegano a ogni nuovo disegno (comprimi/espandi).
  function bind() {
    const bandOf = (d) => view.bandSel.filter((b) => b === d);
    view.hitSel
      .on("mouseenter", (ev, d) => { bandOf(d).classed("hover", true); tooltip.show(ev, d); })
      .on("mousemove", (ev) => tooltip.move(ev))
      .on("mouseleave", (ev, d) => { bandOf(d).classed("hover", false); tooltip.hide(); })
      .on("click", (ev, d) => {
        ev.stopPropagation();
        if (isCollapsed(d)) { toggle(d); return; } // riga di un clade compresso: espande
        selectModel(d); tooltip.pin(ev, d);
      });
    view.tree.nodeSel.filter((d) => d.children || isCollapsed(d))
      .on("mouseenter", (ev, d) => tooltip.show(ev, d))
      .on("mousemove", (ev) => tooltip.move(ev))
      .on("mouseleave", () => tooltip.hide())
      .on("click", (ev, d) => {
        ev.stopPropagation();
        // Quadrato di un clade: comprime / espande. Nodo interno di un
        // modello (sampled ancestor): tooltip fisso, come prima.
        if (d.data.ref.kind === "clade") toggle(d);
        else tooltip.pin(ev, d);
      });
    // Archi dell'albero e reticolazioni: stesso comportamento. (Non uso
    // selection.merge: unisce per indice e perderebbe le reticolazioni.)
    for (const sel of [view.tree.linkHitSel, view.tree.retHitSel]) {
      sel
        .on("mouseenter", (ev, d) => tooltip.show(ev, d))
        .on("mousemove", (ev) => tooltip.move(ev))
        .on("mouseleave", () => tooltip.hide())
        .on("click", (ev, d) => { ev.stopPropagation(); tooltip.pin(ev, d); });
    }
  }
  bind();

  // ---------- Comprimi / espandi i cladi (M2-d) ----------
  function collapse(d) { if (d.children) { d._children = d.children; d.children = null; } }
  function expand(d) { if (isCollapsed(d)) { d.children = d._children; d._children = null; } }
  // Ridisegna con lo stesso zoom; `anchor` (un nodo) resta alla stessa y
  // sullo schermo, cosi' il clade cliccato non "salta" via dal puntatore.
  function remount(anchor = null) {
    const oldY = anchor ? anchor.sy : 0;
    // Il tooltip fisso si chiude (la sua riga puo' sparire), ma il cammino
    // selezionato resta: unpin() lo toglierebbe tramite onUnpin.
    const keep = state.selected;
    if (tooltip.pinned) tooltip.unpin();
    state.selected = keep;
    model.leaves = model.root.leaves();
    view = render(model);
    bind();
    applyFilter(false);
    const t = d3.zoomTransform(svgEl);
    const dy = anchor ? t.k * (oldY - anchor.sy) : 0;
    view.svg.call(zoom.transform, d3.zoomIdentity.translate(t.x, t.y + dy).scale(t.k));
    // Lo stato di ricerca e cammino sopravvive al ridisegno.
    if (state.found) {
      const isFound = (d) => d.data.ref.id === state.found;
      view.content.selectAll(".node, .leaf-label").classed("found", isFound);
      view.bandSel.classed("found", isFound);
    }
    if (state.selected) highlightPath(view.tree, leafOfModel(model).get(state.selected) ?? null);
  }
  function toggle(d) {
    if (isCollapsed(d)) expand(d); else collapse(d);
    remount(d);
  }
  function eachNode(fn) {
    const walk = (x) => { fn(x); for (const c of x.children ?? x._children ?? []) walk(c); };
    walk(model.root);
  }
  function collapseOrgs() {
    // Primo livello di cladi (con i dati veri: le organizzazioni). Dentro,
    // tutto torna espanso: riaprendo un'organizzazione si vede l'intero ramo.
    eachNode(expand);
    for (const c of model.root.children ?? []) if (c.data.ref.kind === "clade") collapse(c);
    remount();
    fit(true);
  }
  function expandAll() {
    eachNode(expand);
    remount();
    fit(true);
  }

  view.svg.on("click", () => { tooltip.unpin(); selectModel(null); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") { tooltip.unpin(); selectModel(null); } });

  // ---------- Click su un modello: cammino fino alla radice (task 4) ----------
  function selectModel(leaf) {
    state.selected = leaf ? leaf.data.ref.id : null;
    highlightPath(view.tree, leaf);
  }
  tooltip.onUnpin = () => selectModel(null); // chiudere il tooltip (×) toglie anche il cammino

  // ---------- Overview first ----------
  applyFilter(false);
  fit(false);
  window.addEventListener("resize", () => fit(false));

  // Per i test con screenshot.py (--step) e per il debug dalla console.
  window.__app = {
    raw, model, state, tooltip,
    setGpu: (id) => { state.gpuId = id; document.getElementById("gpu-select").value = id; applyFilter(false); },
    setQuant: (q) => { state.quant = q; controls.syncQuant(q); applyFilter(false); },
    setTask: (id) => { state.taskId = id; controls.syncTask(id); applyTask(); },
    search: (text) => { document.getElementById("search").value = text; locate(text); },
    zoomTo: (k, tx, ty) => view.svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k)),
    get view() { return view; },
    toggle: (id) => {
      let d = null;
      eachNode((x) => { if (x.data.ref.id === id && x.data.ref.kind === "clade") d = x; });
      if (d) toggle(d);
    },
    collapseOrgs: () => collapseOrgs(),
    expandAll: () => expandAll(),
    select: (id) => {
      const d = model.leaves.find((x) => x.data.ref.id === id);
      selectModel(d ?? null);
      if (d) window.__app.hover(id);
    },
    hover: (id) => {
      const d = model.leaves.find((x) => x.data.ref.id === id || x.data.ref.id + SELF_SUFFIX === id);
      const node = view.hitSel.filter((x) => x === d).node();
      const r = node.getBoundingClientRect();
      tooltip.pin({ clientX: r.left + 40, clientY: r.top + r.height / 2 }, d);
    },
  };
  markReady();
}

start();
