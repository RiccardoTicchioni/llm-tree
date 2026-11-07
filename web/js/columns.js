// Colonne allineate alle foglie, stile iTOL (fase 3 encoding).
// Color strip dell'organizzazione + colonna VRAM. Le intestazioni vanno in
// `headerG`, che resta fisso in alto quando si scorre in verticale.

/* global d3 */

import { ROW, fitText, isCollapsed, modelsIn } from "./tree.js";
import { drawVramColumn } from "./vram.js";
import { drawScoreColumns } from "./scores.js";

export const COL_GAP = 12; // era 14: 3 spazi × 2 px recuperati per la heatmap (M2)
export const STRIP_W = 10;
export const ORG_TEXT_W = 84; // tetto: la larghezza vera si misura sui nomi (vedi drawColumns)
export const HEADER_Y = -ROW / 2 - 12; // riga dei tick, sopra la prima riga

/**
 * Disegna le colonne a destra delle etichette.
 * Restituisce le x delle colonne, la x finale e l'update della VRAM.
 */
export function drawColumns(g, headerG, model, layout, labelEnd) {
  const leaves = model.leaves;
  const orgX = Math.ceil(labelEnd + COL_GAP);

  // Color strip dell'organizzazione: area mark, tinta = organizzazione.
  // Accanto, il nome dell'organizzazione come testo (codifica ridondante):
  // le org sono piu' delle 7 tinte, e quelle nel grigio "altre" restano
  // identificabili riga per riga senza aprire il tooltip.
  const orgHeader = headerG.append("text").attr("class", "col-header").attr("x", orgX).attr("y", HEADER_Y - 3)
    .text("Organizzazione");
  // Larghezza del testo dell'org: quanto il nome piu' lungo (misurato con lo
  // stesso CSS), ma non meno dell'intestazione e non piu' del tetto. Con i
  // dati veri i nomi sono corti ("Mistral AI"): lo spazio risparmiato va
  // alle etichette dei clade (diario M1-f).
  const probe = g.append("text").attr("class", "org-name").attr("visibility", "hidden");
  // Misura su TUTTE le foglie (anche quelle nei cladi compressi): la
  // larghezza non deve cambiare quando si comprime, o le colonne si spostano.
  const allLeaves = model.allLeaves ?? leaves;
  const longestOrg = d3.max(allLeaves, (d) => probe.text(d.data.ref.organization ?? "n.d.").node().getComputedTextLength()) ?? 0;
  probe.remove();
  const headerW = orgHeader.node().getComputedTextLength() - STRIP_W - 5;
  const orgTextW = Math.ceil(Math.min(ORG_TEXT_W, Math.max(longestOrg, headerW)));
  const orgCol = g.append("g").attr("class", "col col-org").attr("transform", `translate(${orgX},0)`);
  const rowLeaves = leaves.filter((d) => !isCollapsed(d));
  // Clade compresso: la cella della strip si divide in segmenti verticali,
  // uno per organizzazione, alti in proporzione ai modelli (stessa tinta,
  // stessa regola "un canale, un significato"); il testo dice la prevalente.
  const orgMix = new Map(leaves.filter(isCollapsed).map((d) => {
    const ms = modelsIn(d);
    const counts = d3.rollups(ms, (v) => v.length, (m) => m.organization ?? "n.d.")
      .sort((a, b) => d3.descending(a[1], b[1]) || d3.ascending(a[0], b[0]));
    return [d, { n: ms.length, counts }];
  }));
  const segs = [];
  for (const [d, mix] of orgMix) {
    let acc = 0;
    for (const [org, k] of mix.counts) {
      segs.push({ d, org, y: acc / mix.n, h: k / mix.n });
      acc += k;
    }
  }
  const SH = ROW - 3;
  orgCol.selectAll("rect.strip-seg")
    .data(segs)
    .join("rect")
    .attr("class", "strip-cell strip-seg")
    .attr("x", 0)
    .attr("y", (s) => s.d.sy - ROW / 2 + 1.5 + s.y * SH)
    .attr("width", STRIP_W)
    .attr("height", (s) => s.h * SH)
    .attr("fill", (s) => model.orgColor(s.org === "n.d." ? null : s.org));
  const orgText = (d) => {
    if (!isCollapsed(d)) return d.data.ref.organization ?? "n.d.";
    const { counts } = orgMix.get(d);
    // Piu' organizzazioni: il numero; quali e quante lo dicono i segmenti
    // della strip e il tooltip ("Meta + 2 altre" non ci stava: si troncava).
    return counts.length === 1 ? counts[0][0] : `${counts.length} org.`;
  };
  orgCol.selectAll("rect.strip-row")
    .data(rowLeaves)
    .join("rect")
    .attr("class", "strip-cell strip-row") // sempre a piena tinta: un canale, un significato
    .attr("x", 0)
    .attr("y", (d) => d.sy - ROW / 2 + 1.5)
    .attr("width", STRIP_W)
    .attr("height", ROW - 3)
    .attr("fill", (d) => model.orgColor(d.data.ref.organization));
  orgCol.selectAll("text")
    .data(leaves)
    .join("text")
    .attr("class", (d) => (isCollapsed(d) ? "org-name collapsed-org" : "org-name dimmable"))
    .attr("x", STRIP_W + 5)
    .attr("y", (d) => d.sy)
    .attr("dy", "0.32em")
    .text(orgText)
    .each(function (d) { fitText(this, orgText(d), orgTextW); });

  const vramX = orgX + STRIP_W + 5 + orgTextW + COL_GAP;
  const vram = drawVramColumn(g, headerG, model, vramX, HEADER_Y);

  // Heatmap dei punteggi (M2): una colonna per task, dopo la VRAM.
  const scoresX = vramX + vram.width + COL_GAP;
  const scores = drawScoreColumns(g, headerG, model, scoresX, HEADER_Y);

  const end = scores.width ? scoresX + scores.width : vramX + vram.width;
  const extent = end + (scores.overhang ?? 0); // fin dove arriva il disegno (intestazioni comprese)
  return { orgX, vramX, scoresX, end, extent, updateVram: vram.update, updateScores: scores.update, scores };
}

/**
 * Fasce alterne delle righe: aiutano a seguire una riga dall'etichetta alle
 * colonne. Lo stato di hover / ricerca si mostra cambiando la loro classe.
 */
export function drawRowBands(g, model, layout, endX) {
  const x0 = layout.leafX - 8;
  return g.selectAll("rect")
    .data(model.leaves)
    .join("rect")
    .attr("class", (d, i) => `row-band ${i % 2 ? "odd" : "even"}`)
    .attr("x", x0)
    .attr("y", (d) => d.sy - ROW / 2)
    .attr("width", endX - x0 + 8)
    .attr("height", ROW);
}

/**
 * Bersagli trasparenti sopra le righe, per il mouse: tutta la riga (foglia,
 * etichetta, colonne) apre lo stesso tooltip. Stanno sopra a tutto, cosi'
 * testo e barre non "rubano" l'evento.
 */
export function drawRowHits(g, model, layout, endX) {
  const x0 = layout.leafX - 8;
  return g.selectAll("rect")
    .data(model.leaves)
    .join("rect")
    .attr("class", "row-hit")
    .attr("x", x0)
    .attr("y", (d) => d.sy - ROW / 2)
    .attr("width", endX - x0 + 8)
    .attr("height", ROW);
}
