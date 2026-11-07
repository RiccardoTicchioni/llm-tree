// Cladogramma rettangolare (fase 3 encoding, fase 4 layout).
// d3.cluster con nodeSize: una riga fissa per foglia, foglie tutte alla stessa x.

/* global d3 */

export const ROW = 16; // altezza di riga (px): testo 12 px + respiro
export const LEAF_R = 4.5;
export const INNER_R = 3.5;
export const CLADE_SIZE = 9; // era 7: dentro ci sta il segno − o + del comprimi/espandi (M2-d)
export const LABEL_GAP = 9;

export const CLADE_LABEL_CAP = 150; // tetto (px) dell'etichetta di un clade sul ramo
export const CLADE_LABEL_MIN = 48;  // sotto questo il tetto non scende mai
export const TREE_BUDGET = 600;     // larghezza massima desiderata dell'albero (px, senza etichette delle foglie). Era 560: vedi diario M1-f
export const LABEL_PAD = 12;        // spazio tra etichetta e nodo/ramo
export const MIN_LEVEL_W = 26;      // livelli senza cladi (solo modelli): rami corti

/**
 * Calcola il layout. Non disegna nulla.
 * Coordinate di schermo: x = profondita' (radice a sinistra), y = riga.
 * `measure(text)` restituisce la larghezza in px di un'etichetta di clade.
 */
export function layoutTree(model, { measure, budget = TREE_BUDGET, fixed = null }) {
  const { root } = model;
  d3.cluster().nodeSize([ROW, 1]).separation(() => 1)(root);
  // Comprimi/espandi (M2): le x dei livelli si calcolano una volta sola,
  // sull'albero intero ("fixed"), cosi' le colonne non si spostano in
  // orizzontale quando si comprime un clade. Cambiano solo le righe.
  if (fixed) {
    placeNodes(root, fixed.levelX, fixed.leafX);
    return { ...fixed, rowsHeight: root.leaves().length * ROW };
  }
  const H = Math.max(1, root.height);

  // d3.cluster lavora in verticale (x = ampiezza, y = profondita'). Dalla x
  // di cluster prendo l'ordine delle righe (foglie consecutive, genitore al
  // centro dei figli). Per la profondita' invece:
  // - i nodi interni stanno alla x del loro LIVELLO (depth), non all'altezza
  //   come fa cluster di default: i cladi dello stesso livello sono in colonna;
  // - le foglie stanno tutte all'ultima x (allineate per le colonne);
  // - ogni livello e' largo quanto la piu' lunga etichetta di clade che deve
  //   stare sul suo ramo entrante (con un tetto), oppure MIN_LEVEL_W se a quel
  //   livello non ci sono cladi. Cosi' le etichette non si troncano (salvo
  //   oltre il tetto) e i livelli di soli modelli non sprecano spazio.
  const need = new Array(H + 1).fill(0);
  root.each((d) => {
    if (d.data.ref.kind === "clade") need[d.depth] = Math.max(need[d.depth], measure(d.data.ref.label));
  });
  // Il "gambo" della radice (root edge, convenzione dei filogrammi) e' il ramo
  // entrante della radice: la sua etichetta va li', come per ogni clade.
  // Se con il tetto pieno l'albero supera il budget (molti livelli di cladi
  // con etichette lunghe), abbasso il tetto finche' ci sta, ma non sotto
  // CLADE_LABEL_MIN: oltre, meglio scorrere che leggere "Gen…".
  const widths = (cap) => need.map((w) => (w > 0 ? Math.min(w, cap) + LABEL_PAD : MIN_LEVEL_W));
  let cap = CLADE_LABEL_CAP;
  while (cap > CLADE_LABEL_MIN && d3.sum(widths(cap)) > budget) cap -= 2;
  const levelW = widths(cap);
  const levelX = [];
  levelW.reduce((acc, w, d) => { levelX[d] = acc + w; return acc + w; }, 0);
  const stem = levelX[0];
  const leafX = levelX[H];

  placeNodes(root, levelX, leafX);
  const rowsHeight = root.leaves().length * ROW;
  return { leafX, rowsHeight, stem, levelX, levelW, labelCap: cap };
}

/** Un clade compresso: ha i figli nascosti in _children. */
export const isCollapsed = (d) => !d.children && Array.isArray(d._children);

function placeNodes(root, levelX, leafX) {
  let minBreadth = Infinity;
  root.each((d) => { minBreadth = Math.min(minBreadth, d.x); });
  root.each((d) => {
    d.sx = d.children ? levelX[d.depth] : leafX;
    // Clade compresso: e' una foglia del layout (la sua riga sta a leafX),
    // ma il suo quadrato e la punta del triangolo stanno al suo livello (cx).
    d.cx = isCollapsed(d) ? levelX[d.depth] : d.sx;
    d.sy = d.x - minBreadth; // ampiezza → y di schermo, da 0
  });
}

function linkPath(d) {
  // gomito: verticale sulla x del genitore, poi orizzontale fino al figlio
  return `M${d.source.sx},${d.source.sy}V${d.target.sy}H${d.target.cx ?? d.target.sx}`;
}

function linkKind(model, d) {
  if (d.target.data.self) return "self";
  const e = model.treeEdgeByTarget.get(d.target.id);
  return e && e.certainty === "inferred" ? "inferred" : "documented";
}

/**
 * Disegna archi, nodi ed etichette dentro `g`.
 * Restituisce la x dove finiscono le etichette piu' lunghe (per le colonne).
 */
export function drawTree(g, model, layout) {
  const { root } = model;
  const links = root.links();

  const linkG = g.append("g").attr("class", "tree-links");
  linkG.append("path")
    .attr("class", "link link-stem")
    .attr("d", `M0,${root.sy}H${root.sx}`);
  const linkSel = linkG.selectAll("path.link-tree")
    .data(links)
    .join("path")
    .attr("class", (d) => `link link-tree link-${linkKind(model, d)}`)
    .attr("d", linkPath);
  // Bersagli larghi e trasparenti per il mouse: un arco di 1,4 px e' troppo
  // sottile da puntare.
  const linkHits = linkG.selectAll("path.link-hit")
    .data(links)
    .join("path")
    .attr("class", "link-hit")
    .attr("d", linkPath);

  // Clade compresso: triangolo dalla punta (il nodo del clade) alla x delle
  // foglie, alto una riga (convenzione dei cladi collassati: iTOL, FigTree).
  // Sta SOTTO le reticolazioni: altrimenti le coprirebbe.
  g.append("g").attr("class", "collapsed-wedges")
    .selectAll("path")
    .data(root.leaves().filter(isCollapsed))
    .join("path")
    .attr("class", "collapsed-wedge")
    .attr("transform", (d) => `translate(${d.cx},${d.sy})`)
    .attr("d", (d) => `M0,0L${layout.leafX - d.cx},${-(ROW / 2 - 2)}V${ROW / 2 - 2}Z`);

  // Reticolazioni (M2): sopra gli archi dell'albero, sotto i nodi.
  const ret = drawReticulations(g, model, layout);

  const nodes = root.descendants();
  const nodeG = g.append("g")
    .attr("class", "tree-nodes")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", (d) => {
      const k = d.data.ref.kind;
      const pos = d.children ? "inner" : "leaf";
      // I nodi NON sono "dimmable": la tinta codifica l'organizzazione e
      // un'opacita' ridotta la cambierebbe (blu attenuato ≈ celeste).
      return `node node-${k} node-${pos}` + (d.data.self ? " node-self" : "");
    })
    .attr("transform", (d) => `translate(${d.cx ?? d.sx},${d.sy})`);

  // Clade: quadrato grigio (forma ≠ cerchio: kind e' categorico a 2 livelli).
  // Dentro, "−" (aperto) o "+" (compresso): il click comprime o espande.
  const cladeG = nodeG.filter((d) => d.data.ref.kind === "clade").classed("clade-toggle", true);
  cladeG.append("rect")
    .attr("class", "clade-mark")
    .attr("x", -CLADE_SIZE / 2)
    .attr("y", -CLADE_SIZE / 2)
    .attr("width", CLADE_SIZE)
    .attr("height", CLADE_SIZE);
  cladeG.append("path")
    .attr("class", "clade-glyph")
    .attr("d", (d) => (isCollapsed(d) ? "M-2.5,0H2.5M0,-2.5V2.5" : "M-2.5,0H2.5"));

  // Modello: cerchio con la tinta dell'organizzazione.
  // Pesi open = cerchio pieno; chiuso = anello (cerchio con il centro bianco).
  const models = nodeG.filter((d) => d.data.ref.kind === "model");
  // Alone per il risultato della ricerca (Locate): visibile solo con .found.
  models.append("circle").attr("class", "found-halo").attr("r", 9);
  models.append("circle")
    .attr("class", "model-mark")
    .attr("r", (d) => (d.children ? INNER_R : LEAF_R))
    .attr("fill", (d) => model.orgColor(d.data.ref.organization));
  models.filter((d) => d.data.ref.weights === "closed")
    .append("circle")
    .attr("class", "closed-hole")
    .attr("r", (d) => (d.children ? INNER_R : LEAF_R) * 0.45);

  // Etichette delle foglie: una riga ciascuna, niente sovrapposizioni.
  const leafLabels = g.append("g")
    .attr("class", "leaf-labels")
    .selectAll("text")
    .data(root.leaves())
    .join("text")
    .attr("class", (d) => (isCollapsed(d) ? "leaf-label collapsed-label" : "leaf-label dimmable"))
    .attr("x", (d) => d.sx + LABEL_GAP)
    .attr("y", (d) => d.sy)
    .attr("dy", "0.32em")
    .text((d) => (isCollapsed(d) ? `${d.data.ref.label} · ${modelsIn(d).length} modelli` : d.data.ref.label));

  // Fine delle etichette: misurate in grassetto, perche' il risultato della
  // ricerca e' in grassetto e non deve invadere la colonna successiva.
  let labelEnd = layout.leafX + LABEL_GAP;
  if (layout.labelEnd !== undefined) {
    // Albero con cladi compressi: la fine delle etichette e' quella
    // dell'albero intero (le colonne restano ferme); un'etichetta di clade
    // compresso piu' lunga si tronca (nome intero nel <title>).
    labelEnd = layout.labelEnd;
    leafLabels.filter(isCollapsed).style("font-weight", 700).each(function (d) {
      fitText(this, this.textContent, labelEnd - d.sx - LABEL_GAP);
    }).style("font-weight", null);
  } else {
    leafLabels.style("font-weight", 700).each(function (d) {
      labelEnd = Math.max(labelEnd, d.sx + LABEL_GAP + this.getComputedTextLength());
    }).style("font-weight", null);
  }

  // Etichette dei clade: sopra il ramo entrante (per la radice: il gambo).
  // Il livello e' gia' largo quanto l'etichetta piu' lunga (fino al tetto),
  // quindi si tronca solo oltre il tetto. Se dopo il troncamento due etichette
  // diverse risultano uguali, si accorciano dal centro ("Clade…MoE"), che
  // conserva il suffisso: nelle generazioni ("Llama 3.1" / "Llama 3.3") la
  // parte che distingue e' quasi sempre in fondo. Nome intero nel <title>.
  const clades = nodes.filter((d) => d.data.ref.kind === "clade");
  const cladeLabels = g.append("g")
    .attr("class", "clade-labels")
    .selectAll("text")
    .data(clades)
    .join("text")
    .attr("class", "clade-label")
    .attr("x", (d) => d.cx - 6)
    .attr("y", (d) => d.sy - 5)
    .attr("text-anchor", "end");
  const maxW = (d) => (d.parent ? d.cx - d.parent.sx : layout.stem) - 10;
  cladeLabels.each(function (d) { fitText(this, d.data.ref.label, maxW(d)); });
  const shown = d3.group(cladeLabels.nodes(), (el) => el.firstChild.nodeValue);
  for (const [, els] of shown) {
    const full = new Set(els.map((el) => d3.select(el).datum().data.ref.label));
    if (els.length < 2 || full.size < 2) continue; // uguali solo se lo sono davvero
    for (const el of els) {
      const d = d3.select(el).datum();
      fitText(el, d.data.ref.label, maxW(d), "middle");
    }
  }

  return { labelEnd, nodeSel: nodeG, leafLabelSel: leafLabels, linkSel, linkHitSel: linkHits, retSel: ret.paths, retHitSel: ret.hits, cladeLabelSel: cladeLabels };
}

/**
 * Tronca il testo con "…" per stare in maxWidth px (mode "end" = toglie la
 * fine, "middle" = toglie il centro). Il nome intero va in un <title>.
 */
export function fitText(el, full, maxWidth, mode = "end") {
  el.textContent = full;
  if (el.getComputedTextLength() <= maxWidth) return;
  const cut = (k) => (mode === "middle"
    ? full.slice(0, Math.ceil(k / 2)) + "…" + full.slice(full.length - Math.floor(k / 2))
    : full.slice(0, k) + "…");
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    el.textContent = cut(mid);
    if (el.getComputedTextLength() <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  el.textContent = lo > 0 ? cut(lo) : "";
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = full;
  el.appendChild(title);
}

/** Riga (foglia) di un modello: la sua foglia, o la foglia "self" se ha figli. */
export function leafOfModel(model) {
  // Riga visibile di ogni modello: la sua foglia, oppure la riga del clade
  // compresso che lo contiene.
  const m = new Map();
  const walk = (x, hidden) => {
    const vis = hidden ?? (isCollapsed(x) ? x : null);
    if (x.data.ref.kind === "model" && !m.has(x.data.ref.id)) {
      if (vis) m.set(x.data.ref.id, vis);
    }
    for (const c of x.children ?? x._children ?? []) walk(c, vis);
  };
  walk(model.root, null);
  for (const leaf of model.root.leaves()) if (!isCollapsed(leaf)) m.set(leaf.data.ref.id, leaf);
  return m;
}

/**
 * Reticolazioni come curve di Bezier cubiche a SINISTRA delle foglie (arc
 * diagram): entrambi gli estremi stanno alla x delle foglie, i punti di
 * controllo rientrano nell'area dell'albero di b = clamp(0,35 * dy, 24,
 * 0,6 * larghezza albero). A destra coprirebbero le colonne.
 * Nero (ottavo colore Okabe-Ito, riservato dal CP2), freccia sul figlio,
 * continua = documented, tratteggio 5 3 = inferred (come gli archi tree).
 */
export function drawReticulations(g, model, layout) {
  const leafOf = leafOfModel(model);
  const data = model.reticulations
    .map((e) => ({ edge: e, source: leafOf.get(e.source), target: leafOf.get(e.target), reticulation: true }))
    // Se entrambi gli estremi stanno nello stesso clade compresso, l'arco e'
    // interno e non si disegna (il tooltip del clade lo conta).
    .filter((d) => d.source && d.target && d.source !== d.target);

  const defs = g.append("defs");
  defs.append("marker")
    .attr("id", "ret-arrow")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 9).attr("refY", 5)
    .attr("markerWidth", 7).attr("markerHeight", 7)
    .attr("markerUnits", "userSpaceOnUse")
    .attr("orient", "auto")
    .append("path").attr("class", "ret-arrow").attr("d", "M0,0L10,5L0,10z");
  // Stessa freccia in grigio chiaro, per le reticolazioni fuori dal cammino
  // evidenziato (M2-d).
  defs.append("marker")
    .attr("id", "ret-arrow-off")
    .attr("viewBox", "0 0 10 10")
    .attr("refX", 9).attr("refY", 5)
    .attr("markerWidth", 7).attr("markerHeight", 7)
    .attr("markerUnits", "userSpaceOnUse")
    .attr("orient", "auto")
    .append("path").attr("class", "ret-arrow ret-arrow-off").attr("d", "M0,0L10,5L0,10z");

  const maxBend = 0.6 * layout.leafX;
  const path = (d) => {
    const x = layout.leafX - LEAF_R - 1.5; // si ferma sul bordo del cerchio
    const y1 = d.source.sy;
    const y2 = d.target.sy;
    const b = Math.max(24, Math.min(0.35 * Math.abs(y2 - y1), maxBend));
    return `M${x},${y1}C${x - b},${y1} ${x - b},${y2} ${x},${y2}`;
  };
  const rg = g.append("g").attr("class", "reticulations");
  const paths = rg.selectAll("path.ret")
    .data(data)
    .join("path")
    .attr("class", (d) => `ret ret-${d.edge.certainty === "inferred" ? "inferred" : "documented"}`)
    .attr("d", path)
    .attr("marker-end", "url(#ret-arrow)");
  const hits = rg.selectAll("path.ret-hit")
    .data(data)
    .join("path")
    .attr("class", "link-hit ret-hit")
    .attr("d", path);
  return { paths, hits, data };
}

/**
 * Evidenzia il cammino dalla foglia `leaf` alla radice (task 4) e le
 * reticolazioni che entrano nel suo modello. leaf = null toglie l'evidenza.
 * Gli archi fuori dal cammino diventano grigio chiaro: gli archi non hanno
 * tinta, quindi abbassarne il contrasto non altera nessun attributo; il
 * tratteggio (certezza) resta su tutti.
 */
export function highlightPath(tree, leaf) {
  const g = d3.select(tree.linkSel.node()?.parentNode?.parentNode);
  if (!leaf) {
    tree.linkSel.classed("on-path", false).classed("off-path", false);
    tree.retSel.classed("on-path", false).classed("off-path", false).attr("marker-end", "url(#ret-arrow)");
    tree.cladeLabelSel.classed("on-path", false);
    g.select(".link-stem").classed("on-path", false).classed("off-path", false);
    return;
  }
  const anc = new Set(leaf.ancestors());
  const modelId = leaf.data.ref.id;
  tree.linkSel.classed("on-path", (d) => anc.has(d.target)).classed("off-path", (d) => !anc.has(d.target));
  const inRet = (d) => d.edge.target === modelId;
  tree.retSel.classed("on-path", inRet).classed("off-path", (d) => !inRet(d))
    .attr("marker-end", (d) => (inRet(d) ? "url(#ret-arrow)" : "url(#ret-arrow-off)"));
  tree.cladeLabelSel.classed("on-path", (d) => anc.has(d));
  g.select(".link-stem").classed("on-path", true).classed("off-path", false);
}

/** Modelli (unici) nel sottoalbero di d, anche se compresso. */
export function modelsIn(d) {
  const out = new Map();
  const walk = (x) => {
    if (x.data.ref.kind === "model") out.set(x.data.ref.id, x.data.ref);
    for (const c of x.children ?? x._children ?? []) walk(c);
  };
  walk(d);
  return [...out.values()];
}
