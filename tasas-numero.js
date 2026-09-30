/* ============================================================================
 * tasas-numero.js — parseo y formato de números del banco (sin dependencias)
 * ----------------------------------------------------------------------------
 * Se separó de server.js para poder probarlo localmente con `node test-tasas.js`
 * sin arrancar el servidor ni tocar el banco.
 *
 * Regla (formato venezolano / es-VE):
 *   · Con coma Y punto  → el separador que aparece MÁS A LA DERECHA es el decimal.
 *   · Sólo coma         → la coma es decimal ......... "847,44420" → 847.4442
 *   · Sólo punto        → es decimal, SALVO que separe grupos de exactamente
 *                         3 dígitos con 1-3 dígitos delante (miles): "8.000" → 8000
 *                         "847.44420" → 847.4442 · "8000.00" → 8000
 * ========================================================================== */
'use strict';

// Parsea un número tal como lo entrega el banco. Devuelve null si no es válido.
function parseNumeroBanco(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/\s/g, '');
  if (!s) return null;
  const tieneComa = s.includes(','), tienePunto = s.includes('.');
  if (tieneComa && tienePunto) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (tieneComa) {
    s = s.replace(',', '.');                                  // coma = decimal
  } else if (tienePunto) {
    const partes = s.split('.');
    const soloMiles = partes.length > 1 && partes.slice(1).every(p => p.length === 3);
    if (soloMiles && partes[0].length >= 1 && partes[0].length <= 3) s = partes.join(''); // miles
    // si no, el punto es decimal ("847.44420", "8000.00")
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Formatea un número al estilo del banco (coma decimal). Devuelve null si no es válido.
function fmtNumeroBanco(n, dec = 5) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Number(n).toFixed(dec).replace('.', ',');
}

module.exports = { parseNumeroBanco, fmtNumeroBanco };
