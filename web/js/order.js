// Ordine dei fratelli per ridurre gli incroci delle reticolazioni (fase 4).
// Ruotare i figli di un nodo non cambia la topologia dell'albero, quindi
// l'ordine verticale delle righe e' un grado di liberta' che si puo' spendere
// per la leggibilita' delle reticolazioni.
//
// Le reticolazioni si disegnano tutte dallo stesso lato delle foglie (a
// sinistra, come archi di un arc diagram). Con le righe numerate, due archi
// (a, b) e (c, d), con a < b e c < d, si incrociano se e solo se
// a < c < b < d oppure c < a < d < b (intervalli che si intrecciano).
//
// Metodo: euristica del baricentro (Sugiyama, Tagawa, Toda 1981) adattata
// all'albero: per ogni nodo interno ordino i figli per la riga media dei
// "partner" delle reticolazioni che escono dal loro sottoalbero. Tengo la
// migliore soluzione vista secondo (incroci, lunghezza verticale totale):
// il risultato non e' mai peggiore dell'ordine di partenza.

/** Riga (indice di foglia) di ogni modello: la sua foglia, o la foglia "self". */
function rowIndex(root) {
  const rows = new Map();
  root.leaves().forEach((leaf, i) => {
    rows.set(leaf.data.ref.id, i); // per i sampled ancestor la foglia self ha lo stesso ref.id
  });
  return rows;
}

/** Estremi (righe) delle reticolazioni, ignorando quelle con un estremo assente. */
function arcs(root, reticulations) {
  const rows = rowIndex(root);
  const out = [];
  for (const e of reticulations) {
    const a = rows.get(e.source);
    const b = rows.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    out.push(a < b ? [a, b] : [b, a]);
  }
  return out;
}

/** Numero di incroci tra reticolazioni e somma delle lunghezze in righe. */
export function crossingStats(root, reticulations) {
  const A = arcs(root, reticulations);
  let crossings = 0;
  for (let i = 0; i < A.length; i++) {
    for (let j = i + 1; j < A.length; j++) {
      const [a, b] = A[i];
      const [c, d] = A[j];
      if ((a < c && c < b && b < d) || (c < a && a < d && d < b)) crossings++;
    }
  }
  const length = A.reduce((s, [a, b]) => s + (b - a), 0);
  return { crossings, length, arcs: A.length };
}

const better = (x, y) => x.crossings < y.crossings || (x.crossings === y.crossings && x.length < y.length);

function snapshot(root) {
  const m = new Map();
  root.each((d) => { if (d.children) m.set(d, d.children.slice()); });
  return m;
}
function restore(snap) {
  for (const [d, ch] of snap) d.children = ch.slice();
}

/**
 * Riordina in place i figli dei nodi di `root`.
 * La foglia "self" (sampled ancestor) resta sempre la prima tra i fratelli.
 * @returns {{ before, after, passes }} statistiche prima e dopo
 */
export function reduceCrossings(root, reticulations, passes = 3) {
  const before = crossingStats(root, reticulations);
  if (!reticulations.length) return { before, after: before, passes: 0 };

  // Per ogni modello, i partner delle sue reticolazioni.
  const partners = new Map();
  const add = (k, v) => { if (!partners.has(k)) partners.set(k, []); partners.get(k).push(v); };
  for (const e of reticulations) { add(e.source, e.target); add(e.target, e.source); }

  let best = before;
  let bestSnap = snapshot(root);
  for (let p = 0; p < passes; p++) {
    const rows = rowIndex(root);
    // Insieme dei modelli di ogni sottoalbero (per sapere se un partner e' "fuori").
    const inside = new Map();
    root.eachAfter((d) => {
      const s = new Set();
      if (!d.data.self) s.add(d.data.ref.id);
      for (const c of d.children ?? []) for (const id of inside.get(c)) s.add(id);
      inside.set(d, s);
    });
    root.each((d) => {
      if (!d.children || d.children.length < 2) return;
      const key = new Map();
      for (const c of d.children) {
        const ids = inside.get(c);
        const ext = [];
        for (const id of ids) for (const q of partners.get(id) ?? []) if (!ids.has(q) && rows.has(q)) ext.push(rows.get(q));
        if (ext.length) {
          key.set(c, ext.reduce((s, v) => s + v, 0) / ext.length);
        } else {
          // Nessuna reticolazione: il figlio resta dov'e' (riga media attuale).
          const leaves = c.leaves();
          key.set(c, leaves.reduce((s, l) => s + rows.get(l.data.ref.id), 0) / leaves.length);
        }
      }
      const self = d.children.filter((c) => c.data.self);
      const rest = d.children.filter((c) => !c.data.self);
      // sort stabile: a parita' di chiave resta l'ordine precedente (data, nome)
      rest.sort((a, b) => key.get(a) - key.get(b));
      d.children = self.concat(rest);
    });
    const s = crossingStats(root, reticulations);
    if (better(s, best)) { best = s; bestSnap = snapshot(root); }
  }
  restore(bestSnap);
  const afterBarycenter = best;

  // Rifinitura: "sifting" (Matuszewski, Schoenfeld, Molitor 1999), cioe'
  // ogni figlio si prova in ogni posizione tra i fratelli e si tiene la
  // migliore. Il baricentro da solo non basta: con gli archi tutti dallo
  // stesso lato, la media dei partner non e' l'obiettivo che conto (gli
  // intrecci). Con ~60 righe e figli per nodo <= 10 costa poco:
  // O(passate * sum(k^2) * (n + r^2)).
  // Regola (indicazione di Liotta, 16:40): si spostano SOLO i figli il cui
  // sottoalbero contiene un estremo di reticolazione. I fratelli non coinvolti
  // non si muovono mai, quindi restano tra loro nell'ordine di partenza (data,
  // poi nome): l'ordine temporale si perde solo dove serve.
  const endpoints = new Set();
  for (const e of reticulations) { endpoints.add(e.source); endpoints.add(e.target); }
  const involved = (c) => c.leaves().some((l) => endpoints.has(l.data.ref.id))
    || c.descendants().some((x) => !x.data.self && endpoints.has(x.data.ref.id));

  let improved = true;
  let sweeps = 0;
  while (improved && sweeps < 5) {
    improved = false;
    sweeps++;
    root.each((d) => {
      if (!d.children || d.children.length < 2) return;
      const self = d.children.filter((c) => c.data.self);
      for (const c of d.children.filter((x) => !x.data.self && involved(x))) {
        const rest = d.children.filter((x) => !x.data.self && x !== c);
        let bestPos = -1;
        for (let i = 0; i <= rest.length; i++) {
          d.children = self.concat(rest.slice(0, i), [c], rest.slice(i));
          const st = crossingStats(root, reticulations);
          if (better(st, best)) { best = st; bestPos = i; improved = true; }
        }
        const i = bestPos >= 0 ? bestPos : null;
        if (i !== null) d.children = self.concat(rest.slice(0, i), [c], rest.slice(i));
        else restore(bestSnap); // nessun miglioramento: torna all'ordine migliore
        bestSnap = snapshot(root);
      }
    });
  }
  return { before, afterBarycenter, after: crossingStats(root, reticulations), passes, sweeps };
}

