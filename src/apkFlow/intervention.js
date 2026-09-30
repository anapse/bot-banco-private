/* ============================================================================
 * INTERVENCION — consultas del flujo de intervencion cambiaria de la APK
 * ----------------------------------------------------------------------------
 *   /bdvx-intervencion-cambiaria/v1/intervencion/init
 *   /bdvx-intervencion-cambiaria/v1/intervencion/consultarReglasEXRI
 *   /bdvx-menudeo-v2/v1/mercado
 *
 * El parser usa las claves REALES extraidas del binario:
 *   codigoRegla, descripcionRegla, codigoOperacion, codigoDivisa, montoMinimo,
 *   montoMaximo, tasaCompra, tasaVenta, tipoServicio, multiplo,
 *   cupoPersNaturales, cupoPersJuridicos, porcentajeComision1/2/3,
 *   importeComision1/2/3, jornadaDivisa, jornadaMonto
 * ========================================================================== */
'use strict';
const CLIENT = require('./client');
const LOG = require('./logging');
const { RUTAS } = require('./rutas');

// claves de tasa de INTERVENCION (del binario). NO se mezclan con las de menudeo.
const CLAVES_TASA = ['tasaReferencia', 'tasaCambioVenta', 'tasaCambioCompra',
                     'tasaVenta', 'tasaCompra', 'tasaPonderada'];

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  // formato banco: "860,94096" o "1.234,56"
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : null;
}

/** init de intervencion */
async function init() {
  return CLIENT.pedir(RUTAS.intervencionInit, {
    fase: 'INTERVENCION_INIT', metodo: 'POST', body: {},
  });
}

/** reglas EXRI + parser con las claves reales de la APK */
async function reglasEXRI() {
  const r = await CLIENT.pedir(RUTAS.consultarReglasEXRI, {
    fase: 'EXRI', metodo: 'POST', body: {},
  });

  const out = {
    http: r.http, ok: r.ok, raw: r.json,
    code: null, data: null, dataEsNull: true,
    regla: null, descripcion: null,
    tasaTexto: null, tasa: null, tasaCampo: null,
    cupoPersNaturales: null, cupoPersJuridicos: null,
    porcentajeComision: null, montoMinimo: null, montoMaximo: null,
    items: 0, error: r.error || null,
  };

  const j = r.json;
  if (j) {
    const items = Array.isArray(j) ? j : [j];
    out.items = items.length;
    for (const it of items) {
      const srcs = [it, it.data, it.data && it.data.data].filter((x) => x && typeof x === 'object');
      for (const s of srcs) {
        if (out.code == null && (s.code ?? s.codigo) != null) out.code = String(s.code ?? s.codigo);
        if (out.regla == null && (s.regla || s.codigoRegla)) out.regla = String(s.regla || s.codigoRegla);
        if (out.descripcion == null && (s.description || s.descripcion || s.message)) {
          out.descripcion = String(s.description || s.descripcion || s.message);
        }
        if (out.tasaTexto == null) {
          for (const k of CLAVES_TASA) {
            if (s[k] != null) { out.tasaTexto = String(s[k]); out.tasaCampo = k; break; }
          }
        }
        if (out.cupoPersNaturales == null && s.cupoPersNaturales != null) out.cupoPersNaturales = s.cupoPersNaturales;
        if (out.cupoPersJuridicos == null && s.cupoPersJuridicos != null) out.cupoPersJuridicos = s.cupoPersJuridicos;
        if (out.porcentajeComision == null) {
          out.porcentajeComision = s.porcentajeComision1 ?? s.porcentajeComision ?? null;
        }
        if (out.montoMinimo == null && s.montoMinimo != null) out.montoMinimo = s.montoMinimo;
        if (out.montoMaximo == null && s.montoMaximo != null) out.montoMaximo = s.montoMaximo;
        if (s.data !== undefined) out.data = s.data;
      }
    }
    const it0 = items[0] || {};
    out.dataEsNull = it0.data === null || it0.data === undefined;
    out.tasa = num(out.tasaTexto);
  }

  // --- interpretacion (mismas reglas verificadas del proyecto) ---
  const code01 = out.code === '01';
  const desc = String(out.descripcion || '').toLowerCase();
  const cerrar = /no disponible|intente m[aá]s tarde|no se encuentra/.test(desc);
  const abrir = out.code === '00' || out.code === '1000';   // 1000 = exito del APK

  if (code01 || cerrar) { out.estado = 'cerrada'; out.abierta = false; }
  else if (abrir) { out.estado = 'abierta'; out.abierta = true; }
  else if (out.tasa > 0) { out.estado = 'abierta'; out.abierta = true; }
  else { out.estado = 'desconocido'; out.abierta = false; }

  return out;
}

/** mercado menudeo (referencia; NO es la tasa EXRI) */
async function mercado() {
  const r = await CLIENT.pedir(RUTAS.mercado, {
    fase: 'MERCADO', metodo: 'GET',
  });
  const d = (r.json && (r.json.data || r.json)) || {};
  return {
    http: r.http, ok: r.ok, raw: r.json, error: r.error || null,
    estadoPolitica: d.estadoPolitica ?? null,
    ventaUSDTexto: d.tasaCambioVentaDolar ?? null,
    compraUSDTexto: d.tasaCambioCompraDolar ?? null,
    ventaUSD: num(d.tasaCambioVentaDolar),
    compraUSD: num(d.tasaCambioCompraDolar),
  };
}

module.exports = { init, reglasEXRI, mercado, num };
