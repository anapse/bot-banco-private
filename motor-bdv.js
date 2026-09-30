/* ============================================================================
 * MOTOR BDV — puente hacia las implementaciones REALES del proyecto
 * ----------------------------------------------------------------------------
 * Este archivo NO reimplementa nada. Carga la lógica que ya funciona en el
 * proyecto (server.js / tasas-numero.js) y expone sólo lo que el monitor
 * necesita, usando los MISMOS endpoints, headers, cifrado y autenticación:
 *
 *   EXRI    → POST /altaintervencioncambiaria/consultarReglasEXRI
 *   SUBASTA → GET  /validar-mercado/validar-subasta
 *   MERCADO → POST /menudeo/consulta-mercado/
 *   COMPRA  → POST /mesacambiaria/sellbuycurrencyEXCV
 *
 * Cómo funciona: server.js detecta BDV_MONITOR_ONLY=true al cargarse y, en vez
 * de abrir el servidor web, exporta su API interna. Así el monitor usa
 * exactamente el mismo código que produce las respuestas reales del banco.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SERVER = path.join(ROOT, 'server.js');

if (!fs.existsSync(SERVER)) {
  throw new Error(`no se encontró server.js en ${ROOT}`);
}

// server.js, al cargarse con BDV_MONITOR_ONLY=true, publica su API en module.exports
const api = require('./server.js');

if (!api || !api.__monitorApi) {
  throw new Error(
    'server.js no expuso la API del monitor. ' +
    'Asegúrate de que server.js incluya el bloque "BDV_MONITOR_ONLY" al final.'
  );
}
const M = api.__monitorApi;

// ------------------------- datos de configuración --------------------------
const cfg = M.cfg;

// ------------------------------ sesión -------------------------------------
async function preparar() {
  return M.preparar();
}
function sesionViva() {
  return M.sesionViva();
}
function saldoDisponible() {
  return M.saldoDisponible();
}
function hayRegla() {
  return !!M.codigoRegla();
}

// --------------------- consultas reales al banco ---------------------------
// Devuelve EXRI + SUBASTA + MERCADO con los datos ya interpretados por el
// parser del proyecto (estadoIntervencionDesdeRespuesta) y las respuestas crudas.
async function consultarTodo() {
  return M.consultarTodo();
}

// ------------------------------ compra -------------------------------------
function construirPayload(tasa) {
  return M.construirPayload(tasa);
}
async function ejecutarCompra(payload) {
  return M.ejecutarCompra(payload);
}

module.exports = {
  cfg,
  preparar,
  sesionViva,
  saldoDisponible,
  hayRegla,
  consultarTodo,
  construirPayload,
  ejecutarCompra,
};
