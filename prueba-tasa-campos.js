/* ============================================================================
 * PRUEBA — la tasa se vuelve a detectar en los nombres de campo REALES
 * ----------------------------------------------------------------------------
 * Extrae estadoIntervencionDesdeRespuesta() de server.js y la ejecuta contra
 * respuestas simuladas con los nombres de campo que usa la APK oficial.
 *
 * NO toca el banco. Solo prueba el parser.
 * Ejecutar:  node prueba-tasa-campos.js
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

// --- cargar SOLO las funciones necesarias de server.js, sin arrancar el servidor
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

function extraer(nombre) {
  const re = new RegExp(`(^|\\n)((?:const|function|async function)\\s+${nombre}\\b[\\s\\S]*?)(?=\\n(?:const|function|async function|/\\* ={3,})|\\nconst CLAVES)`, 'm');
  const m = src.match(re);
  if (!m) throw new Error('no se pudo extraer ' + nombre);
  return m[2];
}

// dependencia numérica
const { parseNumeroBanco } = require('./tasas-numero');

const trozos = [
  extraer('CLAVES_TASA_INTERVENCION'),
  extraer('estadoIntervencionDesdeRespuesta'),
];
// quitar declaraciones duplicadas si las hubiera
const cuerpo = trozos.join('\n') + '\nreturn { estadoIntervencionDesdeRespuesta, CLAVES_TASA_INTERVENCION };';
const fn = new Function('parseNumeroBanco', cuerpo)(parseNumeroBanco);
const { estadoIntervencionDesdeRespuesta, CLAVES_TASA_INTERVENCION } = fn;

console.log('\n=== CLAVES QUE SE BUSCAN ===');
console.log(' ', CLAVES_TASA_INTERVENCION.join(' · '));
console.log('\n=== CASOS (nombres de campo reales de la APK) ===\n');

const casos = [
  ['tasaReferencia (lo que ANTES buscaba solo)', [{ code: '00', regla: 'RGLIC', tasaReferencia: '858,05964' }], '858,05964'],
  ['tasaCambio (nombre de la APK) ⭐',           [{ code: '00', regla: 'RGLIC', tasaCambio: '858,05964' }], '858,05964'],
  ['tasa (nombre corto) ⭐',                     [{ code: '00', regla: 'RGLIC', tasa: '858,05964' }], '858,05964'],
  ['tasaMaxima ⭐',                              [{ code: '00', regla: 'RGLIC', tasaMaxima: '858,05964' }], '858,05964'],
  ['tasaVenta (modelo reglas_divisas APK) ⭐',   [{ code: '00', regla: 'RGLIC', tasaVenta: '857,03125' }], '857,03125'],
  ['anidado en data.tasaCambio',                 [{ code: '00', data: { tasaCambio: '860,12345' } }], '860,12345'],
  ['data.data anidado',                          [{ code: '00', data: { data: { tasa: '861,99999' } } }], '861,99999'],
];

let ok = 0, fallos = 0;
for (const [nombre, entrada, esperado] of casos) {
  const r = estadoIntervencionDesdeRespuesta(entrada);
  const got = r.tasaTexto;
  const bien = got === esperado;
  console.log(`  ${bien ? '✅' : '❌'} ${nombre}`);
  console.log(`        esperado=${esperado}  obtenido=${got}  campo=${r.tasaCampo}  abierta=${r.abierta}`);
  bien ? ok++ : fallos++;
}

console.log('\n=== CASOS QUE NO DEBEN DAR TASA (menudeo / cerrado) ===\n');

const negativos = [
  ['solo menudeo dólar (NO debe tomarse)', [{ code: '01', regla: 'RGLIC', tasaCambioVentaDolar: '857,03125' }]],
  ['solo menudeo euro',                    [{ code: '01', regla: 'RGLIC', tasaCambioVentaEuro: '984,16327' }]],
  ['code 01 sin tasa (caso real de hoy)',  [{ code: '01', data: null, description: 'Transacción no disponible, por favor intente mas tarde', regla: 'RGLIC' }]],
  ['tasa cero',                            [{ code: '00', regla: 'RGLIC', tasaCambio: '0' }]],
];

for (const [nombre, entrada] of negativos) {
  const r = estadoIntervencionDesdeRespuesta(entrada);
  // El parser expone 'tasaReferencia' (número) — 'tasa' la asigna actualizarIntervencion()
  const bien = r.tasaReferencia === null || !(r.tasaReferencia > 0);
  console.log(`  ${bien ? '✅' : '❌'} ${nombre}`);
  console.log(`        tasaReferencia=${r.tasaReferencia}  texto=${r.tasaTexto}  estado=${r.estado}  abierta=${r.abierta}`);
  bien ? ok++ : fallos++;
}

console.log(`\n=== RESULTADO: ${ok} correctas, ${fallos} fallidas ===\n`);
process.exit(fallos === 0 ? 0 : 1);
