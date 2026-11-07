// Controlli: GPU, quantizzazione, ricerca (zoom and filter, Locate).
// Le GPU si leggono da data.gpus: nessuna capacita' e' scritta nel codice.

/* global d3 */

import { QUANTS } from "./vram.js";
import { num } from "./fmt.js";

const CATEGORY_ORDER = ["consumer", "workstation", "datacenter", "apple"];
const CATEGORY_IT = {
  consumer: "Consumer",
  workstation: "Workstation",
  datacenter: "Data center",
  apple: "Apple (memoria unificata)",
};

/** GPU di partenza: la consumer con piu' VRAM (calcolata dai dati). */
export function defaultGpu(gpus) {
  const consumer = gpus.filter((g) => g.category === "consumer");
  const pool = consumer.length ? consumer : gpus;
  return pool.reduce((a, b) => (b.vram_gib > a.vram_gib ? b : a), pool[0]);
}

export function drawControls(container, model, state, on) {
  const root = d3.select(container);
  root.selectAll("*").remove();

  // GPU
  const gpuField = root.append("div").attr("class", "field");
  gpuField.append("label").attr("for", "gpu-select").text("La tua GPU");
  const select = gpuField.append("select").attr("id", "gpu-select");
  const gpus = model.raw.gpus.slice();
  const cats = CATEGORY_ORDER.concat([...new Set(gpus.map((g) => g.category))].filter((c) => !CATEGORY_ORDER.includes(c)));
  for (const cat of cats) {
    const list = gpus.filter((g) => g.category === cat)
      .sort((a, b) => d3.ascending(a.vram_gib, b.vram_gib) || d3.ascending(a.label, b.label));
    if (!list.length) continue;
    const og = select.append("optgroup").attr("label", CATEGORY_IT[cat] ?? cat);
    for (const g of list) {
      og.append("option").attr("value", g.id).property("selected", g.id === state.gpuId)
        // La capacita' per prima: e' il dato che serve al task 2, e i nomi
        // commerciali lunghi ("NVIDIA GeForce RTX 4060 Ti 16 GB") venivano
        // tagliati dal select proprio sul numero.
        .text(`${num(g.vram_gib)} GiB · ${g.label}`);
    }
  }
  select.on("change", (ev) => on.gpu(ev.target.value));

  // Quantizzazione: pulsanti a scelta singola
  const qField = root.append("div").attr("class", "field");
  qField.append("span").attr("class", "field-label").attr("id", "quant-label").text("Quantizzazione");
  const seg = qField.append("div").attr("class", "segmented").attr("role", "radiogroup").attr("aria-labelledby", "quant-label");
  const buttons = seg.selectAll("button")
    .data(QUANTS)
    .join("button")
    .attr("type", "button")
    .attr("role", "radio")
    .attr("data-quant", (d) => d.id)
    .text((d) => d.label)
    .on("click", (ev, d) => on.quant(d.id));
  const syncQuant = (q) => buttons.attr("aria-checked", (d) => String(d.id === q)).classed("active", (d) => d.id === q);
  syncQuant(state.quant);

  // Task (M2): pulsanti a scelta singola, "Nessuno" + un pulsante per task.
  // Evidenzia i migliori tra i modelli che entrano nella GPU scelta e scrive
  // la risposta in testo (task 3).
  const tasks = model.raw.tasks ?? [];
  let syncTask = () => {};
  let setBestAnswer = () => {};
  if (tasks.length) {
    const tField = root.append("div").attr("class", "field");
    tField.append("span").attr("class", "field-label").attr("id", "task-label").text("Task: migliori che entrano");
    const tSeg = tField.append("div").attr("class", "segmented segmented-task").attr("role", "radiogroup").attr("aria-labelledby", "task-label");
    const tOpts = [{ id: null, label: "Nessuno" }].concat(tasks.map((t) => ({ id: t.id, label: t.label })));
    const tButtons = tSeg.selectAll("button")
      .data(tOpts)
      .join("button")
      .attr("type", "button")
      .attr("role", "radio")
      .attr("data-task", (d) => d.id ?? "")
      .text((d) => d.label)
      .on("click", (ev, d) => on.task(d.id));
    syncTask = (id) => tButtons.attr("aria-checked", (d) => String(d.id === id)).classed("active", (d) => d.id === id);
    syncTask(state.taskId ?? null);
    const answer = tField.append("div").attr("class", "best-answer").attr("aria-live", "polite");
    setBestAnswer = (task, gpu, quant, res) => {
      answer.selectAll("*").remove();
      if (!task) return;
      const q = QUANTS.find((x) => x.id === quant)?.short ?? quant;
      const head = answer.append("div").attr("class", "best-head");
      head.append("b").text(task.label);
      head.append("span").text(` · ${gpu.label} · ${q}`);
      if (!res.ranked.length) {
        answer.append("div").text("Nessun modello con un punteggio entra in questa GPU con questa quantizzazione.");
        return;
      }
      answer.append("div").text(res.fallback
        ? `Intervallo non disponibile: primi ${res.ranked.length} per rating, su ${res.candidates} che entrano.`
        : `${res.ranked.length === 1 ? "1 modello" : `${res.ranked.length} modelli`} pari al migliore entro l'intervallo pubblicato da LMArena, su ${res.candidates} che entrano:`);
      const ol = answer.append("ol").attr("class", "best-list");
      ol.selectAll("li").data(res.ranked).join("li")
        .append("button").attr("type", "button").attr("class", "linklike")
        .text((n) => `${n.label} (${num(n.scores[task.id], 0)})`)
        .on("click", (ev, n) => on.search(n.label));
    };
  }

  // Ricerca
  const sField = root.append("div").attr("class", "field");
  sField.append("label").attr("for", "search").text("Cerca un modello");
  const row = sField.append("div").attr("class", "search-row");
  const input = row.append("input")
    .attr("id", "search")
    .attr("type", "search")
    .attr("list", "model-names")
    .attr("placeholder", "es. nome del modello")
    .attr("autocomplete", "off");
  const names = [...new Set(model.raw.nodes.filter((n) => n.kind === "model").map((n) => n.label))].sort((a, b) => a.localeCompare(b, "it"));
  root.append("datalist").attr("id", "model-names")
    .selectAll("option").data(names).join("option").attr("value", (d) => d);
  const msg = sField.append("div").attr("class", "search-msg").attr("aria-live", "polite");

  input.on("keydown", (ev) => {
    if (ev.key === "Enter") on.search(ev.target.value);
    if (ev.key === "Escape") { ev.target.value = ""; on.search(""); }
  });
  // Scelta di un suggerimento dalla datalist: arriva come "input" con il valore intero.
  input.on("input", (ev) => {
    if (names.includes(ev.target.value)) on.search(ev.target.value);
    if (ev.target.value === "") on.search("");
  });

  return {
    syncQuant,
    syncTask,
    setBestAnswer,
    setSearchMessage: (text) => msg.text(text),
  };
}
