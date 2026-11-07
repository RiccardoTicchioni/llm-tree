// Formati numerici in italiano: virgola decimale, spazio fine per le migliaia.

/* global d3 */

const it = d3.formatLocale({ decimal: ",", thousands: " ", grouping: [3], currency: ["$", ""] });

/** Numero con al massimo `digits` decimali (gli zeri finali si tolgono). */
export const num = (v, digits = 1) => it.format(`,.${digits}~f`)(v);
/** GiB: un decimale sotto 100, interi sopra (483 e non 483,1). */
export const gib = (v) => (v >= 100 ? it.format(",.0f")(v) : it.format(",.1f")(v));
/** Prezzo in dollari con due decimali fissi. */
export const usd = (v) => it.format("$,.2f")(v);
