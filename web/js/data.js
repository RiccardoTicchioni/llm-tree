// Modello dei dati per la vista (fase 2A, lato visualizzazione).
// Trasforma nodes/edges del contratto in una gerarchia d3 pronta per d3.cluster,
// con i "sampled ancestor" e la palette delle organizzazioni.

/* global d3 */

import { reduceCrossings } from "./order.js";

export const SELF_SUFFIX = "::self";

// Okabe & Ito (2008), senza il nero (riservato alle reticolazioni, M2).
// Ordine: le tinte piu' contrastate su bianco alle organizzazioni piu' grandi,
// il giallo (contrasto piu' basso) per ultimo.
export const OKABE_ITO = [
  { name: "blu", hex: "#0072B2" },
  { name: "arancio", hex: "#E69F00" },
  { name: "verde-blu", hex: "#009E73" },
  { name: "vermiglio", hex: "#D55E00" },
  { name: "celeste", hex: "#56B4E9" },
  { name: "porpora", hex: "#CC79A7" },
  { name: "giallo", hex: "#F0E442" },
];
export const OTHER_COLOR = "#9E9E9E";
export const OTHER_LABEL = "Altre organizzazioni";

/**
 * Prepara tutto quello che serve alla vista.
 * @returns {{
 *   raw, byId: Map, sourceById: Map, treeEdgeByTarget: Map, reticulations: Array,
 *   root: d3.HierarchyNode, leaves: Array, orgs: Array, orgColor: (org)=>string
 * }}
 */
export function prepare(raw) {
  const byId = new Map(raw.nodes.map((n) => [n.id, n]));
  const sourceById = new Map((raw.meta.sources || []).map((s) => [s.id, s]));

  const treeEdges = raw.edges.filter((e) => e.role === "tree");
  const treeEdgeByTarget = new Map(treeEdges.map((e) => [e.target, e]));
  const reticulations = raw.edges.filter((e) => e.role === "reticulation");

  const hasChildren = new Set(treeEdges.map((e) => e.source));

  // Nodi del layout. Un modello con figli diventa un nodo interno PIU' una
  // foglia "self" che porta la sua riga nelle colonne (sampled ancestor).
  const layoutNodes = raw.nodes.map((n) => ({
    id: n.id,
    parentId: treeEdgeByTarget.get(n.id)?.source ?? null,
    ref: n,
    self: false,
  }));
  for (const n of raw.nodes) {
    if (n.kind === "model" && hasChildren.has(n.id)) {
      layoutNodes.push({ id: n.id + SELF_SUFFIX, parentId: n.id, ref: n, self: true });
    }
  }

  const root = d3
    .stratify()
    .id((d) => d.id)
    .parentId((d) => d.parentId)(layoutNodes);

  // Ordine dei fratelli: prima la foglia "self" (il modello viene prima dei
  // suoi discendenti), poi per data di rilascio, poi per nome. E' l'ordine di
  // partenza dell'euristica del baricentro, subito sotto.
  root.sort((a, b) => {
    if (a.data.self !== b.data.self) return a.data.self ? -1 : 1;
    const da = a.data.ref.release_date || "9999";
    const db = b.data.ref.release_date || "9999";
    if (da !== db) return da < db ? -1 : 1;
    return d3.ascending(a.data.ref.label, b.data.ref.label);
  });

  // Riordino dei fratelli per ridurre gli incroci delle reticolazioni
  // (baricentro, vedi order.js). Le statistiche vanno in console come info
  // (non e' un avviso) e nel diario.
  const t0 = performance.now();
  const crossingInfo = reduceCrossings(root, reticulations);
  const ms = performance.now() - t0;
  if (reticulations.length) {
    const { before: b, after: a } = crossingInfo;
    const m = crossingInfo.afterBarycenter;
    console.info(`Reticolazioni: ${a.arcs} archi; incroci ${b.crossings} → ${m.crossings} (baricentro) → ${a.crossings} (sifting); lunghezza verticale ${b.length} → ${m.length} → ${a.length} righe; ${crossingInfo.sweeps} giri di sifting, ${ms.toFixed(1)} ms`);
  }

  const leaves = root.leaves();

  // ---------- Palette delle organizzazioni ----------
  // Le organizzazioni sono piu' delle 7 tinte. Criterio (proposto da Liotta,
  // diario 11:2x): la tinta porta informazione NON ridondante solo dove
  // l'organizzazione di un modello e' diversa da quella del genitore sotto cui
  // sta (derivazioni tra famiglie, es. un distillato di un'org appeso al base
  // di un'altra). Altrove l'org si legge gia' dalla posizione (il clade) e dalla
  // colonna di testo. Quindi le tinte vanno, in quest'ordine:
  //   0. alle org "ospiti": hanno modelli derivati da un'altra org;
  //   1. alle org "ospitanti": i loro modelli/cladi fanno da genitore a un'altra org;
  //   2. alle altre; a parita' di livello, per numero di modelli, poi per nome.
  const models = raw.nodes.filter((n) => n.kind === "model");
  const counts = d3.rollup(models, (v) => v.length, (n) => n.organization ?? null);

  const childrenOf = d3.group(treeEdges, (e) => e.source);
  const subtreeOrgs = new Map(); // id → Map(org → numero di modelli nel sottoalbero)
  const collect = (id) => {
    if (subtreeOrgs.has(id)) return subtreeOrgs.get(id);
    const m = new Map();
    const n = byId.get(id);
    if (n.kind === "model" && n.organization) m.set(n.organization, 1);
    for (const e of childrenOf.get(id) ?? []) {
      for (const [org, c] of collect(e.target)) m.set(org, (m.get(org) ?? 0) + c);
    }
    subtreeOrgs.set(id, m);
    return m;
  };
  // Org "di casa" di un genitore: la sua, se e' un modello; per un clade,
  // l'org che ha piu' della meta' dei modelli del sottoalbero (altrimenti
  // nessuna: un clade misto, come la radice, non ospita nessuno).
  const homeOrg = (id) => {
    const n = byId.get(id);
    if (n.kind === "model") return n.organization ?? null;
    const m = collect(id);
    const total = d3.sum(m.values());
    for (const [org, c] of m) if (c > total / 2) return org;
    return null;
  };
  const role = new Map(); // org → 0 ospite, 1 ospitante
  const mark = (org, r) => { if (org) role.set(org, Math.min(role.get(org) ?? 2, r)); };
  const crossEdges = [];
  for (const e of raw.edges) {
    const child = byId.get(e.target);
    if (!child || child.kind !== "model" || !child.organization) continue;
    const host = homeOrg(e.source);
    if (host && host !== child.organization) {
      mark(child.organization, 0);
      mark(host, 1);
      crossEdges.push(e);
    }
  }

  const named = [...counts].filter(([org]) => org !== null);
  named.sort((a, b) => d3.ascending(role.get(a[0]) ?? 2, role.get(b[0]) ?? 2)
    || d3.descending(a[1], b[1])
    || a[0].localeCompare(b[0], "it", { numeric: true }));
  const colored = named.slice(0, OKABE_ITO.length);
  const others = named.slice(OKABE_ITO.length);
  const colorOf = new Map(colored.map(([org], i) => [org, OKABE_ITO[i].hex]));
  const roleName = (org) => ["ospite", "ospitante", null][role.get(org) ?? 2];
  const orgs = colored.map(([org, count], i) => ({
    org, count, color: OKABE_ITO[i].hex, hueName: OKABE_ITO[i].name, role: roleName(org),
  }));
  const otherCount = d3.sum(others, (d) => d[1]) + (counts.get(null) || 0);
  if (otherCount > 0) {
    orgs.push({
      org: OTHER_LABEL,
      count: otherCount,
      color: OTHER_COLOR,
      members: others.map(([o]) => o).concat(counts.has(null) ? ["n.d."] : []),
      // true se nessuna org nel grigio ha derivazioni tra famiglie: allora il
      // grigio non nasconde informazione (la legenda lo dice).
      allInOwnClade: others.every(([o]) => !role.has(o)),
      isOther: true,
    });
  }
  const orgColor = (org) => colorOf.get(org) ?? OTHER_COLOR;

  // Controllo della regola (richiesto da Liotta): il grigio e' giustificato
  // solo per org i cui modelli stanno tutti nel proprio clade. Se un'org con
  // un modello derivato da un'altra famiglia ("ospite") finisce nel grigio,
  // la tinta nasconderebbe proprio l'informazione del task 8: lo segnalo.
  // (web/tools/screenshot.py tratta gli avvisi come errori: exit 1.)
  const greyGuests = others.map(([o]) => o).filter((o) => role.get(o) === 0);
  if (greyGuests.length) {
    console.warn(`Palette: organizzazioni con modelli derivati da un'altra famiglia finite nel grigio (servono piu' di ${OKABE_ITO.length} tinte): ${greyGuests.join(", ")}`);
  }

  return { raw, byId, sourceById, treeEdgeByTarget, reticulations, root, leaves, orgs, orgColor, crossEdges, crossingInfo };
}
