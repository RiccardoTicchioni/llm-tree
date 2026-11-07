// Heatmap dei punteggi per task (M2-c; proposta M2-a approvata alle 16:36).
// - mark: area (una cella per foglia × task);
// - canale: luminanza, scala sequenziale grigia interpolata in CIELAB
//   (d3.interpolateLab) tra #ececec (minimo della colonna) e #262626
//   (massimo): in Lab passi uguali di t sono passi di chiarezza percepita
//   quasi uguali, in RGB no (indicazione 2 di Liotta);
// - normalizzazione min-max PER COLONNA: rating di task diversi sono stime
//   separate e non si confrontano (contratto 1.3);
// - n.d.: cella bianca con bordo tratteggiato e testo, mai il colore del minimo;
// - nessuna classe "dimmable": il "non entra" non tocca la luminanza delle
//   celle (indicazione E del CP2).
// "Migliori tra quelli che entrano" (task 3): B = il modello che entra con il
// rating piu' alto; migliori = i modelli che entrano con upper >= lower(B)
// (intervallo pubblicato da LMArena sovrapposto a quello di B). Se B non ha
// l'intervallo: ripiego top-3, dichiarato.

/* global d3 */

import { ROW, isCollapsed, modelsIn } from "./tree.js";
import { fitStatus } from "./vram.js";

export const CELL_W = 28;
export const CELL_GAP = 2;
export const LOW = "#ececec";
export const HIGH = "#262626";
export const FALLBACK_K = 3;
const interp = d3.interpolateLab(LOW, HIGH);

/** Dominio [min, max] di ogni task, sui modelli con un valore (open e chiusi). */
export function taskDomains(model) {
  const models = model.raw.nodes.filter((n) => n.kind === "model");
  const dom = new Map();
  for (const t of model.raw.tasks ?? []) {
    const vals = models.map((n) => n.scores?.[t.id]).filter((v) => v !== null && v !== undefined);
    dom.set(t.id, vals.length ? d3.extent(vals) : null);
  }
  return dom;
}

/** Colore della cella (null = n.d.). */
export function cellColor(task, dom, v) {
  if (v === null || v === undefined || !dom) return null;
  const [lo, hi] = dom;
  let t = hi > lo ? (v - lo) / (hi - lo) : 1;
  if (task.higher_is_better === false) t = 1 - t;
  return interp(t);
}

/**
 * Insieme dei migliori nel task tra i modelli che entrano in gpu/quant.
 * @returns {{ best: Set<string>, top: node|null, fallback: boolean, candidates: number }}
 */
export function bestSet(model, task, gpu, quant) {
  const empty = { best: new Set(), top: null, fallback: false, candidates: 0, ranked: [] };
  if (!task) return empty;
  const hib = task.higher_is_better !== false;
  const cand = model.raw.nodes.filter((n) => n.kind === "model"
    && fitStatus(n, gpu, quant) === "fits"
    && n.scores?.[task.id] !== null && n.scores?.[task.id] !== undefined);
  if (!cand.length) return empty;
  const score = (n) => n.scores[task.id];
  cand.sort((a, b) => (hib ? score(b) - score(a) : score(a) - score(b)));
  const top = cand[0];
  const det = top.score_detail?.[task.id];
  if (!det) {
    const ranked = cand.slice(0, FALLBACK_K);
    return { best: new Set(ranked.map((n) => n.id)), top, fallback: true, candidates: cand.length, ranked };
  }
  // Un modello senza intervallo concorre con il suo valore puntuale.
  const reach = (n) => {
    const d = n.score_detail?.[task.id];
    return hib ? (d ? d.upper : score(n)) >= det.lower : (d ? d.lower : score(n)) <= det.upper;
  };
  const ranked = cand.filter(reach);
  return { best: new Set(ranked.map((n) => n.id)), top, fallback: false, candidates: cand.length, ranked };
}

/**
 * Disegna la heatmap a partire da x0. Restituisce { width, update(task, gpu, quant) }.
 */
export function drawScoreColumns(g, headerG, model, x0, headerY) {
  const tasks = model.raw.tasks ?? [];
  if (!tasks.length) return { width: 0, update: () => ({ best: new Set() }) };
  const dom = taskDomains(model);
  const colX = (i) => i * (CELL_W + CELL_GAP);
  const lastY = d3.max(model.leaves, (d) => d.sy) ?? 0;

  const col = g.append("g").attr("class", "col col-scores").attr("transform", `translate(${x0},0)`);
  const head = headerG.append("g").attr("class", "col-head col-scores-head").attr("transform", `translate(${x0},0)`);

  // Intestazioni ruotate: 28 px non bastano per "Matematica" in orizzontale.
  // rotate(45) con l'ancora alla FINE: il testo scende verso la sua colonna
  // e sporge in alto a SINISTRA, sopra lo spazio vuoto dell'intestazione
  // della VRAM (sopra i valori numerici). Con rotate(-45) sporgeva a destra
  // di ~45 px e allargava il contenuto: a 1280 px la scala scendeva sotto 0,8.
  head.selectAll("text.score-head")
    .data(tasks)
    .join("text")
    .attr("class", "col-header score-head")
    .attr("text-anchor", "end")
    .attr("transform", (t, i) => `translate(${colX(i) + CELL_W / 2 + 2},${headerY + 8}) rotate(45)`)
    .text((t) => t.label)
    .append("title").text((t) => {
      const d = dom.get(t.id);
      return `${t.label}: ${t.metric}. Scala della colonna da ${d ? Math.round(d[0]) : "n.d."} (chiaro) a ${d ? Math.round(d[1]) : "n.d."} (scuro).`;
    });

  // Cornice della colonna del task scelto (sotto le celle).
  const frame = col.append("rect").attr("class", "score-frame")
    .attr("y", -ROW / 2 - 1).attr("height", lastY + ROW + 2).attr("width", CELL_W + 2).attr("display", "none");

  const cells = [];
  // Le righe dei cladi compressi non hanno celle: niente heatmap aggregata
  // (versione minima concessa da Liotta). Una cella vuota senza bordo non si
  // confonde con n.d., che ha il bordo tratteggiato e il testo.
  for (const leaf of model.leaves) {
    if (isCollapsed(leaf)) continue;
    tasks.forEach((t, i) => cells.push({ leaf, task: t, i, v: leaf.data.ref.scores?.[t.id] ?? null }));
  }
  // Sulla riga di un clade compresso, con un task scelto, si scrive quanti
  // dei "migliori" stanno dentro il clade, nella colonna del task, con la
  // stessa marcatura a doppio contorno: la risposta al task 3 non sparisce
  // quando si comprime.
  const collapsedRows = model.leaves.filter(isCollapsed);
  const packG = col.selectAll("g.score-pack")
    .data(collapsedRows)
    .join("g")
    .attr("class", "score-pack")
    .attr("display", "none");
  packG.append("rect").attr("class", "best-outer").attr("x", -1.5).attr("y", -1.5)
    .attr("width", CELL_W + 3).attr("height", ROW);
  packG.append("rect").attr("class", "best-inner score-pack-bg").attr("x", 0.5).attr("y", 0.5)
    .attr("width", CELL_W - 1).attr("height", ROW - 4);
  packG.append("text").attr("class", "score-pack-text").attr("x", CELL_W / 2).attr("y", (ROW - 3) / 2)
    .attr("dy", "0.35em").attr("text-anchor", "middle");
  const packIds = new Map(collapsedRows.map((d) => [d, modelsIn(d).map((m) => m.id)]));
  const cellG = col.selectAll("g.score-cell")
    .data(cells)
    .join("g")
    .attr("class", "score-cell")
    .attr("transform", (c) => `translate(${colX(c.i)},${c.leaf.sy - ROW / 2 + 1.5})`);
  cellG.append("rect")
    .attr("class", (c) => (c.v === null ? "score-rect score-nd" : "score-rect"))
    .attr("width", CELL_W).attr("height", ROW - 3)
    .attr("fill", (c) => cellColor(c.task, dom.get(c.task.id), c.v) ?? "#fff");
  cellG.filter((c) => c.v === null).append("text")
    .attr("class", "score-nd-text").attr("x", CELL_W / 2).attr("y", (ROW - 3) / 2).attr("dy", "0.35em")
    .attr("text-anchor", "middle").text("n.d.");
  // Marcatura dei migliori: doppio contorno (nero esterno, bianco interno),
  // visibile su celle chiare e scure. Nascosta finche' non serve.
  cellG.append("rect").attr("class", "best-outer").attr("x", -1.5).attr("y", -1.5)
    .attr("width", CELL_W + 3).attr("height", ROW).attr("display", "none");
  cellG.append("rect").attr("class", "best-inner").attr("x", 0.5).attr("y", 0.5)
    .attr("width", CELL_W - 1).attr("height", ROW - 4).attr("display", "none");

  function update(task, gpu, quant) {
    const res = bestSet(model, task, gpu, quant);
    const i = task ? tasks.findIndex((t) => t.id === task.id) : -1;
    frame.attr("display", i >= 0 ? null : "none").attr("x", colX(Math.max(0, i)) - 1);
    head.selectAll("text.score-head").classed("selected", (t) => task && t.id === task.id);
    const on = (c) => task && c.task.id === task.id && res.best.has(c.leaf.data.ref.id);
    cellG.select(".best-outer").attr("display", (c) => (on(c) ? null : "none"));
    cellG.select(".best-inner").attr("display", (c) => (on(c) ? null : "none"));
    packG.each(function (d) {
      const k = task ? packIds.get(d).filter((id) => res.best.has(id)).length : 0;
      d3.select(this)
        .attr("display", k ? null : "none")
        .attr("transform", `translate(${colX(Math.max(0, i))},${d.sy - ROW / 2 + 1.5})`)
        .select("text").text(k);
      d3.select(this).select("title").remove();
      if (k) d3.select(this).append("title").text(`${k} dei migliori nel task stanno dentro questo clade compresso`);
    });
    return res;
  }

  // Con l'ancora alla fine le intestazioni non sporgono a destra.
  const width = tasks.length * CELL_W + (tasks.length - 1) * CELL_GAP;
  return { width, overhang: 0, update, cellSel: cellG, domains: dom };
}
