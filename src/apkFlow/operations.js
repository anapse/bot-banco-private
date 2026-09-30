/* ============================================================================
 * OPERATIONS — flujo de operaciones cambiarias de la APK
 * ----------------------------------------------------------------------------
 *   reglas      → /bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas
 *   reglasCompra→ …/consultar/reglas/compra       (reglas aplicables a COMPRA)
 *   actividades → …/consultar/actividades         (actividad economica)
 *   estados     → …/consultar/estados
 *   oficinas    → …/consultar/oficinas
 *   comprar     → …/comprar
 *   confirmar   → …/confirmar        ← ENDPOINT SEPARADO (no el antiguo)
 *
 * Payload segun los modelos extraidos del binario:
 *   OperacionDivisas{cuentaOrigenBs, cuentaDestinoDivisa}
 *   TransaccionMenudeo{cuentaDestino, montoDivisas, monto}
 *   + campos: codigoRegla, codigoActividadEconomica, descOcupacion, destinoFondos
 * ========================================================================== */
'use strict';
const CLIENT = require('./client');
const LOG = require('./logging');
const { RUTAS } = require('./rutas');

async function consultar(rutaKey, fase) {
  const r = await CLIENT.pedir(RUTAS[rutaKey], { fase, metodo: 'GET' });
  const j = r.json;
  const lista = Array.isArray(j) ? j : (j && (j.data || j.lista || j.items)) || null;
  return {
    http: r.http, ok: r.ok, raw: j, lista,
    n: Array.isArray(lista) ? lista.length : (lista ? 1 : 0),
    error: r.error || null,
  };
}

const reglas        = () => consultar('consultarReglas', 'REGLAS');
const reglasCompra  = () => consultar('reglasCompra',    'REGLAS_COMPRA');
const actividades   = () => consultar('actividades',     'ACTIVIDADES');
const estados       = () => consultar('estados',         'ESTADOS');
const oficinas      = () => consultar('oficinas',        'OFICINAS');

/**
 * Construye el payload de compra con los nombres de campo REALES del APK.
 * Evidencia del binario: OperacionDivisas{cuentaOrigenBs, cuentaDestinoDivisa}
 * y los campos montoDivisa / codigoDivisa.
 * Los valores salen de la config del proyecto y de las respuestas del banco.
 */
function construirPayload({ cuentaOrigenBs, cuentaDestinoDivisa, monto,
                            tasa, codigoRegla, codigoActividadEconomica,
                            descOcupacion, destinoFondos, codigoDivisa }) {
  return {
    cuentaOrigenBs,
    cuentaDestinoDivisa,           // nombre del modelo OperacionDivisas
    montoDivisa: Number(monto).toFixed(2),
    codigoDivisa: codigoDivisa || 'USD',
    tasaCambio: Number(tasa).toFixed(4),
    codigoRegla,
    codigoActividadEconomica,
    descOcupacion,
    destinoFondos,
  };
}

/** COMPRAR (ejecuta). */
async function comprar(payload) {
  return CLIENT.pedir(RUTAS.comprar, {
    fase: 'COMPRAR', metodo: 'POST', body: payload, timeoutMs: 60000,
  });
}

/** CONFIRMAR — endpoint SEPARADO, como hace la APK. */
async function confirmar(payload, operacionId) {
  return CLIENT.pedir(RUTAS.confirmar, {
    fase: 'CONFIRMAR', metodo: 'POST',
    body: { ...payload, operacionId }, timeoutMs: 60000,
  });
}

/**
 * Clasifica la respuesta de compra.
 * Codigo de exito del APK: 1000 (confirmado en el binario).
 */
function clasificar(r) {
  const j = r.json;
  const code = j ? String(j.code ?? j.codigo ?? '') : '';
  if (code === '1000' || code === '00') return 'aceptada';
  if (code === '500') return 'rechazada_500';
  if (code === '1001') return 'no_disponible_1001';
  if (!code) return 'sin_code';
  return `rechazada_code_${code}`;
}

module.exports = {
  reglas, reglasCompra, actividades, estados, oficinas,
  construirPayload, comprar, confirmar, clasificar,
};
