// Legenda HTML nel pannello laterale: sempre visibile, non si sposta con lo zoom.
// Ogni voce usa gli stessi stili SVG della vista, cosi' legenda e disegno
// non possono divergere.

/* global d3 */

import { LOW, HIGH, FALLBACK_K } from "./scores.js";

const SVGNS = "http://www.w3.org/2000/svg";

function swatch(w, h, draw) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("aria-hidden", "true");
  draw(d3.select(svg));
  return svg;
}

function item(list, svgNode, html) {
  const li = list.append("li");
  li.node().appendChild(svgNode);
  li.append("span").html(html);
  return li;
}

/** Sezione della legenda richiudibile (<details>), aperta di default. */
function section(root, title, cls = "") {
  const sec = root.append("details").attr("class", `legend-section ${cls}`.trim()).property("open", true);
  sec.append("summary").append("h3").text(title);
  return sec;
}

export function drawLegend(container, model) {
  const root = d3.select(container);
  root.selectAll("*").remove();

  // Ordine delle sezioni: prima la colonna VRAM, subito sotto i selettori di
  // GPU e quantizzazione che la comandano. E' il canale del task primario
  // (task 2) e deve restare visibile anche a 1280x720 (proiettore).
  drawVramLegend(root, model);
  drawScoresLegend(root, model);

  // 2. Organizzazioni (tinta)
  const orgSec = section(root, "Organizzazione (colore)");
  orgSec.append("p").attr("class", "legend-note legend-lead")
    .text("Tinte prima alle org con derivazioni tra famiglie.");
  // Le org colorate su due colonne (lette dall'alto in basso, nell'ordine
  // del criterio), il grigio "altre" sotto, a tutta larghezza.
  const orgList = orgSec.append("ul").attr("class", "legend-list two-cols");
  const otherList = orgSec.append("ul").attr("class", "legend-list");
  for (const o of model.orgs) {
    const li = item(
      o.isOther ? otherList : orgList,
      swatch(30, 14, (s) => {
        s.append("circle").attr("class", "model-mark").attr("cx", 7).attr("cy", 7).attr("r", 4.5).attr("fill", o.color);
        s.append("rect").attr("class", "strip-cell").attr("x", 18).attr("y", 1).attr("width", 10).attr("height", 12).attr("fill", o.color);
      }),
      `${o.org} <span class="muted">(${o.count})</span>`,
    );
    if (o.isOther) {
      li.classed("other", true).attr("title", o.members.join(", "));
      li.append("div").attr("class", "legend-note").text(
        o.members.join(", ") + (o.allInOwnClade
          ? ": modelli tutti nel proprio clade, l'org si legge dalla posizione e dal testo."
          : "."),
      );
    }
  }

  // 3. Nodi (forma e riempimento)
  const nodeSec = section(root, "Nodi");
  const nodeList = nodeSec.append("ul").attr("class", "legend-list");
  item(nodeList, swatch(30, 14, (s) => {
    s.append("circle").attr("class", "model-mark").attr("cx", 7).attr("cy", 7).attr("r", 4.5).attr("fill", "#6b6b6b");
  }), "modello <b>open</b>: pesi scaricabili");
  item(nodeList, swatch(30, 14, (s) => {
    s.append("circle").attr("class", "model-mark").attr("cx", 7).attr("cy", 7).attr("r", 4.5).attr("fill", "#6b6b6b");
    s.append("circle").attr("class", "closed-hole").attr("cx", 7).attr("cy", 7).attr("r", 4.5 * 0.45);
  }), "modello <b>chiuso</b>: solo via API");
  item(nodeList, swatch(30, 14, (s) => {
    s.append("rect").attr("class", "clade-mark").attr("x", 2.5).attr("y", 2.5).attr("width", 9).attr("height", 9);
    s.append("path").attr("class", "clade-glyph").attr("d", "M4.5,7H9.5");
  }), "clade: gruppo di modelli · click sul quadrato: comprimi");
  // Clade compresso (M2-d, versione minima): triangolo + "N modelli"; nelle
  // colonne la strip divisa per organizzazione e "k di N entrano".
  item(nodeList, swatch(30, 14, (s) => {
    s.append("path").attr("class", "collapsed-wedge").attr("d", "M7,7L28,1.5V12.5Z");
    s.append("rect").attr("class", "clade-mark").attr("x", 2.5).attr("y", 2.5).attr("width", 9).attr("height", 9);
    s.append("path").attr("class", "clade-glyph").attr("d", "M4.5,7H9.5M7,4.5V9.5");
  }), "clade <b>compresso</b>: una riga, «k di N entrano» nella VRAM, niente punteggi; con un task, il numero dei migliori che contiene");
  // Convenzione dei dati (diarioRiccardo, R5-bis): le generazioni sono "a
  // scala", ogni clade contiene anche le generazioni successive, e
  // l'etichetta lo dice con il "+". Va spiegato, altrimenti "Llama 4
  // Maverick" dentro "Llama 3.3+" si legge come un errore.
  // L'esempio si prende dai dati (il primo clade con "+"), non si scrive qui.
  const plus = model.raw.nodes.find((n) => n.kind === "clade" && /\+$/.test(n.label ?? ""));
  if (plus) {
    const base = plus.label.slice(0, -1);
    nodeSec.append("p").attr("class", "legend-note").append("span")
      .html(`<i>${base}+</i> = la generazione ${base} e tutte le successive: ogni generazione contiene quelle che vengono dopo.`);
  }

  // 4. Archi (tratto)
  const linkSec = section(root, "Archi");
  const linkList = linkSec.append("ul").attr("class", "legend-list");
  item(linkList, swatch(30, 14, (s) => {
    s.append("path").attr("class", "link link-documented").attr("d", "M2,7H28");
  }), "parentela <b>documentata</b> (fonte ufficiale)");
  item(linkList, swatch(30, 14, (s) => {
    s.append("path").attr("class", "link link-inferred").attr("d", "M2,7H28");
  }), "parentela <b>dedotta</b> (ricostruita da noi)");
  item(linkList, swatch(30, 14, (s) => {
    s.append("path").attr("class", "link link-self").attr("d", "M2,7H28");
  }), "stesso modello: non è una parentela");
  // Reticolazioni (M2): voce solo se nei dati ce ne sono.
  if (model.reticulations.length) {
    item(linkList, swatch(30, 14, (s) => {
      s.append("path").attr("class", "ret").attr("d", "M2,12C10,12 10,2 22,2");
      s.append("path").attr("class", "ret-arrow").attr("d", "M21,-1L28,2L21,5z");
    }), "<b>reticolazione</b>: genitore secondario (distillazione, merge), freccia verso il figlio; tratteggiata se dedotta");
  }
  linkSec.append("p").attr("class", "legend-note")
    .text("x = profondità nella genealogia, radice a sinistra.");

  return root;
}

// 1. Colonna VRAM
function drawVramLegend(root, model) {
  const ctx = model.raw.meta?.reference_context_tokens;
  const vSec = section(root, "Colonna VRAM", "legend-vram");
  const vList = vSec.append("ul").attr("class", "legend-list");
  item(vList, swatch(30, 14, (s) => {
    s.append("rect").attr("class", "vram-bar fits").attr("x", 2).attr("y", 2).attr("width", 16).attr("height", 10);
    s.append("line").attr("class", "gpu-line").attr("x1", 22).attr("x2", 22).attr("y1", 0).attr("y2", 14);
  }), "<b>entra</b> nella GPU scelta");
  item(vList, swatch(30, 14, (s) => {
    s.append("line").attr("class", "gpu-line").attr("x1", 14).attr("x2", 14).attr("y1", 0).attr("y2", 14);
    s.append("rect").attr("class", "vram-bar nofit").attr("x", 2).attr("y", 2).attr("width", 24).attr("height", 10);
    s.append("line").attr("class", "gpu-line").attr("x1", 14).attr("x2", 14).attr("y1", 0).attr("y2", 14);
  }), "<b>non entra</b> (nome in grigio)");
  item(vList, swatch(30, 14, (s) => {
    s.append("line").attr("class", "gpu-line").attr("x1", 15).attr("x2", 15).attr("y1", 0).attr("y2", 14);
  }), "VRAM della GPU scelta");
  item(vList, swatch(30, 14, (s) => {
    s.append("rect").attr("class", "vram-bar nofit").attr("x", 2).attr("y", 2).attr("width", 26).attr("height", 10);
    s.append("path").attr("class", "vram-break").attr("d", "M17,13L20,1M21,13L24,1");
  }), "troncata: oltre la scala, il numero è il valore");
  item(vList, swatch(30, 14, (s) => {
    s.append("text").attr("class", "vram-value is-text").attr("x", 1).attr("y", 11).text("API");
  }), "<i>solo API</i>: non gira in locale · <i>n.d.</i>: manca il dato");
  // Visibile sempre: le due regole che servono a leggere barra e linea.
  vSec.append("p").attr("class", "legend-note").html(
    "<b>Scala:</b> da 0 a 2 × la VRAM della GPU, la linea è sempre a metà. " +
    "<b>Entra</b> se VRAM stimata ≤ VRAM della GPU.",
  );
  // Dettagli della stima, apribili. Niente costanti della formula scritte
  // qui: le decide Riccardo (CP1) e stanno in meta.vram_formula.
  const det = vSec.append("details").attr("class", "legend-note");
  det.append("summary").text("Come è stimata la VRAM");
  det.append("div").text(
    `A batch 1, con un contesto di ${ctx ? ctx.toLocaleString("it-IT") : "n.d."} token (o il contesto massimo del modello, se è minore). ` +
    "INT8 = Q8_0 e Q4 = Q4_K_M di llama.cpp.",
  );
  if (model.raw.meta?.vram_formula) det.append("code").text(model.raw.meta.vram_formula);
}

// Heatmap dei punteggi (M2): luminanza grigia interpolata in Lab, scala per
// colonna, n.d. distinto dal minimo, marcatura dei migliori.
function drawScoresLegend(root, model) {
  const tasks = model.raw.tasks ?? [];
  if (!tasks.length) return;
  const sec = section(root, "Punteggi (LMArena)");
  const list = sec.append("ul").attr("class", "legend-list");
  const interp = d3.interpolateLab(LOW, HIGH);
  item(list, swatch(30, 14, (s) => {
    for (let i = 0; i < 6; i++) {
      s.append("rect").attr("x", 1 + i * 4.6).attr("y", 2).attr("width", 4.8).attr("height", 10).attr("fill", interp(i / 5));
    }
  }), "rating: da <b>chiaro</b> (minimo della colonna) a <b>scuro</b> (massimo). Ogni colonna ha la sua scala");
  item(list, swatch(30, 14, (s) => {
    s.append("rect").attr("class", "score-rect score-nd").attr("x", 2).attr("y", 2).attr("width", 26).attr("height", 10);
  }), "<i>n.d.</i>: il modello non è in quella classifica (non è un punteggio basso)");
  item(list, swatch(30, 14, (s) => {
    s.append("rect").attr("x", 3).attr("y", 2).attr("width", 24).attr("height", 10).attr("fill", interp(0.8));
    s.append("rect").attr("class", "best-outer").attr("x", 2).attr("y", 1).attr("width", 26).attr("height", 12);
    s.append("rect").attr("class", "best-inner").attr("x", 3.5).attr("y", 2.5).attr("width", 23).attr("height", 9);
  }), "<b>migliori che entrano</b> nella GPU per il task scelto: il primo e chi ha l'intervallo pubblicato da LMArena sovrapposto al suo (nome in grassetto)");
  sec.append("p").attr("class", "legend-note legend-fallback").attr("hidden", true)
    .text(`Intervallo non disponibile per il migliore: si mostrano i primi ${FALLBACK_K} per rating.`);
}

/** Mostra o nasconde in legenda la nota del ripiego top-k (quando scatta). */
export function setFallbackNote(on) {
  d3.select(".legend-fallback").attr("hidden", on ? null : true);
}
