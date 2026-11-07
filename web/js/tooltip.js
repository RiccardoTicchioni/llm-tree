// Details-on-demand: tooltip con i valori e, per ognuno, la sua fonte.
// Passaggio del mouse = tooltip temporaneo; click = tooltip fissato (i link
// alle fonti diventano cliccabili); Esc o click sullo sfondo = chiudi.

/* global d3 */

import { QUANTS, fitStatus } from "./vram.js";
import { isCollapsed, modelsIn } from "./tree.js";
import { num, usd } from "./fmt.js";

const REL_IT = {
  lineage: "membro del gruppo",
  next_generation: "generazione successiva",
  variant: "variante",
  fine_tune: "fine-tune",
  distillation: "distillazione",
  merge: "merge",
};
const CERT_IT = { documented: "documentata", inferred: "dedotta" };
const WEIGHTS_IT = { open: "open (scaricabili)", closed: "chiusi (solo API)" };
const LICENSE_IT = {
  permissive: "permissiva",
  copyleft: "copyleft",
  restricted: "con restrizioni",
  proprietary: "proprietaria",
  unknown: "sconosciuta",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ND = '<span class="nd">n.d.</span>';
const domainOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};

// Data di consultazione: "2026-11-07T11:15:29+01:00" → "2026-11-07 11:15".
// La data ISO completa andava a capo a meta' e non aggiungeva informazione.
function accessedText(v) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(String(v));
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : String(v);
}

// Criteri di selezione di Riccardo (diarioRiccardo.md, CP1 e R2-bis; testi
// di A2, B2 e C rivisti da Riccardo alle 16:31): il
// codice da solo ("B2") non dice nulla all'utente. Codice sconosciuto → si
// mostra com'e'.
const CRITERIA = {
  "A1": "open, tra i 2 con il rating LMArena più alto della sua organizzazione",
  "A2": "open, tra i 3 più scaricati di sempre su Hugging Face della sua organizzazione, esclusi quelli già scelti per rating",
  "B1": "chiuso, tra i 2 con il rating LMArena più alto della sua organizzazione",
  "B2": "chiuso, tra i 2 con più voti su LMArena della sua organizzazione, esclusi quelli già scelti per rating",
  "C": "derivato dai pesi di un'altra famiglia (campo Base model di Epoch): il più scaricato per ogni coppia organizzazione–famiglia",
  "C-base": "modello base di un derivato tra famiglie (criterio C)",
};
function criterionText(code) {
  const t = CRITERIA[code];
  return t ? `${esc(t)} <span class="muted">(${esc(code)})</span>` : esc(code);
}

export function createTooltip(wrap, model, getState) {
  const tip = d3.select(wrap).append("div").attr("id", "tooltip").attr("role", "dialog").attr("hidden", true);
  let pinned = false;

  function html(datum) {
    if (datum.source && datum.target) return linkHtml(datum);
    return nodeHtml(datum);
  }

  function makeRefs() {
    const order = [];
    const ref = (srcId) => {
      if (!srcId) return "";
      let i = order.indexOf(srcId);
      if (i < 0) { order.push(srcId); i = order.length - 1; }
      return `<sup class="ref">[${i + 1}]</sup>`;
    };
    const list = () => {
      if (!order.length) return '<div class="tt-sources muted">Nessuna fonte per i valori mostrati.</div>';
      const items = order.map((id, i) => {
        const s = model.sourceById.get(id);
        if (!s) return `<li>[${i + 1}] <span class="nd">fonte “${esc(id)}” non trovata in meta.sources</span></li>`;
        const acc = s.accessed ? ` · consultata ${esc(accessedText(s.accessed))}` : "";
        return `<li>[${i + 1}] <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="muted">— ${esc(domainOf(s.url))}${acc}</span></li>`;
      });
      return `<div class="tt-sources"><div class="tt-sources-title">Fonti</div><ol>${items.join("")}</ol></div>`;
    };
    return { ref, list };
  }

  function row(label, value) {
    return `<tr><th>${label}</th><td>${value}</td></tr>`;
  }

  function parentLines(n, ref) {
    const out = [];
    const e = model.treeEdgeByTarget.get(n.id);
    if (e) {
      const p = model.byId.get(e.source);
      const ev = e.evidence_url ? ` <a href="${esc(e.evidence_url)}" target="_blank" rel="noopener">prova</a>` : "";
      out.push(row("Deriva da", `${esc(p?.label ?? e.source)} <span class="muted">(${REL_IT[e.relation] ?? e.relation}, ${CERT_IT[e.certainty] ?? e.certainty})</span>${ev}`));
    }
    for (const r of model.reticulations.filter((x) => x.target === n.id)) {
      const p = model.byId.get(r.source);
      const ev = r.evidence_url ? ` <a href="${esc(r.evidence_url)}" target="_blank" rel="noopener">prova</a>` : "";
      out.push(row("Anche da", `${esc(p?.label ?? r.source)} <span class="muted">(${REL_IT[r.relation] ?? r.relation}, ${CERT_IT[r.certainty] ?? r.certainty})</span>${ev}`));
    }
    return out.join("");
  }

  function pathText(d) {
    const chain = d.ancestors().reverse().filter((x) => !x.data.self);
    return chain.map((x, i) => {
      const lab = i === chain.length - 1 ? `<b>${esc(x.data.ref.label)}</b>` : esc(x.data.ref.label);
      if (i === 0) return lab;
      const e = model.treeEdgeByTarget.get(x.data.ref.id);
      const bits = [];
      if (e && e.relation !== "lineage") bits.push(REL_IT[e.relation] ?? esc(e.relation));
      if (e && e.certainty === "inferred") bits.push("dedotta");
      // La relazione sta SULLA freccia del passo ("—fine-tune→"), cosi' non
      // si confonde con il nodo prima o dopo; "membro del gruppo" = " › ".
      return bits.length ? ` <span class="muted">—${bits.join(", ")}→</span> ${lab}` : ` › ${lab}`;
    }).join("");
  }

  let pinnedMode = false;

  function nodeHtml(d) {
    const n = d.data.ref;
    const { ref, list } = makeRefs();
    const s = n.sources || {};
    const val = (v, key, f = (x) => esc(x)) => (v === null || v === undefined ? ND : f(v) + ref(s[key]));

    if (n.kind === "clade") {
      // Conta anche dentro i cladi compressi (_children), vedi modelsIn.
      const members = modelsIn(d);
      const collapsed = isCollapsed(d);
      let extra = "";
      if (collapsed) {
        // Riga del clade compresso: il riepilogo della VRAM che la colonna
        // scrive come "k di N entrano", qui diviso per stato.
        const { gpu, quant } = getState();
        const c = { fits: 0, nofit: 0, api: 0, nd: 0 };
        for (const m of members) c[fitStatus(m, gpu, quant)] += 1;
        const q = QUANTS.find((x) => x.id === quant)?.label ?? quant;
        const orgs = [...d3.rollup(members, (v) => v.length, (m) => m.organization ?? "n.d.")]
          .sort((a, b) => b[1] - a[1]);
        extra = row("Organizzazioni", orgs.map(([o, k]) => `${esc(o)} (${k})`).join(" · "));
        extra += row("VRAM", `<span class="ok">${c.fits} entrano</span> · <span class="ko">${c.nofit} non entrano</span> · ${c.api} solo API · ${c.nd} n.d.<br><span class="muted">${esc(gpu.label)} (${num(gpu.vram_gib)} GiB), ${esc(q)}</span>`);
      }
      const hint = collapsed ? "Click sulla riga o sul quadrato: espandi." : "Click sul quadrato: comprimi.";
      return `<div class="tt-title">${esc(n.label)}</div>
        <div class="tt-sub">clade${collapsed ? " compresso" : ""} · gruppo di ${members.length} modell${members.length === 1 ? "o" : "i"}</div>
        <table>${row("Primo modello", val(n.release_date, "release_date"))}${extra}${parentLines(n, ref)}</table>${list()}
        <div class="tt-note muted">${hint}</div>`;
    }

    const { gpu, quant } = getState();
    const status = fitStatus(n, gpu, quant);
    const color = model.orgColor(n.organization);

    let params = ND;
    if (n.params_total_b !== null && n.params_total_b !== undefined) {
      params = `${num(n.params_total_b)} mld${ref(s.params_total_b)}`;
      if (n.params_active_b !== null && n.params_active_b !== undefined && n.params_active_b !== n.params_total_b) {
        params += ` totali · ${num(n.params_active_b)} mld attivi${ref(s.params_active_b)} (MoE)`;
      }
    }

    let vram;
    if (n.weights === "closed") vram = '<span class="nd">solo API (pesi chiusi)</span>';
    else if (!n.vram_gib) vram = ND;
    else {
      const parts = QUANTS.map((q) => {
        const v = n.vram_gib[q.id];
        const txt = `${q.label} ${v === null || v === undefined ? "n.d." : num(v) + " GiB"}`;
        return q.id === quant ? `<b>${txt}</b>` : txt;
      });
      vram = parts.join(" · ") + ref(s.vram_gib);
      // Contesto usato nella stima: regola del contratto 1.2.
      const refCtx = model.raw.meta?.reference_context_tokens;
      if (refCtx) {
        const used = n.context_max_tokens ? Math.min(refCtx, n.context_max_tokens) : refCtx;
        vram += `<br><span class="muted">stima con contesto di ${num(used, 0)} token, batch 1</span>`;
      }
      const verdict = status === "fits" ? `<span class="ok">entra</span> in ${esc(gpu.label)} (${num(gpu.vram_gib)} GiB)`
        : status === "nofit" ? `<span class="ko">non entra</span> in ${esc(gpu.label)} (${num(gpu.vram_gib)} GiB)`
          : "";
      if (verdict) vram += `<br>${verdict}`;
    }

    const price = n.api_price_usd_per_mtok
      ? `${usd(n.api_price_usd_per_mtok.input)} input · ${usd(n.api_price_usd_per_mtok.output)} output per M token${ref(s.api_price_usd_per_mtok)}`
      : n.weights === "open" ? '<span class="nd">n.d. (pesi open: anche in locale)</span>' : ND;

    // Punteggi (contratto 1.3): rating, intervallo pubblicato da LMArena
    // (senza percentuale: LMArena non dichiara il livello), voti, variante.
    // La metrica e lo snapshot sono uguali per tutti i modelli: una riga sola.
    const tasks = model.raw.tasks || [];
    const scores = tasks.map((t) => {
      const v = n.scores?.[t.id];
      if (v === null || v === undefined) return row(esc(t.label), ND);
      const d = n.score_detail?.[t.id];
      const ci = d ? ` <span class="muted">[${num(d.lower, 0)} – ${num(d.upper, 0)}]</span>` : "";
      const votes = d?.votes ? ` <span class="muted">· ${num(d.votes, 0)} voti</span>` : "";
      // La variante LMArena solo se dice qualcosa in piu' del nome del nodo.
      const variant = d?.lmarena_variant && d.lmarena_variant.toLowerCase() !== String(n.label).toLowerCase()
        ? `<br><span class="muted">variante LMArena: ${esc(d.lmarena_variant)}</span>` : "";
      return row(esc(t.label), `<b>${num(v, 0)}</b>${ci}${ref(s[`scores.${t.id}`])}${votes}${variant}`);
    }).join("");
    const t0 = tasks[0];
    const scoreNote = tasks.length && tasks.some((t) => n.scores?.[t.id] !== null && n.scores?.[t.id] !== undefined)
      ? `<tr><td colspan="2" class="tt-note">Classifica del ${esc(t0.snapshot_date)} (la metrica di ogni task è nel titolo della sua colonna). Tra parentesi quadre l'intervallo pubblicato da LMArena. I rating di task diversi non si confrontano.</td></tr>`
      : "";

    const license = n.license === null || n.license === undefined
      ? ND
      : `${esc(n.license)}${ref(s.license)} <span class="muted">(${LICENSE_IT[n.license_class] ?? esc(n.license_class)})</span>`;

    const hf = n.hf_repo
      ? row("Hugging Face", `<a href="https://huggingface.co/${esc(n.hf_repo)}" target="_blank" rel="noopener">${esc(n.hf_repo)}</a>`)
      : "";
    const why = n.selection_criterion ? row("Nel dataset perché", criterionText(n.selection_criterion)) : "";
    // Cammino fino alla radice (task 4), solo nel tooltip fissato: e' la
    // risposta testuale all'evidenziazione. Per ogni passo che non e'
    // "membro del gruppo" si scrive la relazione e, se dedotta, la certezza.
    const path = pinnedMode ? row("Cammino", pathText(d)) : "";

    return `<div class="tt-title"><span class="tt-dot" style="background:${color}"></span>${esc(n.label)}</div>
      <div class="tt-sub">${esc(n.organization ?? "organizzazione n.d.")} · famiglia ${esc(n.family ?? "n.d.")}</div>
      <table>
        ${parentLines(n, ref)}
        ${row("Rilascio", val(n.release_date, "release_date"))}
        ${row("Pesi", n.weights ? WEIGHTS_IT[n.weights] : ND)}
        ${row("Parametri", params)}
        ${row("Contesto max", val(n.context_max_tokens, "context_max_tokens", (v) => `${num(v, 0)} token`))}
        ${row("Licenza", license)}
        ${row("VRAM stimata", vram)}
        ${row("Prezzo API", price)}
        ${scores}
        ${scoreNote}
        ${hf}
        ${why}
        ${path}
      </table>
      ${list()}`;
  }

  function linkHtml(l) {
    if (!l.reticulation && l.target.data.self) {
      return `<div class="tt-title">${esc(l.target.data.ref.label)}</div>
        <div class="tt-sub">linea guida: porta alla riga dello stesso modello, che ha anche dei discendenti. Non è una parentela.</div>`;
    }
    // Reticolazione: l'arco e' nel datum; altrimenti e' l'arco tree del figlio.
    const e = l.edge ?? model.treeEdgeByTarget.get(l.target.id);
    const p = l.source.data.ref;
    const c = l.target.data.ref;
    const ev = e?.evidence_url
      ? `<a href="${esc(e.evidence_url)}" target="_blank" rel="noopener">${esc(domainOf(e.evidence_url))}</a>`
      : e?.certainty === "inferred"
        ? '<span class="nd">nessuna fonte diretta (parentela dedotta)</span>'
        : ND;
    const kind = l.reticulation
      ? '<div class="tt-sub">reticolazione: genitore secondario (la linea principale è l\'arco dell\'albero)</div>'
      : "";
    return `<div class="tt-title">${esc(p.label)} → ${esc(c.label)}</div>${kind}
      <table>
        ${row("Relazione", e ? REL_IT[e.relation] ?? esc(e.relation) : ND)}
        ${row("Certezza", e ? CERT_IT[e.certainty] ?? esc(e.certainty) : ND)}
        ${row("Prova", ev)}
      </table>`;
  }

  function place(event) {
    const box = wrap.getBoundingClientRect();
    const node = tip.node();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    let x = event.clientX - box.left + 16;
    let y = event.clientY - box.top + 12;
    if (x + w > box.width - 8) x = Math.max(8, event.clientX - box.left - w - 16);
    if (y + h > box.height - 8) y = Math.max(8, box.height - h - 8);
    tip.style("left", `${x}px`).style("top", `${y}px`);
  }

  return {
    show(event, datum) {
      if (pinned) return;
      tip.html(html(datum)).attr("hidden", null).classed("pinned", false);
      place(event);
    },
    move(event) {
      if (!pinned) place(event);
    },
    hide() {
      if (!pinned) tip.attr("hidden", true);
    },
    pin(event, datum) {
      pinned = true;
      pinnedMode = true;
      const body = html(datum);
      pinnedMode = false;
      tip.html(`<button class="tt-close" aria-label="Chiudi">×</button>${body}`).attr("hidden", null).classed("pinned", true);
      tip.select(".tt-close").on("click", () => this.unpin());
      place(event);
    },
    unpin() {
      pinned = false;
      tip.attr("hidden", true).classed("pinned", false);
      if (this.onUnpin) this.onUnpin(); // es. togliere l'evidenza del cammino
    },
    onUnpin: null,
    get pinned() { return pinned; },
  };
}
