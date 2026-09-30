/* VALIDACIÓN DEL CICLO DINÁMICO Y LOG OPERATIVO (producción)
   Comprueba: bot ejecutándose, múltiples consultas/intentos, tasa reconsultada,
   cambios registrados, respuestas completas guardadas, sin credenciales. */
'use strict';
const fs = require('fs');
const path = require('path');
const API = 'http://127.0.0.1:3721';

const leerLog = () => {
  const f = path.join(__dirname, 'logs', `bot-${new Date().toISOString().slice(0, 10)}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
};

(async () => {
  console.log('\n' + '='.repeat(66));
  console.log(' VALIDACIÓN — CICLO DINÁMICO + LOG OPERATIVO');
  console.log('='.repeat(66));

  const antes = leerLog().length;

  // ---- pulsar INICIAR
  console.log('\n[1] Pulsando INICIAR…');
  const s = await (await fetch(API + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  console.log('    respuesta:', JSON.stringify(s));

  // ---- dejar correr y comprobar que sigue vivo
  const muestras = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const st = await (await fetch(API + '/api/state')).json();
    muestras.push({ t: i, running: st.bot.running, checks: st.bot.checks, ordenes: st.bot.rechazos });
    console.log(`    muestra ${i + 1}: running=${st.bot.running} chequeos=${st.bot.checks} órdenes=${st.bot.rechazos}`);
  }

  const sigue = muestras.every((m) => m.running);
  const crecio = muestras[muestras.length - 1].checks > muestras[0].checks;
  const multiples = muestras[muestras.length - 1].ordenes >= 3;

  // ---- detener
  console.log('\n[2] Deteniendo…');
  await fetch(API + '/api/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise((r) => setTimeout(r, 1500));
  const fin = await (await fetch(API + '/api/state')).json();

  // ---- analizar el log operativo
  const ev = leerLog();
  const nuevos = ev.slice(antes);
  const porTipo = {};
  nuevos.forEach((j) => { porTipo[j.tipo || '?'] = (porTipo[j.tipo || '?'] || 0) + 1; });

  console.log('\n[3] LOG OPERATIVO');
  console.log('    eventos totales  :', ev.length, `(+${nuevos.length} en esta prueba)`);
  console.log('    por tipo         :', JSON.stringify(porTipo));

  const consultas = nuevos.filter((j) => j.tipo === 'consulta');
  const compras = nuevos.filter((j) => j.tipo === 'compra');
  const cambios = nuevos.filter((j) => j.tipo === 'cambio');

  // tasa reconsultada: ¿se consultó el endpoint de reglas / menudeo más de una vez?
  const eps = {};
  consultas.forEach((j) => { eps[j.endpoint] = (eps[j.endpoint] || 0) + 1; });
  const reconsultada = Object.values(eps).some((n) => n > 1);

  // respuestas completas guardadas
  const conRespuesta = consultas.filter((j) => j.respuestaCompleta !== undefined).length;
  const compraConRespuesta = compras.filter((j) => j.respuestaCompleta !== undefined && j.solicitud).length;

  // campos obligatorios del log
  const c = consultas[0] || {};
  const camposConsulta = ['ts', 'endpoint', 'metodo', 'httpStatus', 'respuestaCompleta', 'codigo', 'duracionMs'];
  const faltanC = camposConsulta.filter((k) => !(k in c));
  const cp = compras[0] || {};
  const camposCompra = ['ts', 'intento', 'endpoint', 'metodo', 'httpStatus', 'respuestaCompleta',
    'codigo', 'tasaEnviada', 'tasaVigente', 'fuenteTasa', 'regla', 'disponibilidad', 'solicitud', 'error'];
  const faltanP = camposCompra.filter((k) => !(k in cp));

  // ---- seguridad: nada de credenciales
  const crudo = nuevos.map((j) => JSON.stringify(j)).join('\n');
  const fugas = [];
  for (const pat of ['Bearer', 'eyJhbGci', 'access_token', 'refresh_token', 'password',
    'Authorization', 'KARELYS', '01020414330000654951', '01020414370001045242', 'Saul']) {
    if (crudo.includes(pat)) fugas.push(pat);
  }

  // ---- veredicto
  const checks = [
    ['El bot sigue ejecutándose',              sigue],
    ['Realiza múltiples chequeos',             crecio],
    ['Realiza múltiples intentos/órdenes',     multiples],
    ['La tasa se vuelve a consultar',          reconsultada],
    ['Cambios registrados (ANTES → DESPUÉS)',  ev.filter((j) => j.tipo === 'cambio').length > 0],
    ['Respuestas completas guardadas',         conRespuesta > 0],
    ['Compra con solicitud + respuesta',       compraConRespuesta > 0],
    ['Campos de consulta completos',           faltanC.length === 0],
    ['Campos de compra completos',             faltanP.length === 0],
    ['SIN credenciales en el log',             fugas.length === 0],
  ];
  console.log('\n[4] VERIFICACIÓN');
  let ok = 0;
  for (const [n, v] of checks) { console.log(`    ${v ? '✅' : '❌'} ${n}`); v && ok++; }
  if (faltanC.length) console.log('       faltan en consulta:', faltanC.join(','));
  if (faltanP.length) console.log('       faltan en compra  :', faltanP.join(','));
  if (fugas.length) console.log('       FUGA DE DATOS     :', fugas.join(', '));

  console.log(`\n    ${ok}/${checks.length} comprobaciones OK`);
  console.log(`    bot estado final: running=${fin.bot.running} compras=${fin.bot.compras.length}`);
  console.log('='.repeat(66) + '\n');
  process.exit(ok === checks.length ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
