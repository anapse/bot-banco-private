/* ============================================================================
 * BDV Bot Web — Motor de automatización de compra de divisas (local)
 * ----------------------------------------------------------------------------
 * - SIRVE el panel web  ->  http://0.0.0.0:3721 (accesible por IP del VPS)
 * - MODO SIM  (default): intervenciones simuladas, tasas simuladas, compras simuladas.
 *   Todo funciona sin credenciales reales. Cero tráfico al banco.
 * - MODO REAL: usa los endpoints reales del APK con tu propio token.
 *   Requiere validar el contrato exacto de cada POST (ver README).
 *   LOS SECRETOS VIVEN EN .env, NUNCA en la interfaz web.
 * ========================================================================== */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Parseo/formato numérico del banco — módulo aparte con pruebas locales (test-tasas.js)
const { parseNumeroBanco, fmtNumeroBanco } = require('./tasas-numero');
// Canal del APK (bdvdigital.banvenez.com): el portal NUNCA refleja si la
// subasta está abierta; el APK usa otra API que sí. Se usa para el modo
// automático y para el manual desde la web.
const apkApi = require('./apk-api');

// Windows: usar el almacén de certificados del SISTEMA (curl lo usa; el bundle de
// Node no incluye algunos intermedios que el banco no envía). Si falta el flag,
// re-lanzarse con él (una sola vez).
// OJO: en MODO MONITOR no se relanza — monitor.js se encarga del flag y un
// relanzamiento aquí abortaría el módulo antes de exportar la API.
if (process.platform === 'win32' && !process.execArgv.includes('--use-system-ca')
    && !process.env._BDV_RELAUNCHED && process.env.BDV_MONITOR_ONLY !== 'true') {
  process.env._BDV_RELAUNCHED = '1';
  const { spawn } = require('child_process');
  const p = spawn(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], {
    stdio: 'inherit', cwd: process.cwd(), env: process.env
  });
  p.on('exit', code => process.exit(code == null ? 0 : code));
  return; // este proceso termina; el hijo con --use-system-ca sigue
}

const PORT = 3721;
const HOST = '0.0.0.0'; // accesible desde el VPS (http://IP_DEL_VPS:3721)
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ENV_PATH = path.join(ROOT, '.env');
const LOGS_DIR = path.join(ROOT, 'logs'); // logs diarios: UN archivo por día

/* ----------------------------- utilidades -------------------------------- */
function nowIso() { return new Date().toISOString(); }

// Ruta del log del día → logs/bot-YYYY-MM-DD.log
// La fecha se calcula EN EL MOMENTO DE ESCRIBIR, así el cambio de día es automático:
// el día 21 se escribe en bot-2026-09-21.log y al llegar el 22 se pasa a
// bot-2026-09-22.log sin mezclar días ni tocar el archivo anterior.
function rutaLogDiario(fecha) {
  const dia = String(fecha || nowIso()).slice(0, 10);
  return path.join(LOGS_DIR, `bot-${dia}.log`);
}

function log(level, msg) {
  // SEGURIDAD: se enmascaran credenciales/tokens/cuentas ANTES de guardar o mostrar,
  // tanto en las líneas de texto como en los registros JSON. El mensaje del banco
  // puede traer el token (p. ej. "Invalid refresh token (expired): eyJ...") — no se
  // guarda nunca tal cual.
  let seguro;
  try { seguro = operMask(String(msg)); } catch (_) { seguro = String(msg); }
  const line = `[${nowIso()}] [${level}] ${seguro}`;
  logs.push(line); if (logs.length > 500) logs.shift();
  if (CAMBIO_KEYS.some(k => msg.includes(k))) {
    histCambios.push({ ts: nowIso(), msg: seguro });
    if (histCambios.length > 100) histCambios.shift();
  }
  // LOG DIARIO: un archivo por día dentro de logs/. Siempre se AÑADE:
  //  · si el archivo del día no existe, se crea automáticamente;
  //  · si ya existe, se sigue agregando al mismo;
  //  · si se borró a mano, se vuelve a crear (el bot no busca otro archivo);
  //  · nunca se sobrescribe, nunca se rota, nunca se borra lo anterior.
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(rutaLogDiario(), line + '\n');
  } catch (_) {}
  console.log(line);
}

/* ============================================================================
 * LOG OPERATIVO DE PRODUCCIÓN
 * ----------------------------------------------------------------------------
 * Registra TODO lo que devuelve el banco durante la ejecución del bot, para
 * poder reconstruir después qué ocurrió: consultas, tasas, cambios de estado,
 * órdenes enviadas y sus respuestas.
 *
 * Formato: una línea JSON por evento, dentro del MISMO archivo diario del bot:
 *   · logs/bot-YYYY-MM-DD.log  → un solo archivo por día (texto + registros JSON)
 *
 * SEGURIDAD: nunca se escriben contraseñas, tokens, Authorization, cookies ni
 * app-key. Se enmascaran antes de escribir.
 *
 * NO es un modo diagnóstico: es logging normal de producción, siempre activo.
 * ========================================================================== */
const OPER_MASK_KEYS = new Set([
  'password', 'clave', 'pass', 'pwd', 'contrasena', 'contraseña',
  'access_token', 'refresh_token', 'token', 'id_token', 'accesstoken', 'refreshtoken',
  'authorization', 'cookie', 'set-cookie', 'app-key', 'app_key', 'apikey',
  'x-media', 'huella', 'ticketid', 'factor3', 'ticket'
]);
// Claves con NÚMEROS FINANCIEROS/PERSONALES: se conservan sólo los últimos 4 dígitos
// (permite identificar la cuenta en el log sin almacenar el número completo).
const OPER_MASK_CUENTA = new Set([
  'cuenta', 'cuentaorigenbs', 'cuentadestino', 'cuentadestinodivisa', 'cuentacliente',
  'cuentaabono', 'cuentacargo', 'numerocuenta', 'nrocuenta',
  'cedula', 'ceduladestino', 'nrodcto', 'documento', 'documentoanfitrion', 'identificacion',
  'numerotarjeta', 'nrotarjeta', 'telefono', 'numerotelefono'
]);
// Patrones de datos sensibles dentro de textos libres
const OPER_PATRONES = [
  [/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1«OCULTO»'],
  // JWT completo y también FRAGMENTOS (el banco abrevia el token en sus mensajes)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}/g, '«JWT»'],
  [/\beyJ[A-Za-z0-9._\-]{4,}/g, '«JWT»'],
  [/(password=)[^&\s]+/gi, '$1«OCULTO»'],
  [/(refresh_token=)[^&\s]+/gi, '$1«OCULTO»'],
  [/(access_token=)[^&\s]+/gi, '$1«OCULTO»'],
  [/(username=)[^&\s]+/gi, '$1«OCULTO»'],
  // cuenta bancaria de 20 dígitos → últimos 4
  [/\b(\d{16})(\d{4})\b/g, '«CUENTA-…$2»'],
];

// Enmascara un valor según su clave
function operMask(valor, clave) {
  if (valor == null) return valor;
  const k = clave == null ? '' : String(clave).toLowerCase();
  // credenciales → ocultar por completo (se conserva la longitud, no el dato)
  if (k && OPER_MASK_KEYS.has(k)) return `«OCULTO:${String(valor).length}»`;
  // número financiero/personal → conservar sólo los últimos 4
  if (k && OPER_MASK_CUENTA.has(k)) {
    const s = String(valor);
    return s.length > 4 ? `…${s.slice(-4)}` : `«OCULTO:${s.length}»`;
  }
  if (typeof valor !== 'string') return valor;
  let s = valor;
  for (const [re, rep] of OPER_PATRONES) s = s.replace(re, rep);
  return s;
}
// Recorre el objeto y enmascara recursivamente (incluye claves anidadas)
function operMaskObj(o, clavePadre) {
  if (o == null) return o;
  if (Array.isArray(o)) return o.map((v) => operMaskObj(v, clavePadre));
  if (typeof o === 'object') {
    const out = {};
    for (const k of Object.keys(o)) out[k] = operMaskObj(o[k], k);
    return out;
  }
  return operMask(o, clavePadre);
}

// Escribe un evento del log operativo (una línea JSON por evento)
// Va al MISMO archivo diario que el log normal (logs/bot-YYYY-MM-DD.log), así hay
// UN SOLO archivo por día. Las líneas de registro operativo empiezan por '{',
// lo que las distingue de las líneas de texto ([fecha] [nivel] mensaje).
function operLog(evento) {
  try {
    const ts = nowIso();
    const reg = { ts, ...evento };
    // cuenta de intento global, para reconstruir la secuencia
    if (reg.intento == null) reg.intento = bot._intentoOper || 0;
    const json = JSON.stringify(reg, (k, v) => (typeof v === 'string' ? operMask(v, k) : v));
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(rutaLogDiario(ts), json + '\n');
  } catch (_) { /* nunca romper el flujo por el log */ }
}

// Registra un CAMBIO de dato importante (ANTES → DESPUÉS)
function operCambio(campo, antes, despues, extra = {}) {
  if (String(antes) === String(despues)) return;
  operLog({ tipo: 'cambio', campo, antes: antes ?? null, despues: despues ?? null, ...extra });
  log('info', `[CAMBIO] ${campo}: ${antes == null ? '-' : antes} → ${despues == null ? '-' : despues}`);
}

// Compara el estado actual con el anterior y registra los cambios
function operDetectarCambios(op, iv) {
  // estado anterior (se inicializa aquí: `bot` ya existe cuando esto se ejecuta)
  bot._prevOper = bot._prevOper || { tasa: null, estado: null, regla: null, disponible: null, fuente: null };
  const p = bot._prevOper;
  const ahora = {
    // Solo la tasa de INTERVENCIÓN entra en el seguimiento de la tasa operativa.
    // (El menudeo se registra aparte, como referencia informativa, y no es la tasa
    //  de la operación: la APK no lo usa en el flujo de intervención.)
    tasa: (op && op.disponible ? op.tasa : null) ?? null,
    estado: (iv && iv.estado) ?? null,
    regla: (op && op.regla) ?? (iv && iv.regla) ?? null,
    disponible: !!(op && op.disponible),
    fuente: (op && op.disponible) ? 'intervencion' : null,
  };
  if (p.tasa !== ahora.tasa && ahora.tasa != null) {
    operCambio('tasa', p.tasa, ahora.tasa, { fuente: ahora.fuente });
  }
  operCambio('estado_intervencion', p.estado, ahora.estado);
  operCambio('regla', p.regla, ahora.regla);
  operCambio('disponibilidad', p.disponible, ahora.disponible);
  operCambio('fuente_tasa', p.fuente, ahora.fuente);
  bot._prevOper = ahora;
}

// Escritura atómica (tmp + rename): evita que web-session.json / web-tasa.json / config.json
// queden vacíos si el proceso muere a mitad de la escritura (pasó con reinicios)
function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/* ------------------------------- config ---------------------------------- */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (_) { return defaultConfig(); }
}
function defaultConfig() {
  return {
    mode: 'sim',            // 'sim' | 'real'
    cedula: 'V-12345678',
    montoMaxUSD: 300,       // monto máximo a comprar por operación (USD) — lo pone el usuario
    tasaMax: 0,             // 0 = sin límite: usar SIEMPRE la tasa que devuelve el banco
    ventanaInicio: '00:00', // filtro opcional del usuario; el banco decide si la venta está disponible
    ventanaFin: '23:59',
    intervaloMs: 1000,      // frecuencia de envío de órdenes
    notificarWeb: true,
    telegram: { botToken: '', chatId: '' }
  };
}
function saveConfig(cfg) {
  writeFileAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/* -------------------------------- .env ------------------------------------ */
function loadEnv() {
  const env = {};
  try {
    for (const raw of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch (_) {}
  return env;
}

// Escribe/actualiza una variable en .env (para la opción "recordar" del login)
function writeEnv(key, value) {
  let txt = '';
  try { txt = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(txt)) txt = txt.replace(re, line);
  else txt += (txt ? (txt.endsWith('\n') ? '' : '\n') : '') + line + '\n';
  writeFileAtomic(ENV_PATH, txt);
  env[key] = value;
}

/* ------------------------------ estado bot -------------------------------- */
const logs = [];
// modificaciones hechas al bot (config, credenciales, sesión) — para la pestaña Log
const histCambios = [];
const CAMBIO_KEYS = ['Configuración guardada', 'Credenciales guardadas', 'Login WEB exitoso',
  'Sesión cerrada por el usuario', 'Sesión restaurada automáticamente', '🎯', 'Intervención EXRI cerrada'];
let cfg = loadConfig();
const env = loadEnv();

let bot = {
  running: false,
  status: 'detenido',        // detenido | esperando_intervencion | intervencion_abierta | comprando | confirmando | comprado | error
  lastCheck: null,
  lastError: null,
  nextAuctionAt: null,
  auctionOpen: false,
  tasaActual: null,
  compras: [],               // [{fecha, montoUSD, tasa, referencia, modo}]
  checks: 0,
  timer: null,
  simSeed: Math.floor(Date.now() / 60000), // ventana sim determinista por minuto
  token: null,        // access_token en vivo (modo real)
  refreshToken: null, // refresh_token en vivo (modo real)
  webTicket: null,    // ticket de sesión del portal web
  webUser: null,
  webLoginData: null, // respuesta íntegra del último login web
  webLoginTs: 0,      // cuándo se obtuvo el token (para renovarlo)
  webMercado: null,   // tasa del banco en vivo (menudeo)
  webSaldo: null,
  webSaldoPrev: null, // saldo anterior (para detectar cambios)
  lastBuyAt: null
};

/* ============================================================================
 * MODELO CENTRAL DE TASAS  —  ÚNICA FUENTE DE VERDAD
 * ----------------------------------------------------------------------------
 * INTERVENCIÓN y MENUDEO viven SEPARADOS. Ninguno sustituye al otro.
 * La "tasa operativa" (la única utilizable para una operación) sale
 * EXCLUSIVAMENTE de la intervención ABIERTA con tasa válida y de una respuesta
 * ACTUAL. Una tasa histórica guardada en disco NUNCA es operativa.
 *
 * Evidencia disponible: sólo la respuesta CERRADA de consultarReglasEXRI
 * (array con code '01'). El contrato de la respuesta ABIERTA está
 * "NO VERIFICADO": si aparece, se analiza y se adapta el parser a lo observado
 * (sin rellenar campos faltantes con valores inventados).
 * ========================================================================== */
const BOOT_TS = Date.now();

const tasas = {
  intervencion: {
    estado: 'sin_datos',        // abierta | cerrada | sin_datos | desconocido | error
    abierta: false,             // SOLO se pone true con el código explícito del banco ('00')
    code: null,                 // código crudo del banco
    regla: null,                // RGLIC / RGLMV (dato del banco)
    description: null,
    tasa: null,                 // tasaReferencia (número) — solo si abierta y válida
    tasaTexto: null,            // tal como la entrega el banco
    cupoPersNaturales: null,
    porcentajeComision: null,   // tal como lo entrega el banco
    timestamp: null,            // ISO de la consulta que la produjo
    ageMs: null,
    endpoint: '/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra',
    httpStatus: null,
    error: null,
    raw: null,                  // respuesta completa (diagnóstico interno; NO se envía al panel)
    contrato: 'NO VERIFICADO (respuesta abierta)'
  },
  menudeo: {
    estado: 'sin_datos',
    compraUSD: null, ventaUSD: null, compraEUR: null, ventaEUR: null,
    compraUSDTexto: null, ventaUSDTexto: null, compraEURTexto: null, ventaEURTexto: null,
    porcentajeComision: null, montoMaximo: null, montoMinimo: null,
    horaMinimo: null, horaMaximo: null, numeroTurno: null, estadoPolitica: null,
    divisas: { USD: { disponible: null }, EUR: { disponible: null } },
    timestamp: null, ageMs: null,
    endpoint: '/menudeo/consulta-mercado/',
    httpStatus: null, error: null, raw: null
  },
  historico: null               // web-tasa.json → SOLO visual, jamás operativo
};

/* --------------------- números: parseo y formato -------------------------- */
// parseNumeroBanco() y fmtNumeroBanco() viven en ./tasas-numero.js (módulo con
// pruebas locales: `node test-tasas.js`). Aquí sólo se importan arriba.
function edadMs(ts) { return ts ? (Date.now() - new Date(ts).getTime()) : null; }
function edadTexto(ms) {
  if (ms == null) return 'sin datos';
  if (ms < 2000) return 'actualizada hace menos de 2 s';
  if (ms < 60000) return `actualizada hace ${Math.round(ms / 1000)} s`;
  if (ms < 3600000) return `actualizada hace ${Math.round(ms / 60000)} min`;
  return `actualizada hace ${Math.round(ms / 3600000)} h`;
}
// Resumen sin secretos de una respuesta del banco (para logs/diagnóstico)
function resumenRespuesta(x, max = 300) {
  try {
    if (x == null) return null;
    if (typeof x !== 'object') return String(x).slice(0, max);
    const SENS = /token|password|clave|secret|huella|authorization|crypt/i;
    const limpia = (o, d = 0) => {
      if (d > 3) return '…';
      if (Array.isArray(o)) return o.slice(0, 5).map(v => limpia(v, d + 1));
      if (o && typeof o === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(o)) out[k] = SENS.test(k) ? '<oculto>' : limpia(v, d + 1);
        return out;
      }
      return o;
    };
    const s = JSON.stringify(limpia(x));
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (_) { return null; }
}
// Traza de cada actualización de mercado (sin secretos)
// ---------------------------------------------------------------------------
// LOG DE FLUJO — sencillo y legible (es el que se leerá en la próxima prueba).
//   Etapas: SESIÓN · CUENTAS · MERCADO · REGLAS · TASA · VALIDACIÓN · ORDEN ·
//           BDV · RESULTADO   (+ [NO ENVIADA] motivo=…)
// Se emite cuando CAMBIA el estado, y un latido cada 10 min para no inundar.
// ---------------------------------------------------------------------------
let _ultimoFlujoKey = null, _ultimoFlujoMs = 0;
function logTasas(extra = '') {
  const i = tasas.intervencion;
  const op = getTasaOperativa();
  const key = `${i.estado}|${i.code}|${op.disponible ? op.tasaTexto : 'na'}|${extra}`;
  const ahora = Date.now();
  if (key === _ultimoFlujoKey && (ahora - _ultimoFlujoMs) < 600000) return; // sin cambios y <10 min
  _ultimoFlujoKey = key; _ultimoFlujoMs = ahora;
  log('info', `[MERCADO] ${i.estado === 'abierta' ? 'ABIERTO' : (i.estado === 'cerrada' ? 'CERRADO' : String(i.estado).toUpperCase())}`);
  log('info', `[REGLAS] ${i.code == null ? 'sin-code' : ('code=' + i.code)}${i.regla ? ' regla=' + i.regla : ''}${i.description ? ' · ' + String(i.description).slice(0, 60) : ''}`);
  log('info', `[TASA] ${op.disponible ? op.tasaTexto : 'NO DISPONIBLE'}${op.disponible ? '' : ' (' + op.motivo + ')'}`);
  log('info', `[MERCADO] señal de apertura: ${i.senalApertura || 'SEÑAL DE APERTURA NO VERIFICADA'}`);
  log('info', `[TASA] menudeo (sólo referencia, NO operativa): compraUSD=${tasas.menudeo.compraUSDTexto || '-'} ventaUSD=${tasas.menudeo.ventaUSDTexto || '-'}${extra ? ' · ' + extra : ''}`);
}

/* ------------------- intervención: estado desde la respuesta -------------- */
// EVIDENCIA REAL DEL PROYECTO (todo lo observado en vivo):
//   CERRADO → [{code:'01', data:null, description:'Transacción no disponible, por
//             favor intente mas tarde', regla:'RGLIC'|'RGLMV', status:'200',
//             montoComision1/2/3:null}]   ← 406 veces en el log
//   CERRADO → GET /validar-mercado/validar-subasta: {code:1001, message:'Las
//             operaciones cambiarias estarán disponibles más tarde…'}
//   ABIERTO → **NINGUNA MUESTRA EN TODO EL HISTÓRICO** (0 detecciones).
// Por eso: el CERRADO se detecta con señales verificadas, y para el ABIERTO se
// declara explícitamente que la señal NO ESTÁ VERIFICADA. Como única señal
// positiva se acepta un dato REAL que el banco sí publica: una tasa de
// intervención numérica > 0. Si no hay ni eso, el estado es 'desconocido' y NO
// se opera. El menudeo NUNCA entra en esta función.
// CLAVES donde el banco puede publicar la TASA DE INTERVENCIÓN.
// Recuperado de la versión que SÍ obtenía la tasa (ago-30) + lo observado en la APK
// oficial (usa variantes de 'tasaCambio*' y 'tasaCompra'/'tasaVenta'; 'tasaReferencia'
// casi no aparece en su binario). El orden define la prioridad: la más específica primero.
//
// ⚠️ SOLO INTERVENCIÓN. NUNCA se añaden claves del MENUDEO
//    (tasaCambioCompraDolar, tasaCambioVentaDolar, tasaCambioCompraEuro, tasaCambioVentaEuro):
//    mezclar ambos mercados fue el defecto que la refactorización anterior corrigió,
//    y no se reintroduce.
// Claves de tasa de la respuesta de intervención, ORDENADAS por la evidencia de la APK:
//   · 'tasaVenta' / 'tasaCompra' son campos REALES del modelo `reglas_divisas` de la APK
//     (esquema SQL literal en libapp.so + toString) — es el modelo que llena la consulta
//     de reglas de la intervención.
//   · 'tasaCambio' aparece en la APK como campo de otros modelos de operación.
//   · 'tasaReferencia' NO es campo de ningún modelo en la APK (aparece 1 vez, suelto).
//     Se conserva AL FINAL solo como último recurso de compatibilidad.
//
// ⚠️ SOLO INTERVENCIÓN. NUNCA se añaden claves del MENUDEO
//    (tasaCambioCompraDolar, tasaCambioVentaDolar, tasaCambioCompraEuro, tasaCambioVentaEuro):
//    mezclar ambos mercados fue el defecto que la refactorización anterior corrigió,
//    y no se reintroduce.
const CLAVES_TASA_INTERVENCION = ['tasaVenta', 'tasaCompra', 'tasaCambio', 'tasaReferencia'];

/*
 * Decodifica la respuesta de DISPONIBILIDAD del canal APK
 * (`/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra`).
 *
 * Evidencia de la APK (libapp.so):
 *   · la disponibilidad se decide comparando `response` contra el literal `1000`
 *     (`getReglasByMonedaRetiro != 1000`, `response != 1000`).
 *   · la respuesta es un objeto `{ code, message, data }`, no una lista.
 *
 * Solo se interpreta `code === '1000'` como DISPONIBLE. Cualquier otro valor
 * (1001, 1003, 01, etc.) se reporta como NO DISPONIBLE sin inventar su
 * significado: la APK no deja literal que explique 1002/1003.
 */
function estadoIntervencionDesdeRespuesta(resp) {
  const out = {
    estado: 'sin_datos', abierta: false, code: null, regla: null, description: null,
    tasaReferencia: null, tasaTexto: null, tasaCampo: null, cupoPersNaturales: null,
    porcentajeComision: null, items: 0,
    senalApertura: null, senalCierre: null, raw: resp ?? null
  };
  const r = resp && typeof resp === 'object' ? resp : {};
  const code = (r.code != null || r.codigo != null) ? String(r.code != null ? r.code : r.codigo) : null;
  out.code = code;
  out.description = (r.message || r.descripcion || r.description) ?? null;

  // datos útiles si el banco los entrega (regla, cupo, comisión, tasa)
  const data = r.data && typeof r.data === 'object' ? r.data : null;
  const srcs = [r, data].filter((x) => x && typeof x === 'object');
  for (const s of srcs) {
    if (out.regla == null && (s.regla || s.codigoRegla)) out.regla = String(s.regla || s.codigoRegla);
    if (out.cupoPersNaturales == null && s.cupoPersNaturales != null) out.cupoPersNaturales = s.cupoPersNaturales;
    if (out.porcentajeComision == null && (s.porcentajeComision ?? s.porcentajeComision1) != null) out.porcentajeComision = s.porcentajeComision ?? s.porcentajeComision1;
    if (out.tasaTexto == null) {
      for (const k of CLAVES_TASA_INTERVENCION) {
        if (s[k] != null) { out.tasaTexto = String(s[k]); out.tasaCampo = k; break; }
      }
    }
  }
  out.tasaReferencia = parseNumeroBanco(out.tasaTexto);
  out.items = data ? 1 : 0;

  // ÚNICA señal de disponibilidad que demuestra la APK: code === '1000'.
  if (code === '1000') {
    out.estado = 'abierta';
    out.abierta = true;
    out.senalApertura = "code '1000' (disponibilidad del canal APK — verificado en libapp.so)";
  } else if (code != null) {
    out.estado = 'cerrada';
    out.abierta = false;
    out.senalCierre = `code '${code}' (no disponible)`;
  } else {
    out.estado = 'sin_datos';
    out.abierta = false;
    out.senalCierre = 'sin código de respuesta';
  }
  return out;
}
// Refresca el estado de la intervención y actualiza el modelo central.
// FUENTE: canal APK (`/bdvx-operaciones-cambiarias/v1/operaciones/consultar/reglas/compra`).
// NO usa el portal (bdvenlinea) ni `validar-subasta` para la detección.
async function actualizarIntervencion() {
  const t = tasas.intervencion;
  try {
    // Disponibilidad por el canal del APK (code === '1000' = disponible).
    const compra = await apkApi.estadoCompra();
    const st = estadoIntervencionDesdeRespuesta(compra);
    t.estado = st.estado;
    t.abierta = st.abierta;
    t.code = st.code;
    t.regla = st.regla;
    t.description = st.description;
    t.raw = st.raw;
    t.senalApertura = st.senalApertura;
    t.senalCierre = st.senalCierre;
    t.validarMercado = null; // ya no se consulta validar-subasta (portal)
    // La tasa de intervención sólo se da por válida si el banco marcó disponible.
    if (st.abierta && st.tasaReferencia != null && st.tasaReferencia > 0) {
      t.tasa = st.tasaReferencia;
      t.tasaTexto = st.tasaTexto;
    } else {
      t.tasa = null;
      t.tasaTexto = st.tasaTexto;
    }
    t.cupoPersNaturales = st.abierta ? st.cupoPersNaturales : null;
    t.porcentajeComision = st.abierta ? st.porcentajeComision : null;
    t.timestamp = nowIso();
    t.ageMs = 0;
    t.error = null;
    t.httpStatus = compra.httpStatus ?? null;
    if (t.estado === 'sin_datos') {
      log('warn', `[MERCADO] sin respuesta del canal APK — respuesta: ${resumenRespuesta(st.raw)}`);
    }
  } catch (e) {
    t.estado = 'error';
    t.abierta = false;
    t.tasa = null;
    t.tasaTexto = null;
    t.cupoPersNaturales = null;
    t.porcentajeComision = null;
    t.timestamp = nowIso();
    t.ageMs = 0;
    t.error = e.message;
    log('error', `[TASA] fallo consultando intervención (${t.endpoint}): ${e.message}`);
  }
  bot.webTasaEXRI = t.tasa;
  bot.webCupoIntervencion = t.cupoPersNaturales;
  bot.webComisionIntervencion = t.porcentajeComision;
  bot.webIntervencionAbierta = t.abierta;
  bot.webIntervencionEstado = t.estado;
  bot.webCodigoRegla = t.regla || null;
  return t;
}

/* ---------------- tasa OPERATIVA: única decisión, un solo lugar ----------- */
// Devuelve SIEMPRE la misma estructura. La UI sólo pinta esto; no decide nada.
// TASA PUBLICADA DEL MENUDEO (recuperado de la versión histórica que SÍ obtenía la tasa).
// El banco publica la tasa de referencia del menudeo ANTES de abrir la intervención
// y la mantiene visible aunque EXRI esté cerrado (code '01'). Evidencia:
//   · respuesta real del portal: /menudeo/consulta-mercado/ → tasaCambioCompraDolar,
//     tasaCambioVentaDolar, estadoPolitica='A'.
//   · APK oficial (libapp.so): modelo Tasa{estadoPolitica, ...} + campos
//     tasaCambioCompraDolar / tasaCambioVentaDolar → pertenece a /bdvx-menudeo-v2/v1/mercado.
// Se lee EN VIVO (nunca caché) y se rotula siempre como fuente 'menudeo-*' para que
// NUNCA se confunda con la tasa de la intervención (EXRI).
function tasaPublicadaMenudeo() {
  const m = tasas.menudeo;
  // sólo dato de ESTA sesión y sin error: nunca caché histórica
  if (!m || m.estado !== 'ok' || m.error || !m.timestamp) return null;
  const esDeEstaSesion = new Date(m.timestamp).getTime() >= BOOT_TS;
  if (!esDeEstaSesion) return null;
  // preferencia: venta USD (la tasa a la que el banco vende divisas), luego compra USD
  const venta = m.ventaUSD;
  const compra = m.compraUSD;
  const valor = (venta != null && venta > 0) ? venta : (compra != null && compra > 0 ? compra : null);
  if (valor == null) return null;
  return {
    tasa: valor,
    tasaTexto: fmtNumeroBanco(valor, 5),
    campo: (venta != null && venta > 0) ? 'tasaCambioVentaDolar' : 'tasaCambioCompraDolar',
    fuente: (venta != null && venta > 0) ? 'menudeo-venta' : 'menudeo-compra',
    timestamp: m.timestamp,
    ageMs: edadMs(m.timestamp),
    estadoPolitica: m.estadoPolitica
  };
}
function getTasaOperativa() {
  const i = tasas.intervencion;
  i.ageMs = edadMs(i.timestamp);
  const esDeEstaSesion = !!(i.timestamp && new Date(i.timestamp).getTime() >= BOOT_TS);
  const valida = i.abierta && i.tasa != null && i.tasa > 0 && !!i.timestamp && !i.error;
  if (valida) {
    return {
      disponible: true, estadoComercial: 'OPERATIVA', origen: 'intervencion', mercado: 'intervencion',
      tasa: i.tasa, tasaTexto: fmtNumeroBanco(i.tasa, 5), rawTexto: i.tasaTexto,
      regla: i.regla, cupoPersNaturales: i.cupoPersNaturales,
      porcentajeComision: i.porcentajeComision,
      timestamp: i.timestamp, ageMs: i.ageMs, edadTexto: edadTexto(i.ageMs),
      deEstaSesion: esDeEstaSesion, motivo: null, senalApertura: i.senalApertura,
      // tasa publicada del menudeo (informativa; NO es la operativa de la intervención)
      publicadaMenudeo: tasaPublicadaMenudeo()
    };
  }
  // --- EXRI NO operativa: se distingue "intervención cerrada" de "hay tasa publicada" ---
  let motivo;
  if (i.estado === 'error') motivo = `No se pudo consultar la intervención: ${i.error || 'error de red'}`;
  else if (i.estado === 'sin_datos') motivo = 'Sin respuesta de la intervención';
  else if (i.estado === 'desconocido') motivo = `Respuesta de intervención no clasificada (code ${i.code})`;
  else if (i.abierta && i.tasa == null) motivo = 'La intervención está abierta pero el banco no entregó tasaReferencia (contrato NO VERIFICADO)';
  else motivo = 'La intervención no está disponible';
  // tasa publicada del menudeo: visible aunque la intervención esté cerrada
  const pub = tasaPublicadaMenudeo();
  // Mensaje de interfaz CORREGIDO: si hay tasa publicada no se dice "no hay tasa".
  const motivoUi = pub
    ? `Intervención cerrada — la tasa publicada del menudeo es ${pub.tasaTexto} Bs/USD (${pub.fuente})`
    : motivo;
  return {
    disponible: false, estadoComercial: 'NO_DISPONIBLE', origen: 'intervencion', mercado: 'intervencion',
    tasa: null, tasaTexto: null, rawTexto: i.tasaTexto,
    regla: i.regla, cupoPersNaturales: null, porcentajeComision: null,
    timestamp: i.timestamp, ageMs: i.ageMs, edadTexto: edadTexto(i.ageMs),
    deEstaSesion: esDeEstaSesion, motivo, motivoUi,
    // TASA PUBLICADA (menudeo) — visible aunque EXRI esté cerrado. NO operativa de EXRI.
    publicadaMenudeo: pub,
    tasaPublicada: pub ? pub.tasa : null,
    tasaPublicadaTexto: pub ? pub.tasaTexto : null,
    fuenteTasaPublicada: pub ? pub.fuente : null,
    senalApertura: i.senalApertura, senalCierre: i.senalCierre
  };
}
// Vista pública (panel) del estado de intervención — sin la respuesta cruda
function vistaIntervencion() {
  const i = tasas.intervencion;
  i.ageMs = edadMs(i.timestamp);
  return {
    estado: i.estado, abierta: i.abierta, code: i.code, regla: i.regla,
    description: i.description,
    tasa: i.abierta ? i.tasa : null,
    tasaTexto: i.abierta && i.tasa != null ? fmtNumeroBanco(i.tasa, 5) : null,
    cupoPersNaturales: i.cupoPersNaturales, porcentajeComision: i.porcentajeComision,
    timestamp: i.timestamp, ageMs: i.ageMs, edadTexto: edadTexto(i.ageMs),
    deEstaSesion: !!(i.timestamp && new Date(i.timestamp).getTime() >= BOOT_TS),
    endpoint: i.endpoint, httpStatus: i.httpStatus, error: i.error,
    contrato: i.contrato,
    senalApertura: i.senalApertura, senalCierre: i.senalCierre, validarMercado: i.validarMercado || null
  };
}
// Vista pública del menudeo — referencia informativa, NUNCA operativa
function vistaMenudeo() {
  const m = tasas.menudeo;
  m.ageMs = edadMs(m.timestamp);
  return {
    estado: m.estado,
    compraUSD: m.compraUSD, ventaUSD: m.ventaUSD,
    compraEUR: m.compraEUR, ventaEUR: m.ventaEUR,
    compraUSDTexto: m.compraUSDTexto, ventaUSDTexto: m.ventaUSDTexto,
    compraEURTexto: m.compraEURTexto, ventaEURTexto: m.ventaEURTexto,
    porcentajeComision: m.porcentajeComision, montoMaximo: m.montoMaximo, montoMinimo: m.montoMinimo,
    horaMinimo: m.horaMinimo, horaMaximo: m.horaMaximo, numeroTurno: m.numeroTurno,
    estadoPolitica: m.estadoPolitica, divisas: m.divisas,
    timestamp: m.timestamp, ageMs: m.ageMs, edadTexto: edadTexto(m.ageMs),
    deEstaSesion: !!(m.timestamp && new Date(m.timestamp).getTime() >= BOOT_TS),
    endpoint: m.endpoint, httpStatus: m.httpStatus, error: m.error
  };
}

// Política de frescura de la intervención (se consulta como mucho cada 20 s).
// NO es una segunda decisión de tasa: sólo evita golpear al banco en cada intento.
const FRESCURA_INTERVENCION_MS = 20000;

// La TASA PUBLICADA (menudeo) ya NO usa ventana de frescura: se consulta al banco
// en cada intento para que el payload siempre lleve la tasa vigente. Así, si el
// banco cambia la tasa, el siguiente intento usa la nueva — nunca una anterior.

// Cálculo de la operación con componentes SEPARADOS.
// La comisión NO se inventa: sólo se reporta el porcentaje que entregue el banco.
// La base de cálculo de esa comisión no está verificada contractualmente, por eso
// `comision` queda en null y se muestra "Comisión según banco".
function calcularOperacion(montoDivisa, op) {
  const monto = parseNumeroBanco(montoDivisa);
  const tasa = (op && op.disponible && op.tasa != null) ? op.tasa : null;
  const subtotal = (monto != null && tasa != null) ? +(monto * tasa).toFixed(2) : null;
  const pct = (op && op.porcentajeComision != null) ? parseNumeroBanco(op.porcentajeComision) : null;
  const comision = null;      // NO VERIFICADO: no se calcula
  const total = subtotal;     // sin comisión verificada, el total conocido es el subtotal
  return {
    montoDivisa: monto, tasa, subtotal, comision, total,
    porcentajeComision: pct,
    comisionFuente: pct != null
      ? `porcentajeComision del banco = ${pct}% (base de cálculo NO VERIFICADA)`
      : 'el banco no entregó comisión para esta operación',
    nota: 'CONTRATO NO VERIFICADO: fórmula de comisión'
  };
}

/* ------------- ORDEN: formato ÚNICO + validaciones (un solo lugar) -------- */
// Un ÚNICO formato numérico para el payload, compartido por las dos rutas
// (bot y formulario) → no puede existir una ruta con un formato y otra con otro.
// NOTA HONESTA: el formato que acepta el banco NO está verificado; por eso el log
// [ORDEN] registra exactamente lo que se envía, para comprobarlo en la apertura.
function fmtMontoOrden(n) { return Number(n).toFixed(2); }  // "150.00"
function fmtTasaOrden(n) { return Number(n).toFixed(4); }   // "770.3000"
function construirPayloadOrden({ ctaD, ctaU, monto, op, regla, act, dest }) {
  const p = {
    cuentaOrigenBs: ctaD,
    cuentaDestino: ctaU,
    monto: fmtMontoOrden(monto),
    tasaCambio: fmtTasaOrden(op.tasa),
    codigoRegla: regla,
    codigoActividadEconomica: (act && act.id) || '',
    descOcupacion: (act && act.actividadEconomica) || '',
    destinoFondos: (dest && dest.id) || ''
  };
  if (cfg.jornadaDivisa) p.jornadaDivisa = cfg.jornadaDivisa;
  return p;
}
// Validaciones ANTES de enviar. Devuelve {ok, motivo}. Si falla → NO se envía.
function validarOrden({ ctaD, ctaU, monto, op, regla, act, paraBot }) {
  if (!bot.webLoginData || !bot.webLoginData.data || !bot.webLoginData.data.access_token) return { ok: false, motivo: 'sin sesión válida' };
  if (!ctaD) return { ok: false, motivo: 'cuenta origen no disponible' };
  if (!ctaU) return { ok: false, motivo: 'cuenta destino USD no disponible' };
  if (!op.disponible) return { ok: false, motivo: `mercado no disponible (${op.motivo})` };
  if (!regla) return { ok: false, motivo: 'reglas no disponibles (sin codigoRegla del banco)' };
  if (!(monto > 0)) return { ok: false, motivo: 'monto inválido' };
  if (!(op.tasa > 0)) return { ok: false, motivo: 'tasa operativa inválida' };
  if (!(act && act.id)) return { ok: false, motivo: 'código de actividad económica no disponible' };
  // --- reglas del bot (antes estaban tras un `return` y NO se ejecutaban) ---
  if (paraBot) {
    if (cfg.montoMaxUSD <= 0) return { ok: false, motivo: 'monto configurado en 0' };
    if (cfg.tasaMax > 0 && op.tasa > cfg.tasaMax) return { ok: false, motivo: `tasa ${op.tasaTexto} supera tasaMax=${cfg.tasaMax}` };
    if (bot.lastBuyAt && Date.now() - bot.lastBuyAt < (cfg.cooldownMin || 5) * 60000) {
      return { ok: false, motivo: `cooldown activo (1 orden por apertura / ${cfg.cooldownMin || 5} min)` };
    }
  }
  return { ok: true };
}
function logNoEnviada(motivo, extra = '') { log('warn', `[NO ENVIADA] motivo=${motivo}${extra ? ' · ' + extra : ''}`); }
// Contadores visibles en el panel: no enviadas ≠ enviadas ≠ rechazadas ≠ aceptadas
function contar(k) {
  bot.contadores = bot.contadores || { noEnviadas: 0, enviadas: 0, rechazadas: 0, aceptadas: 0 };
  bot.contadores[k] = (bot.contadores[k] || 0) + 1;
}

/* --------------------------- vistas del panel ----------------------------- */
// Enmascara números de cuenta: sólo los últimos 4 dígitos
function maskCuenta(c) { return c ? '…' + String(c).slice(-4) : null; }
// Resuelve la cuenta elegida en el panel contra la lista REAL del banco.
// Acepta el número completo, la máscara ('…4951') o los últimos 4 dígitos.
function resolverCuenta(valor, lista) {
  const v = valor == null ? '' : String(valor).trim();
  if (!v) return null;
  const items = Array.isArray(lista) ? lista : [];
  const completo = items.find(x => x && String(x.cuenta) === v);
  if (completo) return String(completo.cuenta);
  const ult4 = v.replace(/[^0-9]/g, '').slice(-4);
  if (ult4.length === 4) {
    const porUlt4 = items.find(x => x && String(x.cuenta).endsWith(ult4));
    if (porUlt4) return String(porUlt4.cuenta);
  }
  return null;
}
// Sólo interesa CUÁNDO expira el token de sesión (nunca el token)
function expiracionTokenMs() {
  try {
    const t = bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.access_token;
    if (!t) return null;
    const p = t.split('.')[1];
    const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return (j && j.exp) ? j.exp * 1000 : null;
  } catch (_) { return null; }
}
// Config sin datos sensibles (cuentas enmascaradas, telegram resumido)
function sanitizarCfg(c) {
  const { telegram, ...resto } = (c || {});
  return {
    ...resto,
    cuentaDebito: maskCuenta(c && c.cuentaDebito),
    cuentaDestino: maskCuenta(c && c.cuentaDestino),
    telegram: { configurado: !!(telegram && telegram.botToken && telegram.chatId) }
  };
}
// Estado que consume el panel: SIN access_token / refresh_token / password /
// claves AES / números de cuenta completos. El panel sólo pinta esto.
function estadoPanel() {
  const ld = bot.webLoginData || {};
  const dd = ld.datos || {};
  // TRES ESTADOS INDEPENDIENTES (no se condicionan entre sí):
  //   A) botEncendido   → el ciclo está corriendo. NO requiere tasa ni intervención.
  //   B) intervencionDisponible → el banco publicó la intervención con su tasa.
  //   C) datosOperacion → están TODOS los datos que la operación necesita.
  // La ausencia de B/C nunca apaga ni bloquea A.
  const opA = getTasaOperativa();
  const botEncendido = !!bot.running;
  const intervencionDisponible = opA.disponible === true;
  const datosOperacion = intervencionDisponible
    && !!cfg.cuentaDebito && !!cfg.cuentaDestino
    && (cfg.montoMaxUSD || 0) > 0;
  const estados = {
    botEncendido,
    intervencionDisponible,
    datosOperacion,
    // Texto explícito para la UI: la falta de tasa es "esperando", no "bloqueado".
    texto: !botEncendido ? 'BOT: APAGADO'
      : !intervencionDisponible ? 'BOT: ENCENDIDO · INTERVENCIÓN: ESPERANDO · TASA: NO DISPONIBLE TODAVÍA'
        : !datosOperacion ? 'BOT: ENCENDIDO · INTERVENCIÓN: DISPONIBLE · DATOS: INCOMPLETOS'
          : 'BOT: ENCENDIDO · INTERVENCIÓN: DISPONIBLE · DATOS: LISTOS',
  };
  return {
    bot: {
      running: !!bot.running, status: bot.status, lastCheck: bot.lastCheck, lastError: bot.lastError,
      checks: bot.checks, rechazos: bot._rechazos || 0,
      saldoInsuficiente: !!bot.saldoInsuficiente, auctionOpen: !!bot.auctionOpen,
      compras: bot.compras || [], tasaFuente: bot.tasaFuente || null
    },
    estados,
    tasas: {
      operativa: getTasaOperativa(),
      intervencion: vistaIntervencion(),
      menudeo: vistaMenudeo(),
      historico: tasas.historico
    },
    // Fuente de la tasa que está usando el bot: 'intervencion' (EXRI) o 'menudeo-venta'/'menudeo-compra'.
    // Nunca se confunden: EXRI manda cuando está abierta.
    tasaFuenteBot: bot.tasaFuente || null,
    tasaEsEXRI: bot.tasaEsOperativaEXRI === true,
    sesion: {
      loggedIn: !!(ld.data && ld.data.access_token),
      usuario: bot.webUser || null,
      exp: expiracionTokenMs(),
      autoRenew: cfg.autoRenew !== false,
      antiguedadSesionMs: bot.webLoginTs ? (Date.now() - bot.webLoginTs) : null
    },
    cuentas: { debito: maskCuenta(cfg.cuentaDebito), destino: maskCuenta(cfg.cuentaDestino) },
    saldo: (bot.webSaldo && bot.webSaldo.data)
      ? { disponible: bot.webSaldo.data.saldoDisponible ?? null, mensaje: bot.webSaldo.message || null }
      : (bot.webSaldo ? { disponible: null, mensaje: bot.webSaldo.message || null } : null),
    datosCliente: {
      name: dd.name || null, lastName: dd.lastName || null, id: dd.id || null, idType: dd.idType || null,
      phone: dd.phone || null, fechaNac: dd.fechaNac || null,
      lastConnection: dd.lastConnection || null, socialLevel: dd.socialLevel || null
    },
    ultimaCompra: bot.ultimaCompra || null,
    cfg: sanitizarCfg(cfg)
  };
}

/* --------------------- endpoints reales (del APK) ------------------------- */
// [DEPRECATED — NO USADO POR EL FLUJO OPERATIVO]
// Motor alterno contra bdvdigital.banvenez.com (el de la app). Se conserva por
// si se necesita más adelante, pero el bot opera por el PORTAL (bdvenlinea):
// el login OAuth de la app devolvió 401 en las pruebas. No usar para la tasa.
const API_BASE = 'https://bdvdigital.banvenez.com';
const ENDPOINTS = {
  login:        `${API_BASE}/bdvx-oauth-server/oauth/token`,                          // POST grant_type=password
  reglasEXRI:   `${API_BASE}/bdvx-intervencion-cambiaria/v1/intervencion/consultarReglasEXRI`,
  intervencion: `${API_BASE}/bdvx-intervencion-cambiaria/v1/intervencion/`,
  mercado:      `${API_BASE}/bdvx-menudeo-v2/v1/mercado`,
  transar:      `${API_BASE}/bdvx-menudeo-v2/v1/transar`,
  comprar:      `${API_BASE}/bdvx-operaciones-cambiarias/v1/operaciones/comprar`,
  confirmar:    `${API_BASE}/bdvx-operaciones-cambiarias/v1/operaciones/confirmar`,
  estados:      `${API_BASE}/bdvx-operaciones-cambiarias/v1/operaciones/consultar/estados`
};

/* ------------------------------- SIM engine -------------------------------- */
function withinWindow() {
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  const [hi, mi] = cfg.ventanaInicio.split(':').map(Number);
  const [hf, mf] = cfg.ventanaFin.split(':').map(Number);
  return now >= hi * 60 + mi && now <= hf * 60 + mf;
}

// Intervenciones simuladas: picos pseudo-aleatorios pero estables dentro de la ventana
// [SOLO MODO SIM] Generador de intervenciones/tasas simuladas. No toca el banco y
// NO participa en el flujo real (el modo real nunca lee estas tasas).
function simAuctionState() {
  const d = new Date();
  const min = d.getHours() * 60 + d.getMinutes();
  const [hi, mi] = cfg.ventanaInicio.split(':').map(Number);
  const [hf, mf] = cfg.ventanaFin.split(':').map(Number);
  const open = min >= hi * 60 + mi && min <= hf * 60 + mf;
  const seed = bot.simSeed; // seed estable por arranque (bot.simSeed, no cfg)
  // pulso: cada minuto hay 25% de estar "en intervención" si está dentro de la ventana
  const pulse = ((seed + d.getHours() * 37 + d.getMinutes() * 13) % 4) === 0;
  const inAuction = open && pulse;
  const tasa = 35.8 + ((seed + min) % 9) / 2 + Math.sin(min / 5) * 0.4; // ~35.8–40.2
  // próxima intervención simulada: en algún minuto futuro de la ventana
  const next = min + 3 + ((seed + min) % 12);
  const nh = String(Math.floor(next / 60) % 24).padStart(2, '0');
  const nm = String(next % 60).padStart(2, '0');
  return { inAuction, tasa: +tasa.toFixed(2), nextAt: `${nh}:${nm}` };
}

/* ------------------------------- REAL engine ------------------------------- */
class AuthError extends Error {}

/* ============================================================================
 * [DEPRECATED] MOTOR ALTERNO bdvdigital (el de la app móvil) — NO USADO
 * ----------------------------------------------------------------------------
 * Las funciones realFetch / realLogin / realRefresh / ensureAuth / realCheckAuction
 * y el payload "REAL" de tick() atacan bdvdigital.banvenez.com con OAuth propio
 * (grant_type=password + credenciales en query string). En las pruebas devolvió
 * 401, por eso el flujo operativo va por el PORTAL (bdvenlinea). Se conservan sin
 * borrar (pueden servir a otro módulo), pero NINGUNA decide la tasa ni opera.
 * ========================================================================== */
async function realFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = bot.token || env.BDV_ACCESS_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Nota: el APK (Flutter/Dio) no usa User-Agent okhttp ni X-MEDIA — esos valores no
  // existen en su binario; no se envían para no afirmar algo que no es del APK.
  const url = /^https?:\/\//i.test(path) ? path : API_BASE + path;
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  if (res.status === 401) throw new AuthError('401 no autorizado — token inválido o expirado');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// OAuth 2.0 password grant — replica EXACTA del APK:
// las credenciales van en la QUERY STRING, no en el body
// /bdvx-oauth-server/oauth/token?grant_type=password&username=<u>&password=<p>
async function realLogin(username, password) {
  const user = username || env.BDV_USERNAME;
  const pass = password || env.BDV_PASSWORD;
  if (!user || !pass) throw new Error('Faltan credenciales — usa el formulario de login o BDV_USERNAME/BDV_PASSWORD en .env');
  log('info', `Iniciando sesión OAuth contra el banco (${user})…`);
  const qs = new URLSearchParams({ grant_type: 'password', username: user, password: pass });
  let res;
  try {
    res = await fetch(`${ENDPOINTS.login}?${qs}`, {
      method: 'POST',
      signal: AbortSignal.timeout(20000) // 20s máx — el banco a veces tarda
    });
  } catch (e) {
    const causa = e && e.cause && e.cause.code ? ` [${e.cause.code}]` : '';
    throw new Error(`No se pudo conectar con el banco${causa}: ${e.message}`);
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`Login HTTP ${res.status}: ${text.slice(0, 250)}`);
  bot.token = json.access_token;
  bot.refreshToken = json.refresh_token || null;
  bot.user = user;
  log('info', '✅ Login OAuth exitoso — token activo');
  return json;
}

// Renovación silenciosa sin pedir clave de nuevo
async function realRefresh() {
  const rt = bot.refreshToken || env.BDV_REFRESH_TOKEN;
  if (!rt) throw new Error('No hay refresh_token (ponlo en .env o usa login con clave)');
  const qs = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt });
  const res = await fetch(`${ENDPOINTS.login}?${qs}`, { method: 'POST' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`Refresh HTTP ${res.status}: ${text.slice(0, 200)}`);
  bot.token = json.access_token;
  bot.refreshToken = json.refresh_token || bot.refreshToken;
  log('info', 'Token renovado por refresh_token');
}

async function ensureAuth() {
  if (bot.token || env.BDV_ACCESS_TOKEN) return;
  try { await realRefresh(); } catch (_) { await realLogin(); }
}

async function realCheckAuction() {
  // Lectura de solo lectura — no modifica nada en el banco
  await ensureAuth();
  try {
    const reglas = await realFetch(ENDPOINTS.reglasEXRI);
    const estado = await realFetch(ENDPOINTS.intervencion);
    return { abierta: !!(estado && estado.intervencionActiva), tasa: reglas && (reglas.tasa || reglas.tasaReferencia), reglas, estado };
  } catch (e) {
    if (e instanceof AuthError) {
      log('warn', 'Token rechazado — reintentando autenticación…');
      bot.token = null;
      await realLogin();
      const reglas = await realFetch(ENDPOINTS.reglasEXRI);
      const estado = await realFetch(ENDPOINTS.intervencion);
      return { abierta: !!(estado && estado.intervencionActiva), tasa: reglas && (reglas.tasa || reglas.tasaReferencia), reglas, estado };
    }
    throw e;
  }
}

/* ------------------- PORTAL WEB (multiplataforma, sin app-key) ------------ */
// Cifrado descifrado del bundle del portal bdvenlinea (AES-256-ECB PKCS7)
const WEB = {
  base: 'https://bdvenlinea.banvenez.com',
  keyReq: 'AZ7552C821266C8255348F726CAB9590',   // jsdjsf()+sklrkjer() — peticiones
  keyResp: 'AD7552C821266C8255348F726CAB2330',   // interceptor — respuestas
  keyData: 'AD7552C821266C8255348F726CAB9589',   // eecrypt — datos personales cifrados
  paths: {
    login: '/oauthaccess/login',
    factores: '/manejoautenticacion/pedir-factores',
    validarFactores: '/manejoautenticacion/validar-factores',
    oauthToken: '/identity/oauth/token',
    reglasEXRI: '/altaintervencioncambiaria/consultarReglasEXRI',
    comprar: '/mesacambiaria/sellbuycurrencyEXCV',
    mercado: '/menudeo/consulta-mercado/'
  }
};
// Descifra los campos personales que el banco envía cifrados (crypt:true)
function decryptWebData(d) {
  const out = {};
  const fields = ['name', 'lastName', 'id', 'idType', 'phone', 'fechaNac', 'lastConnection', 'factor3', 'socialLevel', 'gender', 'nroPersona', 'estatusAct'];
  for (const f of fields) {
    const v = d && d[f];
    if (!v) { out[f] = v; continue; }
    try { out[f] = aesDec(WEB.keyData, v); } catch (_) { out[f] = v; }
  }
  return out;
}
function aesEnc(key, text) {
  const c = crypto.createCipheriv('aes-256-ecb', Buffer.from(key, 'ascii'), null);
  return c.update(text, 'utf8', 'base64') + c.final('base64');
}
function aesDec(key, b64) {
  const d = crypto.createDecipheriv('aes-256-ecb', Buffer.from(key, 'ascii'), null);
  return d.update(b64, 'base64', 'utf8') + d.final('utf8');
}

// Cierra la sesión web activa (para liberar el cupo y poder re-loguear)
async function webLogout() {
  const d = bot.webLoginData && bot.webLoginData.data;
  const tok = d && d.access_token;
  if (!tok) return;
  try {
    const r = await fetch(WEB.base + '/oauthaccess/cerrar', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: (d && d.refresh_token) || '', access_token: tok }),
      signal: AbortSignal.timeout(15000)
    });
    const txt = await r.text().catch(() => '');
    log('info', `Sesión web anterior cerrada (HTTP ${r.status}) ${txt.slice(0, 70)}`);
  } catch (_) {}
  bot.webTicket = null; bot.webLoginData = null; bot.webLoginTs = 0;
}

/* ============================================================================
 * CANDADO ÚNICO DE AUTENTICACIÓN  (UNA CUENTA → UNA SESIÓN → UN LOGIN)
 * ----------------------------------------------------------------------------
 * REGLA: mientras exista una autenticación en curso, NINGUNA otra parte del bot
 * puede iniciar otra. Todas las que necesiten sesión esperan LA MISMA promesa y
 * luego usan ESA MISMA sesión.
 *
 * Antes el candado vivía dentro de webLogin(): protegía el login final pero NO
 * el bloque de renovar-o-loguear, así que cada una de las 4 entradas concurrentes
 * (arranque, renovación 30 s, menudeo 5 min, intervención 30 s) abría SU PROPIO
 * bucle de 12 reintentos → 4 logins simultáneos → el banco devolvía cupo lleno (13)
 * porque el bot se bloqueaba a sí mismo.
 *
 * Ahora el candado envuelve TODO el proceso de autenticación (renovar + reintentos
 * + login). Una sola promesa compartida = un solo login = un solo set de reintentos.
 * ========================================================================== */
let authPromise = null;   // promesa ÚNICA de autenticación en curso (la comparten todos)
let authCount = 0;        // Nº de autenticaciones reales iniciadas (prueba: debe quedarse bajo)
let authEsperas = 0;      // Nº de llamadas que ESPERARON a la autenticación en curso
let webLoginPromise = null; // LOGIN en vuelo (2 pasos). Se comparte y se limpia al terminar.

// Login web en DOS PASOS (flujo exacto del portal bdvenlinea):
//   1) POST /oauthaccess/verificar-usuario-unico {username, mediaHuella, huella} → ticketId
//   2) POST /oauthaccess/login {usoFrecuente, password: AES(clave), ticketId} → codigo "00"
//
// OJO (deadlock): esta función NO debe consultar `authPromise`. Como _autenticarUnaVez()
// (dueño de authPromise) llama a webLogin(), devolver authPromise aquí haría que la
// autenticación se esperara a SÍ MISMA → cuelgue eterno al reintentar. Solo se reutiliza
// el login realmente EN VUELO (webLoginPromise), que se limpia al terminar (éxito o fallo).
async function webLogin(username, password) {
  if (webLoginPromise) { authEsperas++; return webLoginPromise; } // login en curso: se comparte
  webLoginPromise = doWebLogin(username, password).finally(() => { webLoginPromise = null; });
  return webLoginPromise;
}
async function doWebLogin(username, password) {
  const user = (username || env.BDV_USERNAME || '').toUpperCase(); // ¡mayúsculas!
  const pass = password || env.BDV_PASSWORD;
  if (!user || !pass) throw new Error('Faltan credenciales (usuario o clave)');

  // si ya hay una sesión viva, no hace falta volver a loguear
  if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.access_token &&
      bot.webLoginTs && Date.now() - bot.webLoginTs < 150000) {
    log('info', 'Sesión ya activa — omitiendo login');
    return { codigo: '00', ticketId: bot.webTicket, data: bot.webLoginData.data };
  }

  // PASO 1 — verificar usuario único
  log('info', `Login WEB paso 1: verificando usuario ${user}…`);
  const step1Body = JSON.stringify({ username: user, mediaHuella: '', huella: null });
  const r1 = await fetch(WEB.base + '/oauthaccess/verificar-usuario-unico', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: step1Body, signal: AbortSignal.timeout(20000)
  });
  const j1 = await r1.json();
  if (!j1 || !j1.resp) throw new Error(`Paso 1 sin resp (HTTP ${r1.status}): ${JSON.stringify(j1).slice(0, 200)}`);
  const d1 = JSON.parse(aesDec(WEB.keyResp, j1.resp));
  const ticketId = d1.ticketId;
  if (!ticketId) throw new Error(`Paso 1 rechazado (${d1.codigo}): ${d1.descripcion || 'sin ticket'}`);

  // PASO 2 — enviar clave cifrada con el ticket
  log('info', `Login WEB paso 2: enviando clave (ticket ${ticketId})…`);
  const step2Body = JSON.stringify({ usoFrecuente: null, password: aesEnc(WEB.keyReq, pass), ticketId });
  const r2 = await fetch(WEB.base + WEB.paths.login, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: step2Body, signal: AbortSignal.timeout(20000)
  });
  const j2 = await r2.json();
  if (!j2 || !j2.resp) throw new Error(`Paso 2 sin resp (HTTP ${r2.status}): ${JSON.stringify(j2).slice(0, 200)}`);
  const d2 = JSON.parse(aesDec(WEB.keyResp, j2.resp));
  if (d2.codigo !== '00') {
    // si el cupo está lleno por nuestra propia sesión vieja, ciérrala y reintenta una vez
    if (d2.codigo === '13' && !bot._logoutIntentado) {
      bot._logoutIntentado = true;
      log('warn', 'Cupo lleno — cerrando sesión vieja y reintentando…');
      await webLogout();
      const res = await doWebLogin(username, password).finally(() => { bot._logoutIntentado = false; });
      return res;
    }
    throw new Error(`Login web rechazado (${d2.codigo}): ${d2.descripcion}`);
  }
  bot.webTicket = ticketId;
  bot.webUser = user;
  bot.user = user;
  bot.webLoginData = d2; // respuesta íntegra del banco al loguear
  bot.webLoginData.datos = decryptWebData(d2.data); // datos personales descifrados
  bot.webLoginTs = Date.now(); // para renovar el token cuando venza
  // persistir sesión web para no perderla al reiniciar
  try {
    writeFileAtomic(path.join(ROOT, 'web-session.json'), JSON.stringify({ ticketId, user, data: d2, ts: nowIso() }));
  } catch (_) {}
  log('info', '✅ Login WEB exitoso (2 pasos) — ticket ' + ticketId);
  return { codigo: d2.codigo, ticketId, data: d2.data };
}

// Renueva la sesión SIN re-loguear: POST /oauthaccess/actualizar {refresh_token, factor3}
// → devuelve accessToken + refreshToken nuevos (cadena infinita)
async function webRenew() {
  const d = bot.webLoginData && bot.webLoginData.data;
  if (!d || !d.refresh_token || !d.access_token) throw new Error('Sin tokens para renovar');
  const res = await fetch(WEB.base + '/oauthaccess/actualizar', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${d.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: d.refresh_token, factor3: 'true' }),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  if (!json || !json.resp) throw new Error(`Renovación sin resp (HTTP ${res.status})`);
  const dec = JSON.parse(aesDec(WEB.keyResp, json.resp));
  if (dec.codigo !== '00' || !dec.data || !dec.data.accessToken) {
    throw new Error(`Renovación rechazada (${dec.codigo}): ${dec.descripcion}`);
  }
  d.access_token = dec.data.accessToken;
  d.refresh_token = dec.data.refreshToken || d.refresh_token;
  d.expires_in = dec.data.expires_in || '179';
  bot.webLoginTs = Date.now();
  log('info', '✅ Token renovado (actualizar) — sesión extendida');
  return dec.data;
}

// MENUDEO del banco: /menudeo/consulta-mercado/ — referencia informativa.
// Guarda cada sentido por separado (compra/venta · USD/EUR) SIN operadores que
// salten de un sentido económico a otro. Si la respuesta no llega, el estado
// queda 'sin_datos'/'error' y NUNCA se reutiliza el valor anterior como actual.
async function webMercado() {
  const m = tasas.menudeo;
  const r = await webApiFull('/menudeo/consulta-mercado/', 'POST', {}, 20000);
  const d = r.json && r.json.data ? r.json.data : r.json;
  m.httpStatus = r.httpStatus;
  const ventaUSD = parseNumeroBanco(d && d.tasaCambioVentaDolar);
  if (r.ok && d && ventaUSD != null) {
    m.estado = 'ok';
    m.compraUSDTexto = d.tasaCambioCompraDolar ?? null;
    m.ventaUSDTexto = d.tasaCambioVentaDolar ?? null;
    m.compraEURTexto = d.tasaCambioCompraEuro ?? null;
    m.ventaEURTexto = d.tasaCambioVentaEuro ?? null;
    m.compraUSD = parseNumeroBanco(d.tasaCambioCompraDolar);
    m.ventaUSD = ventaUSD;
    m.compraEUR = parseNumeroBanco(d.tasaCambioCompraEuro);
    m.ventaEUR = parseNumeroBanco(d.tasaCambioVentaEuro);
    m.porcentajeComision = d.porcentajeComision ?? null;
    m.montoMaximo = d.montoMaximo ?? null;
    m.montoMinimo = d.montoMinimo ?? null;
    m.horaMinimo = d.horaMinimo ?? null;
    m.horaMaximo = d.horaMaximo ?? null;
    m.numeroTurno = d.numeroTurno ?? null;
    m.estadoPolitica = d.estadoPolitica ?? null;
    // estatusDolar / estatusEuro: estado por divisa que el banco entrega (antes se ignoraba)
    m.divisas.USD.disponible = (d.estatusDolar === undefined || d.estatusDolar === null) ? null : !!d.estatusDolar;
    m.divisas.EUR.disponible = (d.estatusEuro === undefined || d.estatusEuro === null) ? null : !!d.estatusEuro;
    m.timestamp = nowIso();
    m.ageMs = 0;
    m.error = null;
    m.raw = d;
    bot.webMercado = d;                       // espejo histórico (no es la tasa operativa)
    bot.lastTasaTs = Date.now();
    bot.webMercadoDown = false;
    // registro histórico en disco (sólo trazabilidad; NO se usa como tasa operativa)
    try { writeFileAtomic(path.join(ROOT, 'web-tasa.json'), JSON.stringify({ guardada: m.timestamp, tipo: 'historico', mercado: d })); } catch (_) {}
    logTasas('fuente=menudeo');
  } else {
    m.estado = r.httpStatus && !r.ok ? 'error' : 'sin_datos';
    m.error = r.error || (d && (d.descripcion || d.message)) || 'sin datos de menudeo';
    m.timestamp = null;                       // sin dato actual: no hay frescura que reportar
    m.ageMs = null;
    m.compraUSD = m.ventaUSD = m.compraEUR = m.ventaEUR = null;
    m.compraUSDTexto = m.ventaUSDTexto = m.compraEURTexto = m.ventaEURTexto = null;
    m.divisas.USD.disponible = null; m.divisas.EUR.disponible = null;
    log('warn', `[TASA] menudeo sin datos (endpoint=${m.endpoint} httpStatus=${m.httpStatus == null ? '-' : m.httpStatus}): ${m.error}`);
  }
  return m;
}

// Saldo disponible de la cuenta (puede estar en mantenimiento fuera de horario)
async function webSaldo() {
  if (!bot.webCuentas || !bot.webCuentas.length) {
    bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
  }
  const cta = (bot.webCuentas && bot.webCuentas[0] && bot.webCuentas[0].cuenta) || '01020414330000654951';
  const s = await webApi('/consulta-saldo-cuenta-cliente/consulta/saldo', 'POST', { cuentaCliente: cta });
  bot.webSaldo = s;
  if (s && s.data && s.data.saldoDisponible != null) {
    const prev = (bot.webSaldoPrev || null);
    if (prev != null && prev !== s.data.saldoDisponible) {
      log('info', `Saldo actualizado: ${prev} → ${s.data.saldoDisponible} Bs`);
    }
    bot.webSaldoPrev = s.data.saldoDisponible;
  } else if (s && s.message && /no disponible/i.test(s.message)) {
    log('warn', `Saldo: ${s.message}`);
  }
  return s;
}

// Asegura que hay una sesión web fresca (renueva o re-loguea si hace falta).
//
// CANDADO ÚNICO: todo el proceso (decisión + renovación + reintentos + login) está
// envuelto en UNA sola promesa compartida (authPromise). Por tanto:
//   · si ya hay una autenticación en curso, esta llamada ESPERA esa misma promesa
//     y NO inicia otra cosa — operación A, B, C y D cuelgan del MISMO login;
//   · el bucle de reintentos es ÚNICO: no uno por cada llamador.
// Esto es lo que garantiza "1 login · 1 sesión · 1 conjunto de reintentos".
function asegurarSesionWeb() {
  // ¿ya hay una autenticación corriendo? → esperarla (nunca lanzar otra)
  if (authPromise) { authEsperas++; return authPromise; }
  // ¿la sesión actual sigue fresca? → no hay nada que autenticar
  if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.access_token &&
      bot.webLoginTs && Date.now() - bot.webLoginTs <= 150000) {
    return Promise.resolve();
  }
  // Somos el PRIMERO: creamos la promesa única que compartirán todos los demás.
  authCount++;
  authPromise = _autenticarUnaVez()
    .finally(() => { authPromise = null; }); // liberar el candado al terminar
  return authPromise;
}

// Proceso ÚNICO de autenticación: renovar y, si no se puede, re-loguear.
// Vive DENTRO del candado: solo puede haber una instancia en vuelo.
async function _autenticarUnaVez() {
  // 1º intentar RENOVAR (sin re-loguear, mantiene la sesión)
  try {
    if (bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.refresh_token) {
      log('info', 'Token por vencer — renovando sesión…');
      await webRenew();
    } else {
      throw new Error('sin refresh_token');
    }
  } catch (e) {
    // 2º si la renovación falla, re-login completo (con reintentos si el cupo está lleno)
    log('warn', `Renovación no disponible (${e.message}) — re-logueando…`);
    for (let intento = 1; intento <= 12; intento++) {
      try {
        log('info', `Login web (intento ${intento})…`);
        await webLogin(); // usa credenciales del .env (reutiliza el login en curso si lo hay)
        break;
      } catch (e2) {
        if (/13|sesion activa|sesión activa/i.test(e2.message)) {
          log('warn', `Cupo de sesión lleno (13) — reintento en 90 s… (${intento}/12)`);
          await new Promise(r => setTimeout(r, 90000));
          continue;
        }
        throw e2;
      }
    }
  }
  if (!bot.webLoginData || !bot.webLoginData.data || !bot.webLoginData.data.access_token) {
    throw new Error('No se pudo obtener sesión web tras renovación/login');
  }
}
// Petición autenticada al portal (status, endpoint, id de correlación)
// Devuelve {ok, httpStatus, json, endpoint, correlacion, error}. Nunca lanza por HTTP != 2xx.
async function webApiFull(path, method = 'POST', body = undefined, timeoutMs = 20000) {
  const t0 = Date.now();
  const r = await _webApiFullBruto(path, method, body, timeoutMs);
  r.duracionMs = Date.now() - t0;
  return r;
}
async function _webApiFullBruto(path, method = 'POST', body = undefined, timeoutMs = 20000) {
  const endpoint = path;
  const t0 = Date.now();
  let correlacion = null;
  // helper: registra la consulta en el LOG OPERATIVO con la respuesta REAL del banco
  const registrar = (httpStatus, json, error) => {
    const duracionMs = Date.now() - t0;
    const r = (json && !Array.isArray(json)) ? json : {};
    const item0 = Array.isArray(json) ? (json[0] || {}) : r;
    operLog({
      tipo: 'consulta',
      endpoint, metodo: method,
      solicitud: body ? operMaskObj(body) : null,
      httpStatus: httpStatus == null ? null : httpStatus,
      duracionMs,
      timeout: /timeout|aborted/i.test(String(error || '')),
      respuestaCompleta: operMaskObj(json),       // respuesta REAL del banco
      codigo: (item0.code ?? item0.codigo ?? null),
      descripcion: (item0.description ?? item0.descripcion ?? item0.message ?? null),
      reglas: Array.isArray(json) ? json.map((x) => x && x.regla).filter(Boolean) : null,
      correlacion,
      error: error || null
    });
  };
  try {
    await asegurarSesionWeb();
    const tok = bot.webLoginData.data.access_token;
    const res = await fetch(WEB.base + path, {
      method,
      headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const h = res.headers;
    correlacion = h.get('x-correlation-id') || h.get('x-request-id') || h.get('traceparent') || null;
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (_) {}
    // respuesta cifrada del portal
    if (json && json.resp) {
      try { json = JSON.parse(aesDec(WEB.keyResp, json.resp)); }
      catch (e) {
        registrar(res.status, null, `respuesta cifrada ilegible: ${e.message}`);
        return { ok: false, httpStatus: res.status, json: null, endpoint, correlacion, error: `respuesta cifrada ilegible: ${e.message}` };
      }
    }
    if (!res.ok) {
      registrar(res.status, json, `HTTP ${res.status}`);
      return { ok: false, httpStatus: res.status, json, endpoint, correlacion, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    registrar(res.status, json, null);
    return { ok: true, httpStatus: res.status, json, endpoint, correlacion, error: null };
  } catch (e) {
    registrar(null, null, e.message);
    return { ok: false, httpStatus: null, json: null, endpoint, correlacion, error: e.message };
  }
}
// Compatibilidad: devuelve sólo el JSON y lanza si hubo fallo (la usan las consultas)
async function webApi(path, method = 'POST', body = undefined, timeoutMs = 20000) {
  const r = await webApiFull(path, method, body, timeoutMs);
  if (!r.ok) {
    // re-lanzar el error en formato anterior para no cambiar el comportamiento de los llamadores
    if (/^HTTP /.test(r.error || '')) throw new Error(`Web API ${r.error}`);
    throw new Error(r.error || 'fallo de sesión web');
  }
  return r.json;
}

// Consulta de reglas de la intervención EXRI (solo lectura)
async function webReglasEXRI() {
  const reglas = await webApi(WEB.paths.reglasEXRI, 'POST', {});
  return Array.isArray(reglas) ? reglas : (reglas && reglas.data) || reglas;
}

// Estado del mercado de divisas (INTERVENCIÓN): el endpoint que usa la app de Divisas
// Cerrado → code 1001 "Las operaciones cambiarias estarán disponibles más tarde. Intenta luego."
async function webValidarMercado() {
  const r = await webApi('/validar-mercado/validar-subasta', 'GET');
  bot.webMercadoEstado = r;
  return r;
}
/* ---------------------------------------------------------------------------
 * [ELIMINADO] Decisores de tasa DUPLICADOS (los reemplaza la fuente única):
 *   extractInterventionRate() · tasaEXRI() · parseTasa() ·
 *   tasaReferenciaMenudeo() · refreshCodigoRegla() · exriAbierta()
 * Motivo: había dos caminos eligiendo tasa y una cadena
 *   `tasaReferencia || tasaCambioCompraDolar || tasaCambioVentaDolar`
 * que mezclaba mercados distintos y sentidos económicos distintos (compra/venta).
 * Ahora: estadoIntervencionDesdeRespuesta() + actualizarIntervencion() +
 * webMercado() + getTasaOperativa()  →  ÚNICA fuente de verdad.
 * ------------------------------------------------------------------------- */
// [DEPRECATED] Helper genérico para extraer un código de regla de una estructura
// anidada. Ya no se usa (la regla sale de `tasas.intervencion.regla`). Se conserva
// por si otro módulo lo necesita; NO decide ninguna tasa.
function extractCodigoRegla(reglas) {
  const seen = new Set();
  const stack = Array.isArray(reglas) ? [...reglas] : [reglas];
  while (stack.length) {
    const item = stack.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const regla = item.regla || item.codigoRegla;
    if (typeof regla === 'string' && regla.trim().length >= 4) return regla.trim();
    for (const v of Object.values(item)) {
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) stack.push(...v);
        else stack.push(v);
      }
    }
  }
  return null;
}

/* ------------------------------- notificar -------------------------------- */
async function notify(title, msg) {
  if (cfg.notificarWeb) webPushes.push({ title, msg, ts: Date.now() });
  if (cfg.telegram.botToken && cfg.telegram.chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `🤖 ${title}\n${msg}` })
      });
    } catch (e) { log('warn', `Telegram falló: ${e.message}`); }
  }
}
const webPushes = [];

/* ------------------------------- bucle bot -------------------------------- */
// Clasifica la respuesta de una orden SIN FUSIONAR códigos: cada código del banco
// se conserva diferenciado para poder diagnosticar después.
function clasificarRespuestaCompra(cod, message, description) {
  const c = cod == null ? null : String(cod);
  if (c === '00' || c === '1000') return 'aceptada';
  if (c === '500') return 'rechazada_500_sin_motivo_en_cuerpo';
  if (c === '1001') return 'no_disponible_1001';
  if (c === '5000') return 'confirmacion_pendiente_5000';
  if (c == null) return message || description ? 'sin_code_con_mensaje' : 'sin_code_sin_mensaje';
  return `rechazada_code_${c}`;
}
// Mensaje legible por estado — SIN fusionar códigos distintos
function mensajePorEstado(estado, cod, message, description) {
  const detalle = description || message || null;
  switch (estado) {
    case 'rechazada_500_sin_motivo_en_cuerpo':
      return 'El banco respondió code 500 sin mensaje: no explica el motivo en el cuerpo. (No se debitaron fondos)';
    case 'no_disponible_1001':
      return 'El banco indica que las operaciones cambiarias no están disponibles ahora (code 1001). (No se debitaron fondos)';
    case 'no_disponible_1003':
      return 'Sin cupo en este instante (code 1003): "Las operaciones cambiarias estarán disponibles más tarde". La subasta se agota en segundos — reintenta. (No se debitaron fondos)';
    case 'bloqueado_waf':
      return 'El cortafuegos del banco (WAF) bloqueó la petición. Reintenta en unos segundos. (No se debitaron fondos)';
    case 'sin_code_sin_mensaje':
      return 'El banco respondió sin código ni mensaje. (No se debitaron fondos)';
    case 'sin_code_con_mensaje':
      return `El banco respondió sin código, con mensaje: ${detalle}`;
    case 'confirmacion_pendiente_5000':
      return 'El banco dejó la operación en confirmación pendiente (code 5000).';
    default:
      return `El banco rechazó la orden (code ${cod}${detalle ? ': ' + detalle : ''}). (No se debitaron fondos)`;
  }
}
/**
 * COMPRA POR EL CANAL DEL APK (bdvx-*) — motor principal.
 *
 * Es el MISMO motor que usa el botón manual del panel: ambos construyen
 * el payload con apkApi.construirPayload() y lo envían con apkApi.comprar().
 * Así el modo automático y el manual se comportan exactamente igual.
 *
 * Los datos salen de lo que el servidor ya resolvió (cuentas, tasa,
 * regla, actividad, destino de fondos). No se inventa nada.
 */
async function intentarCompraApk() {
  bot._intentoOper = (bot._intentoOper || 0) + 1;

  // --- tasa vigente (EXRI si está abierta; si no, la publicada del banco) ---
  if (!tasas.intervencion.timestamp || edadMs(tasas.intervencion.timestamp) > FRESCURA_INTERVENCION_MS) {
    await actualizarIntervencion();
  }
  const op = getTasaOperativa();
  bot.tasaOperativa = op;

  let tasa = null;
  if (op.disponible) {
    tasa = op.tasa;
    bot.tasaFuente = 'intervencion';
  }
  // La APK no sustituye la tasa de intervención: sin ella no se prepara la orden.
  if (tasa == null) {
    throw new Error(`Sin tasa de intervención — ${op.motivo}. No se usa menudeo ni caché (la APK no lo hace).`);
  }
  bot.tasaActual = tasa;

  // --- regla (dato del banco) ---
  if (!tasas.intervencion.regla) await actualizarIntervencion();
  const codigoRegla = tasas.intervencion.regla || cfg.codigoRegla || 'RGLIC';

  // --- cuentas resueltas ---
  const ctaD = cfg.cuentaDebito || '';
  const ctaU = cfg.cuentaDestino || '';
  if (!ctaD || !ctaU) {
    throw new Error('Faltan las cuentas de débito o destino USD en la configuración');
  }

  // --- payload con el esquema del APK ---
  const payload = apkApi.construirPayload({
    cuentaDebito: ctaD,
    cuentaDestino: ctaU,
    montoMaxUSD: cfg.montoMaxUSD,
    codigoRegla,
    codigoActividadEconomica: cfg.codigoActividadEconomica,
    destinoFondos: cfg.destinoFondos,
    descOcupacion: cfg.descOcupacion,
    jornadaDivisa: cfg.jornadaDivisa,
  }, tasa);

  // --- envío ---
  const r = await apkApi.comprar(payload);
  bot.tasaActual = tasa;

  const cod = r.code != null ? String(r.code) : null;

  if (cod === '1000') {
    return {
      ok: true, tasa, respuesta: { code: cod, message: r.message, data: r.data },
      canal: 'apk', estadoBanco: 'aceptada',
    };
  }

  // 1003 = sin cupo. No es error: la subasta se agota en segundos.
  const estadoBanco =
    cod === '1003' ? 'no_disponible_1003'
      : cod === 'WAF' ? 'bloqueado_waf'
        : clasificarRespuestaCompra(cod, r.message, null);

  bot.ultimaCompra = {
    httpStatus: r.httpStatus, endpoint: apkApi.EP.comprar, canal: 'apk',
    code: cod, estado: estadoBanco, message: r.message,
    timestamp: nowIso(), request: payload,
  };

  return {
    ok: false, tasa, canal: 'apk', estadoBanco,
    respuesta: { code: cod, message: r.message, data: r.data },
  };
}

// Envía la orden de compra real por el portal web (el banco responde si está disponible o no)
async function intentarCompraWeb() {
  // contador de intento (para reconstruir la secuencia en el log operativo)
  bot._intentoOper = (bot._intentoOper || 0) + 1;
  // sesión y tasa actual
  if (!bot.webLoginData || !bot.webLoginData.data || !bot.webLoginData.data.access_token) {
    await webApi('/menudeo/consulta-mercado/', 'POST', {}); // fuerza login/renovación
  }
  // ===================== TASA =====================
  // PRIORIDAD (igual que la versión histórica que SÍ obtenía la tasa):
  //   1) EXRI  → tasa de la intervención publicada por el banco en la consulta de reglas.
  //      Es la ÚNICA fuente. La APK no tiene fallback: si la intervención no publica
  //      tasa, la operación no se puede preparar.
  // Evidencia APK: el modelo `reglas_divisas` (tabla SQL literal en libapp.so) contiene
  // tasaVenta/tasaCompra; NO existe ningún camino de menudeo dentro del flujo de
  // intervención. El menudeo de la APK es OTRO modelo (ResultadoMenudeo con
  // tasaCambioVentaDolar) y OTRO endpoint, y no alimenta esta operación.
  // Nunca se usa caché histórica ni un valor fijo. El banco decide si acepta la orden.
  if (!tasas.intervencion.timestamp || edadMs(tasas.intervencion.timestamp) > FRESCURA_INTERVENCION_MS) {
    await actualizarIntervencion();
  }
  const op = getTasaOperativa();
  bot.tasaOperativa = op;

  let tasa;
  if (op.disponible) {
    // --- EXRI tiene la tasa real de la operación de intervención ---
    tasa = op.tasa;
    bot.tasaFuente = 'intervencion';
    bot.tasaEsOperativaEXRI = true;
    bot.tasaCampo = tasas.intervencion.tasaCampo || 'tasaVenta';
    bot.tasaEdadMs = op.ageMs ?? null;
    if (!bot._exriAbiertaAvise) {
      bot._exriAbiertaAvise = true;
      log('info', `🎯 ¡VENTA DE DIVISAS ABIERTA! tasa ${op.tasaTexto} Bs/USD (regla ${op.regla || '?'}, cupo ${op.cupoPersNaturales != null ? op.cupoPersNaturales : '?'} $, comisión ${op.porcentajeComision != null ? op.porcentajeComision + '%' : '?'}) — enviando orden…`);
      notify('🎯 ¡VENTA DE DIVISAS ABIERTA!', `Tasa de la intervención: ${op.tasaTexto} Bs/USD — el bot está comprando`);
    }
  } else {
    // --- SIN tasa de intervención: NO se opera ---
    // La APK no sustituye esta tasa por la del menudeo ni por ninguna otra:
    // el flujo de intervención no avanza sin su propia tasa. Se espera al próximo ciclo.
    bot._exriAbiertaAvise = false;
    throw new Error(`Sin tasa de intervención — ${op.motivo}. No se usa menudeo ni caché (la APK no lo hace).`);
  }
  // LOG OPERATIVO: detecta y registra cambios de tasa / estado / regla (ANTES → DESPUÉS)
  operDetectarCambios(op, tasas.intervencion);
  // cuentas (débito y destino USD)
  if (!bot.webCuentas || !bot.webCuentas.length) {
    bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
  }
  if (!bot.webCuentasUSD || !bot.webCuentasUSD.length) {
    const r = await webApi('/obtenercuentadivisa/getCuentaDivisa', 'GET');
    bot.webCuentasUSD = (r && r.cuentas) || [];
  }
  const ctaD = cfg.cuentaDebito || (bot.webCuentas[0] && bot.webCuentas[0].cuenta) || '';
  const ctaU = cfg.cuentaDestino || (bot.webCuentasUSD[0] && bot.webCuentasUSD[0].cuenta) || '';

  // VERIFICACIÓN DE SALDO: se compara contra el SUBTOTAL (monto × tasa) porque el
  // importe de la comisión no está verificado contractualmente. Si el servicio de
  // saldo no responde, se continúa (el banco decide).
  const montoUSD = cfg.montoMaxUSD || 0;
  const calc = calcularOperacion(montoUSD, op);
  const necesario = calc.subtotal || 0;
  if (necesario > 0 && ctaD) {
    try {
      if (!bot.webSaldo || !bot.webSaldo.data || Date.now() - (bot._saldoTs || 0) > 30000) {
        const s = await webApi('/consulta-saldo-cuenta-cliente/consulta/saldo', 'POST', { cuentaCliente: ctaD });
        bot.webSaldo = s;
        bot._saldoTs = Date.now();
      }
      const disp = parseNumeroBanco(bot.webSaldo && bot.webSaldo.data && bot.webSaldo.data.saldoDisponible);
      if (disp != null && disp < necesario) {
        bot.saldoInsuficiente = true;
        if (!bot._saldoAvise) {
          bot._saldoAvise = true;
          log('warn', `Saldo insuficiente: ${fmtNumeroBanco(disp, 2)} Bs < ${fmtNumeroBanco(necesario, 2)} Bs (${montoUSD} USD × ${fmtNumeroBanco(tasa, 5)}) — esperando fondos…`);
          notify('Saldo insuficiente', `Para comprar ${montoUSD} USD necesitas ≈${fmtNumeroBanco(necesario, 2)} Bs (sin comisión verificada). Disponible: ${fmtNumeroBanco(disp, 2)} Bs.`);
        }
        throw new Error('Saldo insuficiente — esperando fondos');
      }
      bot.saldoInsuficiente = false;
      bot._saldoAvise = false;
    } catch (e) {
      if (e.message === 'Saldo insuficiente — esperando fondos') throw e;
      // saldo no consultable (servicio caído de madrugada): seguir — el banco decide
    }
  }
  // PAYLOAD según el esquema REAL de la app (OperacionDivisas del APK):
  // {cuentaOrigenBs, cuentaDestino, monto, tasaCambio, codigoRegla, codigoActividadEconomica, ...}
  // El viejo (cuentaDebito/tasa/destinoFondos texto/mercado) era rechazado con code 500 message:null.
  const combo = bot.webCombo || {};
  const act = (combo.actividad || []).find(x => x && x.id === cfg.codigoActividadEconomica);
  const dest = (combo.codigo || []).find(x => x && x.id === cfg.destinoFondos);
  // Los códigos (regla/actividad/destino) son DATOS del banco: si no están, se envían
  // vacíos y el banco decide — no se inventan valores ('RGLIC', '22', '05', 'MAÑANA').
  if (!bot.webCodigoRegla) {
    // sin el código de regla que entrega el banco no se puede construir el payload
    await actualizarIntervencion();
  }
  if (!bot.webCodigoRegla) {
    throw new Error('Sin codigoRegla EXRI del banco — esperando reglas de intervención antes de enviar');
  }
  const payload = {
    cuentaOrigenBs: ctaD,
    cuentaDestino: ctaU,
    monto: String(cfg.montoMaxUSD || 0),
    tasaCambio: String(tasa.toFixed(4)), // tasaReferencia de la intervención (EXRI)
    codigoRegla: bot.webCodigoRegla,
    codigoActividadEconomica: (act && act.id) || '',
    descOcupacion: (act && act.actividadEconomica) || cfg.descOcupacion || '',
    destinoFondos: (dest && dest.id) || ''
  };
  if (cfg.jornadaDivisa) payload.jornadaDivisa = cfg.jornadaDivisa;
  bot.tasaActual = tasa;
  // LOG METICULOSO del envío (cuentas enmascaradas): se registra cuando cambia la
  // tasa o la actividad — no en cada intento (el intervalo puede ser de 1 s)
  const mask = (c) => (c ? '…' + String(c).slice(-4) : '(sin cuenta)');
  if (bot._logTasa !== tasa || bot._logAct !== payload.codigoActividadEconomica) {
    bot._logTasa = tasa;
    bot._logAct = payload.codigoActividadEconomica;
    log('info', `[ORDEN] ${montoUSD} USD @ ${tasa} Bs · fuente tasa=${bot.tasaFuente} · regla ${payload.codigoRegla} · act ${payload.codigoActividadEconomica} · destino fondos ${payload.destinoFondos} · débito ${mask(ctaD)} → USD ${mask(ctaU)}`);
  }
  const env = await webApiFull('/mesacambiaria/sellbuycurrencyEXCV', 'POST', payload, 60000);
  const r = env.json;
  const cod = (r && r.code != null) ? String(r.code) : ((r && r.codigo != null) ? String(r.codigo) : null);
  const msgBanco = (r && r.message != null) ? r.message : null;
  const descBanco = (r && (r.description || r.descripcion)) || null;
  const estadoBanco = clasificarRespuestaCompra(cod, msgBanco, descBanco);
  // Diagnóstico COMPLETO y DIFERENCIADO (nunca fusiona 500 / 1001 / otros códigos)
  log('info', `[BANCO] endpoint=${env.endpoint} httpStatus=${env.httpStatus == null ? '-' : env.httpStatus}` +
    ` code=${cod == null ? 'sin-code' : cod} estado=${estadoBanco}` +
    ` message=${msgBanco == null ? '-' : String(msgBanco).slice(0, 120)}` +
    ` description=${descBanco == null ? '-' : String(descBanco).slice(0, 120)}` +
    ` correlacion=${env.correlacion || '-'} timestamp=${nowIso()}` +
    ` respuesta=${resumenRespuesta(r)}`);
  bot.ultimaCompra = {
    httpStatus: env.httpStatus, endpoint: env.endpoint, code: cod, estado: estadoBanco,
    message: msgBanco, description: descBanco, correlacion: env.correlacion,
    errorTransporte: env.error || null, timestamp: nowIso(),
    request: { montoDivisa: payload.montoDivisa, tasaCambio: payload.tasaCambio, codigoRegla: payload.codigoRegla, codigoActividadEconomica: payload.codigoActividadEconomica, destinoFondos: payload.destinoFondos }
  };
  // LOG OPERATIVO: intento de compra con solicitud enviada y respuesta REAL del banco
  operLog({
    tipo: 'compra',
    endpoint: env.endpoint, metodo: 'POST',
    solicitud: {
      cuentaOrigenBs: maskCuenta(payload.cuentaOrigenBs), cuentaDestinoDivisa: maskCuenta(payload.cuentaDestinoDivisa),
      montoDivisa: payload.montoDivisa, tasaCambio: payload.tasaCambio, codigoRegla: payload.codigoRegla,
      codigoActividadEconomica: payload.codigoActividadEconomica, destinoFondos: payload.destinoFondos
    },
    httpStatus: env.httpStatus,
    duracionMs: env.duracionMs ?? null,
    timeout: /timeout|aborted/i.test(String(env.error || '')),
    respuestaCompleta: operMaskObj(r),
    codigo: cod, descripcion: descBanco || msgBanco || null,
    estadoBanco,
    // --- TASA: el valor EXACTO que viajó en el payload, con su origen ---
    tasaEnviada: payload.tasaCambio,          // literal enviado en sellbuycurrencyEXCV
    tasaVigente: tasa,                        // valor resuelto (sin truncar)
    fuenteTasa: bot.tasaFuente,               // 'intervencion' (única fuente; la APK no usa menudeo)
    campoTasaBanco: bot.tasaCampo || null,
    edadTasaMs: bot.tasaEdadMs ?? null,
    regla: payload.codigoRegla, disponibilidad: op.disponible ? 'ABIERTA' : 'CERRADA',
    operacionId: (r && ((r.data && (r.data.operacionId || r.data.id)) || r.operacionId || r.id)) || null,
    referencia: (r && (r.referencia || r.numeroComprobante)) || null,
    correlacion: env.correlacion, error: env.error || null
  });
  if (estadoBanco === 'aceptada') {
    // PASO DE CONFIRMACIÓN (como el otro bot): si el banco devuelve un id de operación
    // pendiente, se confirma con una segunda llamada (operacionId) — nunca crea otra compra
    const opId = (r && ((r.data && (r.data.operacionId || r.data.operacion || r.data.id || r.data.idOperacion)) || r.operacionId || r.operacion || r.id || r.idOperacion)) || null;
    if (opId && !(r.referencia)) {
      let conf = null;
      for (let i = 0; i < 3; i++) {
        try {
          conf = await webApi('/mesacambiaria/sellbuycurrencyEXCV', 'POST', { ...payload, operacionId: opId }, 60000);
        } catch (_) { conf = null; }
        const cc = conf && (conf.code || conf.codigo);
        if (conf && (cc === '00' || cc === '1000' || conf.referencia)) break;
        await new Promise(res => setTimeout(res, 400)); // reintento rápido de confirmación
      }
      if (conf && conf.code && String(conf.code) !== '5000') {
        return { ok: true, respuesta: conf, tasa, payload };
      }
      // confirmación no concluyente: la orden inicial ya fue aceptada — reportar esa
      return { ok: true, respuesta: r, tasa, payload };
    }
    return { ok: true, respuesta: r, tasa, payload };
  }
  return {
    ok: false, respuesta: r, tasa,
    diagnostico: {
      endpoint: env.endpoint, httpStatus: env.httpStatus, code: cod, estado: estadoBanco,
      message: msgBanco, description: descBanco, correlacion: env.correlacion,
      errorTransporte: env.error || null, timestamp: nowIso()
    }
  };
}

async function tick() {
  if (!bot.running) return;
  if (bot._tickRunning) return; // evitar solapamientos con intervalos rápidos
  bot._tickRunning = true;
  bot.checks++;
  bot.lastCheck = nowIso();

  try {
    if (cfg.mode === 'sim') {
      // SIM: la ventana horaria local define la simulación (aquí no hay banco)
      if (!withinWindow()) {
        bot.status = 'esperando_intervencion';
        const s = simAuctionState();
        bot.nextAuctionAt = s.nextAt;
        bot.tasaActual = s.tasa;
        bot.auctionOpen = false;
        return;
      }
      const s = simAuctionState();
      bot.tasaActual = s.tasa;
      bot.nextAuctionAt = s.nextAt;
      bot.auctionOpen = s.inAuction;
      if (!s.inAuction) { bot.status = 'esperando_intervencion'; return; }
    } else {
      // REAL: el reloj local NO decide si la venta está abierta — lo decide el banco.
      // (Los horarios solo serían datos del banco: horaMinimo/horaMaximo si los entrega.)
      // sin fondos: no enviar hasta que se refresque el saldo (re-chequea cada 30 s)
      if (bot.saldoInsuficiente && Date.now() - (bot._saldoTs || 0) < 30000) {
        bot.status = 'esperando_intervencion';
        return;
      }
      // MODO REAL: enviar la orden.
      //
      // Canal configurable (cfg.canalCompra):
      //   'apk'    → API del APK (bdvx-*)  ← POR DEFECTO
      //   'portal' → portal bdvenlinea (comportamiento antiguo)
      //
      // El canal del APK es el correcto: el portal responde SIEMPRE
      // HTTP 500 sin motivo y nunca refleja si la subasta está abierta.
      bot.status = 'comprando';
      let resp;
      try {
        resp = cfg.canalCompra === 'portal'
          ? await intentarCompraWeb()
          : await intentarCompraApk();
      } catch (e) {
        // sin sesión o error de red: reintentar en el próximo tick
        bot.status = 'esperando_intervencion';
        bot.lastError = e.message;
        bot._rechazos = (bot._rechazos || 0) + 1;
        if (bot._rechazos === 1 || bot._rechazos % 10 === 0) {
          log('warn', `Intento ${bot._rechazos}: no se pudo enviar la orden (${e.message.slice(0, 60)}) — sigo intentando…`);
        }
        return;
      }
      if (resp.ok) {
        // ✅ EL BANCO ACEPTÓ: compra realizada
        bot.auctionOpen = true;
        const r = resp.respuesta || {};
        const ref = r.referencia || r.operacion || r.id || ('WEB-' + Date.now().toString(36).toUpperCase());
        const compra = { fecha: nowIso(), montoUSD: cfg.montoMaxUSD, tasa: resp.tasa, referencia: ref, modo: 'web' };
        bot.compras.unshift(compra);
        if (bot.compras.length > 50) bot.compras.pop();
        bot.lastBuyAt = Date.now(); // 1 compra por intervención
        bot.status = 'comprado';
        log('info', `🎉 ¡COMPRA REALIZADA EXITOSAMENTE! ${compra.montoUSD} USD @ ${resp.tasa} Bs — ID ${ref}`);
        await notify('🎉 ¡COMPRA REALIZADA EXITOSAMENTE!', `${compra.montoUSD} USD a ${resp.tasa} Bs/USD — ID ${ref}`);
        // consultar saldos finales (como el otro bot)
        try {
          const s = await webApi('/consulta-saldo-cuenta-cliente/consulta/saldo', 'POST', { cuentaCliente: cfg.cuentaDebito || '01020414330000654951' });
          bot.webSaldo = s;
          const disp = s && s.data && s.data.saldoDisponible;
          if (disp != null) {
            log('info', `Saldo final VES: ${disp} Bs`);
            notify('Saldo final', `Saldo disponible: ${disp} Bs`);
          }
        } catch (_) {}
        bot.running = false; // detener tras comprar (esperar la próxima intervención)
        clearInterval(bot.timer);
        log('info', '✅ Ciclo finalizado automáticamente con éxito.');
        return;
      }
      // rechazada (intervención no disponible / orden inválida): seguir enviando
      bot.auctionOpen = false;
      bot.status = 'esperando_intervencion';
      bot._rechazos = (bot._rechazos || 0) + 1;
      if (bot._rechazos === 1 || bot._rechazos % 10 === 0) {
        log('info', `Intento ${bot._rechazos}: el banco aún no acepta la orden (venta de divisas no disponible) — sigo enviando…`);
      }
      return;
    }

    // ---- reglas del bot: ¿compra o no? ---- (tasaMax=0 → siempre usar la tasa del banco)
    const tasa = bot.tasaActual;
    if (cfg.tasaMax > 0 && (tasa == null || tasa > cfg.tasaMax)) {
      bot.status = 'esperando_intervencion';
      log('info', `Venta de divisas disponible pero tasa ${tasa} > máximo ${cfg.tasaMax} — no compro`);
      return;
    }
    if (cfg.montoMaxUSD <= 0) { bot.status = 'detenido'; return; }
    // cooldown: una compra por intervención (evita recomprar en cada tick)
    if (bot.lastBuyAt && Date.now() - bot.lastBuyAt < (cfg.cooldownMin || 5) * 60000) {
      bot.status = 'comprado';
      return;
    }

    bot.status = 'comprando';
    log('info', `🎯 VENTA DE DIVISAS DETECTADA — tasa ${tasa} | comprando ${cfg.montoMaxUSD} USD`);

    let ref;
    if (cfg.mode === 'sim') {
      await new Promise(r => setTimeout(r, 1200)); // simula latencia
      ref = 'S-' + Date.now().toString(36).toUpperCase();
      bot.status = 'comprado';
    } else {
      // ---- MODO REAL: contrato a validar (ver README, sección "MODO REAL") ----
      const payload = {
        monto: cfg.montoMaxUSD,
        tasa,
        instrumento: 'EXRI',
        // TODO: completar con los campos exactos que el APK envía.
        // Captura el tráfico real con mitmproxy + Frida para rellenarlos.
      };
      const compra = await realFetch(ENDPOINTS.comprar, { method: 'POST', body: JSON.stringify(payload) });
      const confirm = await realFetch(ENDPOINTS.confirmar, { method: 'POST', body: JSON.stringify({ ...payload, operacionId: compra && compra.id }) });
      ref = (confirm && confirm.referencia) || 'REAL-' + Date.now().toString(36).toUpperCase();
      bot.status = 'comprado';
    }

    const compra = { fecha: nowIso(), montoUSD: cfg.montoMaxUSD, tasa, referencia: ref, modo: cfg.mode };
    bot.compras.unshift(compra);
    if (bot.compras.length > 50) bot.compras.pop();
    bot.lastBuyAt = Date.now(); // cooldown entre compras
    bot.auctionOpen = false;
    log('info', `✅ COMPRA EJECUTADA — ${compra.montoUSD} USD @ ${tasa} Bs/USD — ref ${ref}`);
    await notify('Compra ejecutada', `${compra.montoUSD} USD a ${tasa} Bs/USD — ref ${ref}`);
  } catch (e) {
    bot.status = 'esperando_intervencion';
    bot.lastError = e.message;
    // errores transitorios (servicio caído, red): el bot SIGUE corriendo y reintenta
    bot._rechazos = (bot._rechazos || 0) + 1;
    if (bot._rechazos === 1 || bot._rechazos % 20 === 0) {
      log('warn', `Error transitorio (${e.message.slice(0, 70)}) — sigo intentando (${bot._rechazos})…`);
    }
  } finally {
    bot._tickRunning = false;
  }
}

function startBot() {
  if (bot.running) return;
  bot.running = true;
  bot.status = 'esperando_intervencion';
  bot.simSeed = Math.floor(Date.now() / 60000);
  bot._rechazos = 0;
  // el intervalo REAL aplicado (mismo cálculo que setInterval) para que el log no mienta
  const ivMs = Math.max(100, cfg.intervaloMs || 1000);
  const ivTxt = ivMs >= 1000
    ? (ivMs / 1000).toFixed(ivMs % 1000 === 0 ? 0 : 1).replace('.', ',') + ' s'
    : ivMs + ' ms';
  log('info', `Bot iniciado (modo ${cfg.mode}) — enviando órdenes cada ${ivTxt} hasta que el banco acepte | máx ${cfg.montoMaxUSD} USD`);
  tick();
  bot.timer = setInterval(tick, Math.max(100, cfg.intervaloMs || 1000)); // 0,1 s mínimo
}
function stopBot() {
  bot.running = false;
  bot.status = 'detenido';
  if (bot.timer) clearInterval(bot.timer);
  bot.timer = null;
  log('info', 'Bot detenido');
}

/* ------------------------------- HTTP server ------------------------------ */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // API JSON
  if (p.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (p === '/api/state') {
        // SEGURIDAD: sólo la vista saneada (sin tokens, claves, cuentas completas).
        res.end(JSON.stringify(estadoPanel()));
      } else if (p === '/api/session') {
        // Sólo indica si hay sesión y qué usuario. NUNCA devuelve la contraseña.
        const tokVivo = !!(bot.webLoginData && bot.webLoginData.data && bot.webLoginData.data.access_token &&
          bot.webLoginTs && (Date.now() - bot.webLoginTs) < 200000);
        res.end(JSON.stringify({
          loggedIn: !!(bot.token || env.BDV_ACCESS_TOKEN || tokVivo),
          username: bot.user || env.BDV_USERNAME || '',
          hasSavedPassword: !!env.BDV_PASSWORD
          // SEGURIDAD: la contraseña NUNCA se envía al navegador (el panel puede
          // quedar expuesto por ngrok). Si el campo va vacío, el servidor usa la del .env.
        }));
      } else if (p === '/api/login' && req.method === 'POST') {
        // Login OAuth REAL desde el formulario del panel (localhost → banco)
        let body = ''; for await (const ch of req) body += ch;
        const { username, password, remember } = JSON.parse(body);
        if (!username || !password) { res.end(JSON.stringify({ ok: false, msg: 'Cédula y clave son obligatorias' })); return; }
        log('info', `Intentando login OAuth real para ${username}…`);
        try {
          if (remember) {
            writeEnv('BDV_USERNAME', username);
            writeEnv('BDV_PASSWORD', password);
            log('info', 'Credenciales guardadas en .env (opción recordar)');
          }
          const r = await realLogin(username, password);
          res.end(JSON.stringify({ ok: true, username: (r && r.username) || username }));
        } catch (e) {
          log('error', `Login falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/logout' && req.method === 'POST') {
        bot.token = null; bot.refreshToken = null; bot.user = null;
        log('info', 'Sesión cerrada');
        res.end(JSON.stringify({ ok: true }));
      } else if (p === '/api/logs') {
        // historial persistente: leer el archivo DEL DÍA (sobrevive reinicios) + cola en memoria
        let fileLines = [];
        try {
          const data = fs.readFileSync(rutaLogDiario(), 'utf8');
          fileLines = data.split('\n').filter(Boolean).slice(-500);
        } catch (_) {}
        res.end(JSON.stringify({ logs: fileLines.length >= logs.length ? fileLines : logs }));
      } else if (p === '/api/log-export') {
        // descargar el log del día (para guardar y revisar después — producción/VPS)
        try {
          const data = fs.readFileSync(rutaLogDiario(), 'utf8');
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="bot-${nowIso().slice(0, 10)}.log"`);
          res.end(data);
        } catch (_) { res.statusCode = 404; res.end('sin log todavía'); }
      } else if (p === '/api/cambios') {
        // Modificaciones hechas al bot (config, credenciales, sesión)
        res.end(JSON.stringify({ cambios: histCambios }));
      } else if (p === '/api/pushes') {
        res.end(JSON.stringify({ pushes: webPushes.splice(0, webPushes.length) }));
      } else if (p === '/api/start' && req.method === 'POST') {
        // Inicia el bot con los datos del FORMULARIO de compra (si vienen), no solo la config
        let body = ''; for await (const ch of req) body += ch;
        try {
          const o = body ? JSON.parse(body) : {};
          const cambios = [];
          // normalizar texto del formulario → código del banco (si el combo ya está cargado)
          const combo = bot.webCombo || {};
          const actSel = (combo.actividad || []).find(x => x && (x.id === o.actividadEconomica || (x.actividadEconomica || '').toLowerCase() === String(o.actividadEconomica || '').toLowerCase()));
          const destSel = (combo.codigo || []).find(x => x && (x.id === o.destinoFondos || (x.codigoDestino || '').toLowerCase() === String(o.destinoFondos || '').toLowerCase()));
          if (o.monto) { cfg.montoMaxUSD = parseNumeroBanco(o.monto); cambios.push(`monto=${o.monto} USD`); }
          // las cuentas se resuelven contra las listas REALES del banco (el panel sólo manda la máscara)
          if (o.cuentaDebito) {
            const real = resolverCuenta(o.cuentaDebito, bot.webCuentas) || (bot.webCuentas && bot.webCuentas[0] && bot.webCuentas[0].cuenta) || null;
            if (real) { cfg.cuentaDebito = real; cambios.push(`cta débito ${maskCuenta(real)}`); }
            else log('warn', `[INICIO] no se pudo resolver la cuenta de débito (${o.cuentaDebito})`);
          }
          if (o.cuentaDestino) {
            const real = resolverCuenta(o.cuentaDestino, bot.webCuentasUSD) || (bot.webCuentasUSD && bot.webCuentasUSD[0] && bot.webCuentasUSD[0].cuenta) || null;
            if (real) { cfg.cuentaDestino = real; cambios.push(`cta destino ${maskCuenta(real)}`); }
            else log('warn', `[INICIO] no se pudo resolver la cuenta destino USD (${o.cuentaDestino})`);
          }
          // DESTINO DE FONDOS — el valor CONFIGURADO manda.
          // El panel no debe poder cambiar el destino por el simple hecho de arrancar el
          // ciclo: si el <select> está desajustado (recarga, combo sin cargar, clic
          // accidental) se pisaba cfg.destinoFondos. Regla:
          //   · sin valor en config  → se adopta el que llega (primera configuración)
          //   · con valor en config  → sólo se cambia si viene EXPLÍCITAMENTE en el
          //     arranque del ciclo (campo destinoFondosCambio), que es lo que el usuario
          //     elige a propósito.
          if (o.destinoFondos && destSel && destSel.id) {
            const quiereCambiar = o.destinoFondosCambio === true || o.destinoFondosCambio === 'true';
            if (!cfg.destinoFondos || quiereCambiar) {
              cfg.destinoFondos = destSel.id;
              cambios.push(`destino=${destSel.codigoDestino} (${destSel.id})`);
            } else if (cfg.destinoFondos !== destSel.id) {
              log('info', `[INICIO] el formulario mostraba destino=${destSel.id} pero se CONSERVA el configurado: ${cfg.destinoFondos} (para cambiarlo, elígelo en el formulario)`);
            }
          } else if (o.destinoFondos) {
            log('warn', `[INICIO] destino de fondos no reconocido (${o.destinoFondos}) — se conserva el configurado: ${cfg.destinoFondos}`);
          }
          // ACTIVIDAD ECONÓMICA — misma regla que el destino.
          if (o.actividadEconomica && actSel && actSel.id) {
            const quiereCambiarAct = o.actividadEconomicaCambio === true || o.actividadEconomicaCambio === 'true';
            if (!cfg.codigoActividadEconomica || quiereCambiarAct) {
              cfg.codigoActividadEconomica = actSel.id;
              cambios.push(`actividad=${actSel.actividadEconomica.slice(0, 40)} (${actSel.id})`);
            } else if (cfg.codigoActividadEconomica !== actSel.id) {
              log('info', `[INICIO] el formulario mostraba actividad=${actSel.id} pero se CONSERVA la configurada: ${cfg.codigoActividadEconomica}`);
            }
          } else if (o.actividadEconomica) {
            log('warn', `[INICIO] actividad económica no reconocida (${String(o.actividadEconomica).slice(0, 40)}) — se conserva la configurada: ${cfg.codigoActividadEconomica}`);
          }
          if (o.intervaloMs) { cfg.intervaloMs = parseInt(o.intervaloMs, 10); cambios.push(`intervalo=${o.intervaloMs} ms`); }
          if (cambios.length) {
            try { writeFileAtomic(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2)); } catch (_) {}
            log('info', `Bot iniciado con datos del formulario: ${cambios.join(', ')}`);
          }
        } catch (_) {}
        startBot(); res.end(JSON.stringify({ ok: true }));
      } else if (p === '/api/stop' && req.method === 'POST') {
        stopBot(); res.end(JSON.stringify({ ok: true }));
      } else if (p === '/api/web-cuentas' && req.method === 'POST') {
        // Cuentas reales del cliente. Al panel se le envían ENMASCARADAS (últimos 4
        // dígitos); el servidor conserva los números completos en memoria para operar.
        try {
          const cuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
          bot.webCuentas = cuentas;
          res.end(JSON.stringify({ ok: true, cuentas: (cuentas || []).map(c => ({
            id: String(c.cuenta).slice(-4), mascara: maskCuenta(c.cuenta),
            tipo: c.tipo || null, mancomunada: !!c.mancomunada
          })) }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-saldo' && req.method === 'POST') {
        // Saldo disponible de la cuenta corriente
        try {
          if (!bot.webCuentas || !bot.webCuentas.length) {
            bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
          }
          const s = await webSaldo();
          res.end(JSON.stringify({ ok: true, saldo: s }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-tasa' && req.method === 'POST') {
        // Refresca menudeo + intervención y devuelve el MODELO CENTRAL de tasas.
        // El panel NO decide tasas: sólo pinta lo que devuelve este endpoint.
        try {
          await webMercado();
          await actualizarIntervencion();
          logTasas('fuente=/api/web-tasa');
          res.end(JSON.stringify({ ok: true, tasas: {
            operativa: getTasaOperativa(),
            intervencion: vistaIntervencion(),
            menudeo: vistaMenudeo(),
            historico: tasas.historico
          } }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-cuentas-divisa' && req.method === 'POST') {
        // Cuentas en dólares del cliente (destino) — también enmascaradas al panel
        try {
          const r = await webApi('/obtenercuentadivisa/getCuentaDivisa', 'GET');
          bot.webCuentasUSD = (r && r.cuentas) || [];
          res.end(JSON.stringify({ ok: true, cuentas: bot.webCuentasUSD.map(c => ({
            id: String(c.cuenta).slice(-4), mascara: maskCuenta(c.cuenta), tipo: c.tipo || 'USD'
          })) }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-comprar' && req.method === 'POST') {
        // Ejecuta la orden de compra de divisas (intervención cambiaria — NO es subasta).
        // La TASA la decide SIEMPRE el servidor (getTasaOperativa) y las CUENTAS se
        // resuelven contra las listas reales del banco: lo que envíe el navegador no
        // puede alterar la tasa (así la UI y el backend son exactamente lo mismo).
        let body = ''; for await (const ch of req) body += ch;
        const o = JSON.parse(body);
        try {
          // normalizar al esquema REAL de la app (OperacionDivisas): el frontend manda
          // texto ("Ahorro"), el banco exige el código ("05")
          const combo = bot.webCombo || {};
          const buscaAct = (v) => (combo.actividad || []).find(x => x && (x.id === v || (x.actividadEconomica || '').toLowerCase() === String(v || '').toLowerCase()));
          const buscaDest = (v) => (combo.codigo || []).find(x => x && (x.id === v || (x.codigoDestino || '').toLowerCase() === String(v || '').toLowerCase()));
          const act = buscaAct(o.codigoActividadEconomica || cfg.codigoActividadEconomica) || buscaAct(o.actividadEconomica);
          const dest = buscaDest(o.destinoFondos || cfg.destinoFondos);

          // --- TASA: SOLO la de intervención (la APK no usa menudeo en este flujo) ---
          if (!tasas.intervencion.timestamp || edadMs(tasas.intervencion.timestamp) > FRESCURA_INTERVENCION_MS) {
            await actualizarIntervencion();
          }
          const op = getTasaOperativa();
          // Tasa de la orden: SOLO la de intervención. La APK no sustituye esta tasa
          // por la del menudeo ni por ningún valor cacheado.
          let tasaOp = null, fuenteTasa = null;
          if (op.disponible) {
            tasaOp = op.tasa; fuenteTasa = 'intervencion';
          }
          if (tasaOp == null) {
            log('warn', `Orden NO enviada — sin tasa de intervención: ${op.motivo}`);
            res.end(JSON.stringify({
              ok: false, sinTasaOperativa: true, motivo: op.motivo,
              intervencion: vistaIntervencion(),
              error: `Sin tasa de intervención (${op.motivo}). No se envió ninguna orden. No se usa menudeo (la APK no lo hace).`
            }));
            return;
          }
          if (o.tasaCambio || o.tasa) {
            const enviada = parseNumeroBanco(o.tasaCambio || o.tasa);
            if (enviada == null || Math.abs(enviada - tasaOp) > 0.0001) {
              log('warn', `[ORDEN] la tasa enviada por el panel (${o.tasaCambio || o.tasa}) no coincide con la del servidor (${fmtNumeroBanco(tasaOp, 5)} · ${fuenteTasa}) — se usa la del servidor`);
            }
          }
          // --- REGLA (dato del banco, no constante de la app) ---
          if (!tasas.intervencion.regla) await actualizarIntervencion();
          const codigoRegla = tasas.intervencion.regla || '';
          if (!codigoRegla) {
            log('warn', 'Orden no enviada: el banco no entregó codigoRegla de intervención');
            res.end(JSON.stringify({ ok: false, error: 'Sin codigoRegla de intervención del banco — espera a que el banco entregue las reglas. (No se envió la orden)' }));
            return;
          }
          // --- CUENTAS: se resuelven en el servidor (el panel sólo conoce la máscara) ---
          if (!bot.webCuentas || !bot.webCuentas.length) {
            bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
          }
          if (!bot.webCuentasUSD || !bot.webCuentasUSD.length) {
            const rr = await webApi('/obtenercuentadivisa/getCuentaDivisa', 'GET');
            bot.webCuentasUSD = (rr && rr.cuentas) || [];
          }
          const ctaD = resolverCuenta(o.cuentaOrigenBs || o.cuentaOrigen || o.cuentaDebito, bot.webCuentas)
            || cfg.cuentaDebito || (bot.webCuentas[0] && bot.webCuentas[0].cuenta) || '';
          const ctaU = resolverCuenta(o.cuentaDestino, bot.webCuentasUSD)
            || cfg.cuentaDestino || (bot.webCuentasUSD[0] && bot.webCuentasUSD[0].cuenta) || '';
          if (!ctaD || !ctaU) {
            res.end(JSON.stringify({ ok: false, error: 'No se pudo resolver la cuenta de débito o la cuenta destino USD. (No se envió la orden)' }));
            return;
          }
          const monto = parseNumeroBanco(o.monto);
          if (monto == null || monto <= 0) {
            res.end(JSON.stringify({ ok: false, error: 'Monto inválido. (No se envió la orden)' }));
            return;
          }
          // componentes separados: montoDivisa · tasa · subtotal · comisión · total
          const calc = calcularOperacion(monto, op);
          const payload = {
            cuentaOrigenBs: ctaD,
            cuentaDestino: ctaU,
            monto: String(monto),
            tasaCambio: String(tasaOp),          // tasa de la intervención (única fuente del flujo APK)
            codigoRegla,
            codigoActividadEconomica: (act && act.id) || '',
            descOcupacion: (act && act.actividadEconomica) || o.descOcupacion || '',
            destinoFondos: (dest && dest.id) || ''
          };
          if (o.jornadaDivisa || cfg.jornadaDivisa) payload.jornadaDivisa = o.jornadaDivisa || cfg.jornadaDivisa;
          log('info', `[ORDEN] manual: ${monto} USD × ${fmtNumeroBanco(tasaOp, 5)} Bs (regla ${codigoRegla}) · débito ${maskCuenta(ctaD)} → USD ${maskCuenta(ctaU)} · fuenteTasa=${fuenteTasa}${op.disponible ? ' ' + op.edadTexto : ''}`);

          /* ============================================================
             MOTOR: CANAL DEL APK (bdvx-*)
             ------------------------------------------------------------
             El MISMO formulario y el MISMO payload de siempre, pero
             enviados por la API del APK en vez del portal.

             ¿Por qué? El portal (/mesacambiaria/sellbuycurrencyEXCV)
             devuelve SIEMPRE HTTP 500 sin motivo y nunca refleja si la
             subasta está abierta. La API del APK sí lo refleja.

             Los 6 campos del formulario (cuentas, monto, regla,
             actividad, destino de fondos) se transforman al esquema
             OperacionDivisas que espera la API nueva. No se inventa
             ningún dato: se reutiliza lo que ya resolvió el servidor.
             ============================================================ */
          const payloadApk = apkApi.construirPayload({
            cuentaDebito: ctaD,
            cuentaDestino: ctaU,
            montoMaxUSD: monto,
            codigoRegla,
            codigoActividadEconomica: (act && act.id) || cfg.codigoActividadEconomica,
            destinoFondos: (dest && dest.id) || cfg.destinoFondos,
            descOcupacion: (act && act.actividadEconomica) || o.descOcupacion || '',
            jornadaDivisa: payload.jornadaDivisa,
          }, tasaOp);

          const env = await apkApi.comprar(payloadApk);
          const cod = env.code != null ? String(env.code) : null;
          const msgBanco = env.message ?? null;
          const respBanco = { code: cod, message: msgBanco, data: env.data };

          // Traduce el código de la API del APK al vocabulario que ya
          // usa el panel, para que la interfaz muestre lo mismo.
          const estadoBanco =
            cod === '1000' ? 'aceptada'
              : cod === '1003' ? 'no_disponible_1003'
                : cod === 'WAF' ? 'bloqueado_waf'
                  : clasificarRespuestaCompra(cod, msgBanco, null);

          log('info', `[BANCO-APK] endpoint=${apkApi.EP.comprar} httpStatus=${env.httpStatus == null ? '-' : env.httpStatus}` +
            ` code=${cod == null ? 'sin-code' : cod} estado=${estadoBanco}` +
            ` message=${msgBanco == null ? '-' : String(msgBanco).slice(0, 120)}` +
            ` ms=${env.ms ?? '-'} respuesta=${JSON.stringify(respBanco).slice(0, 300)}`);

          bot.ultimaCompra = {
            httpStatus: env.httpStatus, endpoint: apkApi.EP.comprar, canal: 'apk',
            code: cod, estado: estadoBanco,
            message: msgBanco, description: null, correlacion: null,
            errorTransporte: env.waf ? 'WAF' : (env.code === 'ERR' ? msgBanco : null),
            timestamp: nowIso(),
            request: {
              monto: payloadApk.monto, tasaCambio: payloadApk.tasaCambio,
              codigoRegla: payloadApk.codigoRegla,
              codigoActividadEconomica: payloadApk.codigoActividadEconomica,
              destinoFondos: payloadApk.destinoFondos,
            }
          };

          // Evidencia en disco (para reconstruir el flujo si compra)
          try {
            fs.appendFileSync(path.join(__dirname, 'logs', 'apk-compras.jsonl'),
              JSON.stringify({
                ts: nowIso(), origen: 'formulario-web', canal: 'apk',
                payload: payloadApk, httpStatus: env.httpStatus,
                code: cod, message: msgBanco, estado: estadoBanco,
                respuesta: respBanco, ms: env.ms ?? null,
              }) + '\n');
          } catch (_) { /* seguir */ }

          const aceptada = estadoBanco === 'aceptada';
          if (aceptada) {
            log('info', `🎉 COMPRA ACEPTADA por el banco (canal APK): ${JSON.stringify(respBanco)}`);
            notify('Compra aceptada', `Orden de ${monto} USD procesada por el banco`);
          }
          res.end(JSON.stringify({
            ok: aceptada, respuesta: respBanco, estadoBanco, canal: 'apk',
            operacion: { ...calc, tasaTexto: op.tasaTexto, regla: codigoRegla, origenTasa: op.origen, edadTasa: op.edadTexto },
            diagnostico: {
              endpoint: apkApi.EP.comprar, canal: 'apk',
              httpStatus: env.httpStatus, code: cod, estado: estadoBanco,
              message: msgBanco, description: null, correlacion: null,
              errorTransporte: env.waf ? 'WAF' : (env.code === 'ERR' ? msgBanco : null),
              ms: env.ms ?? null, timestamp: nowIso(),
            },
            error: aceptada ? undefined : mensajePorEstado(estadoBanco, cod, msgBanco, null)
          }));
        } catch (e) {
          log('error', `Compra falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-movimientos' && req.method === 'POST') {
        // Movimientos de la cuenta (historial HOY/AYER como la app)
        try {
          if (!bot.webCuentas || !bot.webCuentas.length) {
            bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
          }
          const cta = cfg.cuentaDebito || (bot.webCuentas[0] && bot.webCuentas[0].cuenta) || '';
          if (!cta) {
            res.end(JSON.stringify({ ok: false, error: 'Todavía no hay una cuenta cargada del banco' }));
            return;
          }
          const movs = await webApi('/picconsultamovimientos/queryLastMovements', 'POST', {
            cuentaCliente: cta, divisa: 'VES', fechaInicio: '', fechaFin: '',
            movimientoInicial: '', movimientoFinal: '', tipoRegistro: ''
          });
          bot.webMovimientos = movs;
          const n = Array.isArray(movs) ? movs.length : 0;
          if (n !== bot.webMovimientosPrev) log('info', `Movimientos consultados: ${n} operaciones`);
          bot.webMovimientosPrev = n;
          res.end(JSON.stringify({ ok: true, movimientos: movs }));
        } catch (e) {
          log('error', `Movimientos falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if ((p === '/api/web-subasta' || p === '/api/web-intervencion') && req.method === 'POST') {
        // Estado REAL de la INTERVENCIÓN (Divisas). Devuelve el MODELO CENTRAL:
        // el panel no decide nada, sólo pinta lo que hay aquí.
        try {
          const t = await actualizarIntervencion();
          logTasas('fuente=/api/web-intervencion');
          res.end(JSON.stringify({
            ok: true,
            operativa: getTasaOperativa(),
            intervencion: vistaIntervencion(),
            menudeo: vistaMenudeo(),
            contrato: t.contrato
          }));
        } catch (e) {
          log('error', `Consulta intervención web falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-debug' && req.method === 'POST') {
        // SEGURIDAD: era un proxy que ejecutaba {path, method, body} arbitrarios con el
        // token vivo. El proxy fue ELIMINADO: ahora sólo devuelve el estado interno de
        // tasas + la última respuesta registrada (diagnóstico sin tocar al banco).
        res.end(JSON.stringify({
          ok: true,
          nota: 'proxy arbitrario eliminado (ya no acepta path/method/body)',
          tasas: { operativa: getTasaOperativa(), intervencion: vistaIntervencion(), menudeo: vistaMenudeo() },
          ultimaRespuestaIntervencion: resumenRespuesta(tasas.intervencion.raw, 600),
          ultimaCompra: bot.ultimaCompra || null
        }));
      } else if (p === '/api/web-combo' && req.method === 'POST') {
        // Combo de actividad económica + destino de fondos (los CÓDIGOS que exige el payload de compra)
        try {
          const r = await webApi('/altaintervencioncambiaria/obtenerDataCombo', 'GET');
          bot.webCombo = r && r.data ? r.data : r;
          res.end(JSON.stringify({ ok: true, data: bot.webCombo }));
        } catch (e) {
          log('error', `Combo falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-renew' && req.method === 'POST') {
        // Renueva la sesión — pasa por el CANDADO ÚNICO (antes llamaba a webRenew()
        // directamente y podía solaparse con las autenticaciones automáticas).
        try {
          await asegurarSesionWeb();
          const d = bot.webLoginData && bot.webLoginData.data;
          res.end(JSON.stringify({ ok: true, expires_in: (d && d.expires_in) || '179' }));
        } catch (e) {
          log('warn', `Renovación manual falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/web-logout' && req.method === 'POST') {
        await webLogout();
        try { fs.unlinkSync(path.join(ROOT, 'web-session.json')); } catch (_) {}
        log('info', 'Sesión web cerrada por el usuario');
        res.end(JSON.stringify({ ok: true }));
      } else if (p === '/api/login-web' && req.method === 'POST') {
        // Login por el PORTAL WEB (multiplataforma, sin app-key)
        let body = ''; for await (const ch of req) body += ch;
        const { username, password, remember } = JSON.parse(body);
        try {
          if (remember && username && password) {
            writeEnv('BDV_USERNAME', username.trim());
            writeEnv('BDV_PASSWORD', password);
            log('info', 'Credenciales guardadas en .env (opción recordar)');
          }
          const dec = await webLogin(username, password);
          res.end(JSON.stringify({ ok: true, ticketId: dec.ticketId, descripcion: dec.descripcion }));
        } catch (e) {
          log('error', `Login WEB falló: ${e.message}`);
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/login-test' && req.method === 'POST') {
        // Prueba SOLO el login OAuth real (no consulta ni compra nada)
        if (cfg.mode !== 'real') { res.end(JSON.stringify({ ok: false, msg: 'Activa MODO REAL en la configuración para probar el login' })); return; }
        log('info', 'Prueba de login real solicitada…');
        try {
          if (env.BDV_USERNAME && env.BDV_PASSWORD) {
            bot.token = null;
            await realLogin();
            res.end(JSON.stringify({ ok: true, metodo: 'login con usuario/clave' }));
          } else if (bot.refreshToken || env.BDV_REFRESH_TOKEN) {
            bot.token = null;
            await realRefresh();
            res.end(JSON.stringify({ ok: true, metodo: 'refresh_token' }));
          } else if (env.BDV_ACCESS_TOKEN) {
            res.end(JSON.stringify({ ok: true, metodo: 'access_token ya configurado — usa "Probar conexión real" para validarlo' }));
          } else {
            res.end(JSON.stringify({ ok: false, msg: 'No hay credenciales: llena BDV_USERNAME/BDV_PASSWORD o los tokens en .env' }));
          }
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (p === '/api/test' && req.method === 'POST') {
        // Prueba de conexión (solo lectura) contra el banco — no compra nada
        if (cfg.mode !== 'real') { res.end(JSON.stringify({ ok: false, msg: 'Activa MODO REAL en la configuración para probar la conexión' })); return; }
        log('info', 'Prueba de conexión real solicitada…');
        const r = await realCheckAuction();
        res.end(JSON.stringify({ ok: true, abierta: r.abierta, tasa: r.tasa, reglas: r.reglas, estado: r.estado }));
      } else if (p.startsWith('/api/apk-') && req.method === 'POST') {
        /* ============================================================
           CANAL DEL APK — bdvdigital.banvenez.com
           ------------------------------------------------------------
           El portal (bdvenlinea) responde SIEMPRE code=01 y nunca refleja
           si la subasta está abierta. El APK usa otra API (bdvx-*) que sí
           devuelve el estado real. Estos endpoints exponen ese canal a la
           web para el modo MANUAL, sin depender de nada externo.
           ============================================================ */
        let body = '';
        for await (const ch of req) body += ch;
        let o = {};
        try { o = body ? JSON.parse(body) : {}; } catch (_) { o = {}; }

        if (p === '/api/apk-estado') {
          // Estado completo por el canal del APK (1000 / 1003 / …)
          const st = await apkApi.estadoCompleto();
          res.end(JSON.stringify({ ok: true, ...st }));
        } else if (p === '/api/apk-actividades') {
          const r = await apkApi.actividades();
          res.end(JSON.stringify({ ok: true, code: r.code, data: r.data, message: r.message }));
        } else if (p === '/api/apk-reglas') {
          const r = await apkApi.reglas(o.tipoRegla || 'COMPRA');
          res.end(JSON.stringify({ ok: true, code: r.code, data: r.data, message: r.message }));
        } else if (p === '/api/apk-oficinas') {
          const r = await apkApi.oficinas();
          res.end(JSON.stringify({ ok: true, code: r.code, data: r.data, message: r.message }));
        } else if (p === '/api/apk-estados') {
          const r = await apkApi.estados();
          res.end(JSON.stringify({ ok: true, code: r.code, data: r.data, message: r.message }));
        } else if (p === '/api/apk-comprar') {
          // COMPRA MANUAL por el canal del APK.
          // El monto/cuentas salen de la configuración o del formulario.
          const cfgCompra = {
            ...cfg,
            montoMaxUSD: o.monto ?? cfg.montoMaxUSD,
            cuentaDebito: o.cuentaDebito || cfg.cuentaDebito,
            cuentaDestino: o.cuentaDestino || cfg.cuentaDestino,
            codigoActividadEconomica: o.codigoActividadEconomica || cfg.codigoActividadEconomica,
            destinoFondos: o.destinoFondos || cfg.destinoFondos,
          };
          const tasa = o.tasa != null ? Number(o.tasa) : null;
          const hilos = Number(o.hilos || 1);
          log('info', `[APK] COMPRA MANUAL solicitada: ${cfgCompra.montoMaxUSD} USD · ${hilos} hilo(s)`);
          const r = await apkApi.comprarCompleto(cfgCompra, tasa, hilos);
          res.end(JSON.stringify({ ok: true, ...r }));
        } else if (p === '/api/apk-raw') {
          // Llamada cruda a cualquier endpoint del APK (diagnóstico).
          const r = await apkApi.llamar(o.url, o.payload || {});
          res.end(JSON.stringify({ ok: true, ...r }));
        } else {
          res.statusCode = 404; res.end(JSON.stringify({ error: 'endpoint apk no existe' }));
        }
      } else if (p === '/api/config' && req.method === 'POST') {
        let body = ''; for await (const ch of req) body += ch;
        const next = JSON.parse(body);
        const cambios = [];
        for (const k of ['mode', 'cedula', 'montoMaxUSD', 'tasaMax', 'ventanaInicio', 'ventanaFin', 'intervaloMs', 'notificarWeb', 'autoRenew']) {
          if (k in next && String(cfg[k]) !== String(next[k])) cambios.push(`${k}: ${cfg[k]} → ${next[k]}`);
        }
        cfg = { ...cfg, ...next, telegram: { ...cfg.telegram, ...(next.telegram || {}) } };
        saveConfig(cfg);
        log('info', 'Configuración guardada' + (cambios.length ? ': ' + cambios.join(', ') : ' (sin cambios)'));
        res.end(JSON.stringify({ ok: true, cfg }));
      } else {
        res.statusCode = 404; res.end(JSON.stringify({ error: 'no existe' }));
      }
    } catch (e) {
      res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // estáticos
  let file = path.join(PUBLIC, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; res.end('forbidden'); return; }
  try {
    const data = fs.readFileSync(file);
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store'); // siempre servir la versión más nueva del panel
    res.end(data);
  } catch (_) { res.statusCode = 404; res.end('no encontrado'); }
});

// ============================================================================
// Separación de fuentes: DETECCIÓN (APK) vs SESIÓN WEB (legacy).
//
// La detección de disponibilidad usa EXCLUSIVAMENTE el canal APK
// (apkApi.estadoCompra → reglas/compra → code 1000). NO depende de la sesión
// WEB ni del login del portal. Arranca por sí sola y consulta el endpoint APK
// con el token APK (BDV_ACCESS_TOKEN / token-apk.json), sin tocar bdvenlinea.
//
// La sesión WEB (webLogin/asegurarSesionWeb/web-session.json) queda AISLADA:
// solo se usa si se invoca explícitamente el login del portal vía REST, NO en
// el arranque automático. Sirve únicamente como LEGACY mientras el login APK
// (app-key/secret runtime) no esté disponible.
// ============================================================================
// Estado de la INTERVENCIÓN al iniciar (canal APK — fuente única). No requiere sesión web.
setTimeout(async () => {
  try {
    const t = await actualizarIntervencion();
    const op = getTasaOperativa();
    if (op.disponible) log('info', `🎯 ¡VENTA DE DIVISAS ABIERTA al iniciar! tasa ${op.tasaTexto} Bs/USD (regla ${op.regla || '?'})`);
    else log('info', `Intervención ${t.estado} ahora (${op.motivo}) — vigilando…`);
    logTasas('fuente=arranque');
  } catch (_) {}
}, 1500);

// HISTÓRICO: web-tasa.json es SÓLO un registro visual. NUNCA se usa como tasa
// operativa ni como tasa "actual": la tasa operativa únicamente puede salir de una
// respuesta del banco obtenida en ESTA sesión (getTasaOperativa).
try {
  const wt = JSON.parse(fs.readFileSync(path.join(ROOT, 'web-tasa.json'), 'utf8'));
  if (wt && wt.mercado) {
    tasas.historico = {
      guardada: wt.guardada || null,
      tipo: wt.tipo || 'historico',
      ventaUSDTexto: wt.mercado.tasaCambioVentaDolar || null,
      compraUSDTexto: wt.mercado.tasaCambioCompraDolar || null,
      nota: 'HISTÓRICO — no es tasa operativa ni dato de la sesión actual'
    };
    log('info', `Histórico de tasa cargado (SOLO visual, NO operativo): ${wt.guardada || '?'} · venta USD ${wt.mercado.tasaCambioVentaDolar || '?'}`);
  }
} catch (_) {}

// RENOVACIÓN AUTOMÁTICA DEL SERVIDOR (cada 30 s revisa; renueva si el token tiene >2 min)
// Solo si cfg.autoRenew está activado (botón "mantener sesión" en Configuración)
// RENOVACIÓN AUTOMÁTICA: pasa por el CANDADO ÚNICO (asegurarSesionWeb).
// Antes llamaba a webRenew() directamente, esquivando el candado: ese era uno de los
// 4 caminos que provocaban logins paralelos. Ahora, si ya hay una autenticación en
// curso, esta espera esa misma promesa en vez de abrir su propio ciclo.
if (process.env.BDV_MONITOR_ONLY !== 'true') setInterval(async () => {
  if (cfg.autoRenew === false) return; // renovación desactivada por el usuario
  const d = bot.webLoginData && bot.webLoginData.data;
  if (!d || !d.refresh_token || !bot.webLoginTs) return;
  const edad = Date.now() - bot.webLoginTs;
  if (edad > 120000 && edad < 600000) { // >2 min: renovar (muy viejo: mejor reloguear)
    try { await asegurarSesionWeb(); }   // ← candado único (no webRenew directo)
    catch (e) { log('warn', `Renovación automática falló: ${e.message}`); }
  }
}, 30000);

// TASA DEL BANCO EN VIVO (menudeo — referencia aparte): refrescar cada 5 min
if (process.env.BDV_MONITOR_ONLY !== 'true') setInterval(async () => {
  if (!bot.webLoginData || !bot.webLoginData.data) return;
  try { await webMercado(); }
  catch (_) {}
}, 300000);

// INTERVENCIÓN: refrescar estado + tasa cada 30 s AUNQUE el bot no esté corriendo.
// Así el panel refleja el estado real del canal APK en cuanto el banco publica 1000.
// La detección ya NO depende de la sesión del portal: usa el canal APK (token propio).
if (process.env.BDV_MONITOR_ONLY !== 'true') setInterval(async () => {
  if (!apkApi.leerToken()) return;   // sin token: no hay nada que consultar
  const antes = tasas.intervencion.estado;
  try {
    const t = await actualizarIntervencion();
    if (t.estado !== antes) {
      if (t.abierta) log('info', `🎯 ¡VENTA DE DIVISAS ABIERTA! tasa ${t.tasaTexto || '?'} Bs/USD (regla ${t.regla || '?'}, cupo ${t.cupoPersNaturales != null ? t.cupoPersNaturales : '?'} $, comisión ${t.porcentajeComision != null ? t.porcentajeComision + '%' : '?'})`);
      else log('info', `Venta de divisas: ${t.estado} — vigilando…`);
    }
    logTasas('fuente=intervalo-30s');
  } catch (_) {}
}, 30000);

// ============================================================================
// MODO MONITOR (BDV_MONITOR_ONLY=true)
// ----------------------------------------------------------------------------
// Cuando el monitor de CMD (monitor.js) carga este archivo, NO se abre el
// servidor web: se exporta la API interna para que el monitor use EXACTAMENTE
// las mismas funciones que producen las respuestas reales del banco.
// ============================================================================
if (process.env.BDV_MONITOR_ONLY === 'true') {
  module.exports = {
    __monitorApi: {
      cfg,
      // --- sesión (misma autenticación/candado único del proyecto) ---
      preparar: async () => {
        try {
          await asegurarSesionWeb();
          await actualizarIntervencion();
          await webMercado();
          // cuentas y combo (datos que exige el payload)
          try {
            if (!bot.webCuentas || !bot.webCuentas.length) {
              bot.webCuentas = await webApi('/consultasaldocuenta/consultaCuentas', 'GET');
            }
            if (!bot.webCuentasUSD || !bot.webCuentasUSD.length) {
              const r = await webApi('/obtenercuentadivisa/getCuentaDivisa', 'GET');
              bot.webCuentasUSD = (r && r.cuentas) || [];
            }
            if (!bot.webCombo) {
              const r = await webApi('/altaintervencioncambiaria/obtenerDataCombo', 'GET');
              bot.webCombo = r && r.data ? r.data : r;
            }
            const s = await webApi('/consulta-saldo-cuenta-cliente/consulta/saldo', 'POST',
              { cuentaCliente: cfg.cuentaDebito });
            bot.webSaldo = s; bot._saldoTs = Date.now();
          } catch (_) {}
          return true;
        } catch (e) {
          log('error', `[MONITOR] no se pudo preparar la sesión: ${e.message}`);
          return false;
        }
      },
      sesionViva: () => !!(bot.webLoginData && bot.webLoginData.data
        && bot.webLoginData.data.access_token
        && bot.webLoginData.data.access_token !== 'expirado'),
      saldoDisponible: () => parseNumeroBanco(bot.webSaldo && bot.webSaldo.data
        && bot.webSaldo.data.saldoDisponible),
      codigoRegla: () => bot.webCodigoRegla || null,

      // --- consulta de detección por el canal APK (code === '1000') ---
      consultarTodo: async () => {
        const t = await actualizarIntervencion();   // canal APK (reglas/compra)
        const st = { code: t.code, estado: t.estado, abierta: t.abierta, regla: t.regla,
          description: t.description, tasaReferencia: t.tasa ?? null, tasaTexto: t.tasaTexto,
          tasaCampo: tasas.intervencion.tasaCampo, cupoPersNaturales: t.cupoPersNaturales,
          porcentajeComision: t.porcentajeComision, senalApertura: t.senalApertura,
          senalCierre: t.senalCierre, items: (t.raw && t.raw.data ? 1 : 0), raw: t.raw };
        const m = tasas.menudeo;

        return {
          exri: {
            code: st.code, estado: st.estado, abierta: st.abierta,
            description: st.description, regla: st.regla,
            tasaReferencia: st.tasaReferencia, tasaTexto: st.tasaTexto, tasaCampo: st.tasaCampo,
            cupoPersNaturales: st.cupoPersNaturales, porcentajeComision: st.porcentajeComision,
            senalApertura: st.senalApertura, senalCierre: st.senalCierre,
            dataEsNull: !(t.raw && t.raw.data != null),
            items: st.items, raw: st.raw,
          },
          subasta: null,   // ya no se consulta validar-subasta (portal)
          mercado: {
            estadoPolitica: m.estadoPolitica ?? null,
            ventaUSDTexto: m.ventaUSDTexto ?? null,
            compraUSDTexto: m.compraUSDTexto ?? null,
            ventaUSD: m.ventaUSD ?? null, compraUSD: m.compraUSD ?? null,
            ventaEURTexto: m.ventaEURTexto ?? null, compraEURTexto: m.compraEURTexto ?? null,
            porcentajeComision: m.porcentajeComision ?? null,
            httpStatus: m.httpStatus ?? null, timestamp: m.timestamp ?? null,
          },
        };
      },

      // --- compra: MISMA función del proyecto (mismo endpoint/payload) ---
      construirPayload: (tasa) => {
        const ctaD = cfg.cuentaDebito || (bot.webCuentas && bot.webCuentas[0] && bot.webCuentas[0].cuenta) || '';
        const ctaU = cfg.cuentaDestino || (bot.webCuentasUSD && bot.webCuentasUSD[0] && bot.webCuentasUSD[0].cuenta) || '';
        if (!ctaD || !ctaU) return null;
        const combo = bot.webCombo || {};
        const act = (combo.actividad || []).find((x) => x && x.id === cfg.codigoActividadEconomica);
        const dest = (combo.codigo || []).find((x) => x && x.id === cfg.destinoFondos);
        const op = { tasa };
        const regla = bot.webCodigoRegla;
        if (!regla) return null;
        return construirPayloadOrden({ ctaD, ctaU, monto: cfg.montoMaxUSD, op, regla, act, dest });
      },

      ejecutarCompra: async (payload) => {
        const env = await webApiFull(WEB.paths.comprar, 'POST', payload, 60000);
        const r = env.json;
        const cod = (r && r.code != null) ? String(r.code) : ((r && r.codigo != null) ? String(r.codigo) : null);
        const msg = (r && r.message != null) ? r.message : null;
        const desc = (r && (r.description || r.descripcion)) || null;
        const estadoBanco = clasificarRespuestaCompra(cod, msg, desc);

        // confirmación (misma lógica del proyecto) si el banco devuelve operacionId
        let confirmacion = null;
        if (estadoBanco === 'aceptada') {
          const opId = (r && ((r.data && (r.data.operacionId || r.data.operacion || r.data.id)) || r.operacionId)) || null;
          if (opId) {
            try {
              confirmacion = await webApi(WEB.paths.comprar, 'POST', { ...payload, operacionId: opId }, 60000);
            } catch (_) {}
          }
        }

        return {
          httpStatus: env.httpStatus, codigo: cod, message: msg, descripcion: desc,
          estadoBanco, json: r, correlacion: env.correlacion, error: env.error || null,
          operacionId: (r && ((r.data && (r.data.operacionId || r.data.id)) || r.operacionId || r.id)) || null,
          referencia: (r && (r.referencia || r.numeroComprobante)) || null,
          confirmacion,
        };
      },
    },
  };
  return; // NO se abre el servidor web ni los intervalos
}

server.listen(PORT, HOST, () => {
  console.log(`\n  🤖 BDV Bot Web  —  http://${HOST}:${PORT}\n`);
  log('info', `Servidor iniciado en http://${HOST}:${PORT} (modo configurado: ${cfg.mode})`);
});
