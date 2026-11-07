// Colonna VRAM (fase 3 encoding, approvata al CP2 con l'indicazione A).
// - lunghezza della barra = VRAM stimata nella quantizzazione scelta (GiB),
//   scala lineare con zero a sinistra;
// - dominio [0, 2 × capacita' della GPU]: la linea della GPU sta sempre a meta'
//   colonna; le barre oltre il dominio si troncano con un segno di rottura e
//   il valore vero scritto accanto;
// - luminanza: barra scura = entra, grigio chiaro = non entra;
// - testo "solo API" per i chiusi, "n.d." per i dati mancanti (mai una barra 0).

/* global d3 */

import { ROW, isCollapsed, modelsIn } from "./tree.js";
import { gib, num } from "./fmt.js";

export const VRAM_W = 180;
export const VRAM_LABEL_W = 44;
const BAR_H = ROW - 6;
const BREAK_AT = VRAM_W - 9; // dove cade il segno di rottura sulle barre troncate

// Nomi reali delle quantizzazioni (contratto 1.2): INT8 = Q8_0, Q4 = Q4_K_M
// di llama.cpp. `short` per l'intestazione stretta della colonna.
export const QUANTS = [
  { id: "fp16", label: "FP16", short: "FP16" },
  { id: "int8", label: "INT8 (Q8_0)", short: "Q8_0" },
  { id: "q4", label: "Q4 (Q4_K_M)", short: "Q4_K_M" },
];

/** Stato derivato di un modello rispetto a GPU e quantizzazione. */
export function fitStatus(node, gpu, quant) {
  if (node.kind !== "model") return "none";
  if (node.weights === "closed") return "api";
  const v = node.vram_gib?.[quant];
  if (v === null || v === undefined) return "nd";
  return v <= gpu.vram_gib ? "fits" : "nofit";
}


/**
 * Disegna la colonna. `g` e' nel contenuto (scorre con le righe), `headerG`
 * e' nell'intestazione fissa. Restituisce update(gpu, quant, animate).
 */
export function drawVramColumn(g, headerG, model, x0, headerY) {
  const col = g.append("g").attr("class", "col col-vram").attr("transform", `translate(${x0},0)`);
  const head = headerG.append("g").attr("class", "col-head col-vram-head").attr("transform", `translate(${x0},0)`);

  head.append("text").attr("class", "col-header").attr("x", 0).attr("y", headerY - 16).attr("data-role", "title");
  const ticksG = head.append("g").attr("class", "vram-ticks");

  const rows = col.selectAll("g.vram-row")
    .data(model.leaves)
    .join("g")
    // Non "dimmable": la barra chiara codifica gia' il "non entra" con la
    // luminanza; attenuarla ancora la renderebbe quasi invisibile.
    .attr("class", "vram-row")
    .attr("transform", (d) => `translate(0,${d.sy})`);

  rows.append("rect").attr("class", "vram-bar").attr("y", -BAR_H / 2).attr("height", BAR_H).attr("width", 0);
  rows.append("path").attr("class", "vram-break")
    .attr("d", `M${BREAK_AT - 2},${BAR_H / 2 + 1}L${BREAK_AT + 1},${-BAR_H / 2 - 1}M${BREAK_AT + 2},${BAR_H / 2 + 1}L${BREAK_AT + 5},${-BAR_H / 2 - 1}`);
  rows.append("text").attr("class", "vram-value").attr("dy", "0.32em");

  // Linea della capacita': sopra le barre, per tutta l'altezza delle righe.
  const lastY = d3.max(model.leaves, (d) => d.sy) ?? 0;
  const capLine = col.append("line").attr("class", "gpu-line")
    .attr("y1", -ROW / 2).attr("y2", lastY + ROW / 2);
  const countG = col.append("g").attr("class", "collapsed-counts")
    .selectAll("g")
    .data(model.leaves.filter(isCollapsed))
    .join("g");
  const countBg = countG.append("rect").attr("class", "collapsed-count-bg");
  const countSel = countG.append("text")
    .attr("class", "vram-value is-text collapsed-count")
    .attr("x", 0)
    .attr("y", (d) => d.sy)
    .attr("dy", "0.32em");
  const capHeadLine = head.append("line").attr("class", "gpu-line")
    .attr("y1", headerY + 1).attr("y2", headerY + 8);

  function update(gpu, quant, animate = true) {
    const cap = gpu.vram_gib;
    const x = d3.scaleLinear().domain([0, 2 * cap]).range([0, VRAM_W]);
    const t = animate ? d3.transition().duration(450) : null;
    const tr = (sel) => (t ? sel.transition(t) : sel);
    const qLabel = QUANTS.find((q) => q.id === quant)?.short ?? quant;

    head.select("[data-role=title]").text(`VRAM stimata (GiB) · ${qLabel}`);

    // Tick in GiB nell'intestazione: 0, C/2, C, 3C/2, 2C.
    const ticks = [0, 0.5, 1, 1.5, 2].map((f) => f * cap);
    ticksG.selectAll("text")
      .data(ticks)
      .join("text")
      .attr("class", (d, i) => (i === 2 ? "vram-tick tick-gpu" : "vram-tick"))
      .attr("x", (d) => x(d))
      .attr("y", headerY - 3)
      .attr("text-anchor", (d, i) => (i === 0 ? "start" : i === 4 ? "end" : "middle"))
      .text((d) => num(d, 1));
    ticksG.selectAll("line")
      .data(ticks)
      .join("line")
      .attr("class", "vram-tickmark")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", headerY + 1).attr("y2", headerY + 5);

    capLine.attr("x1", x(cap)).attr("x2", x(cap));
    capHeadLine.attr("x1", x(cap)).attr("x2", x(cap));

    rows.each(function (d) {
      const row = d3.select(this);
      if (isCollapsed(d)) {
        // Clade compresso (versione minima di M2-d): nessuna barra
        // aggregata, solo il conteggio "k di N entrano", piu' i chiusi.
        // Una barra media o massima direbbe una VRAM che nessun modello ha.
        const ms = modelsIn(d);
        const k = ms.filter((m) => fitStatus(m, gpu, quant) === "fits").length;
        const api = ms.filter((m) => fitStatus(m, gpu, quant) === "api").length;
        row.attr("data-status", "clade");
        row.select(".vram-break").attr("display", "none");
        row.select(".vram-bar").attr("width", 0);
        row.select(".vram-value").text("");
        // Il testo sta in un livello SOPRA la linea della GPU, con un alone
        // bianco: e' piu' lungo di meta' colonna e la linea lo taglierebbe.
        const txt = countSel.filter((c) => c === d)
          .text(api === ms.length ? `solo API (${ms.length})` : `${k} di ${ms.length} entrano${api ? ` · ${api} solo API` : ""}`);
        // Fondo bianco sotto il testo: la linea della GPU si interrompe
        // (l'alone delle lettere non copre gli spazi tra le parole).
        const bb = txt.node().getBBox();
        countBg.filter((c) => c === d)
          .attr("x", bb.x - 2).attr("y", bb.y).attr("width", bb.width + 4).attr("height", bb.height);
        return;
      }
      const n = d.data.ref;
      const status = fitStatus(n, gpu, quant);
      const v = n.vram_gib?.[quant];
      const hasBar = status === "fits" || status === "nofit";
      const clipped = hasBar && v > 2 * cap;
      row.attr("data-status", status);
      row.select(".vram-break").attr("display", clipped ? null : "none");
      tr(row.select(".vram-bar"))
        .attr("width", hasBar ? Math.max(1, Math.min(VRAM_W, x(v))) : 0);
      row.select(".vram-bar").classed("fits", status === "fits").classed("nofit", status === "nofit");
      const label = row.select(".vram-value")
        .classed("is-text", !hasBar)
        .classed("clipped", clipped)
        .text(hasBar ? gib(v) : status === "api" ? "solo API" : "n.d.");
      // Se il numero cadrebbe sopra la linea della GPU (barra che finisce
      // appena prima), lo sposto a destra della linea: resta leggibile.
      let lx = hasBar ? Math.min(VRAM_W, x(v)) + 4 : 0;
      if (hasBar && v <= cap && x(cap) - x(v) < 30) lx = x(cap) + 4;
      tr(label).attr("x", lx);
    });
  }

  return { update, width: VRAM_W + VRAM_LABEL_W };
}
