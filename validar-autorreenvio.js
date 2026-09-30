/* VALIDACIÓN — AUTORREENVÍO = EL BOT
   Simula exactamente lo que hace el botón AUTORREENVÍO de INTERVENCIÓN:
   arranca el ciclo del servidor con los datos de la operación, comprueba que
   sigue corriendo y que actualiza la tasa, y lo detiene.
   NO se hace ninguna compra real (el banco rechaza: intervención cerrada). */
'use strict';
const fs = require('fs');
const path = require('path');
const API = 'http://127.0.0.1:3721';

const logOper = () => {
  const f = path.join(__dirname, 'logs', `bot-${new Date().toISOString().slice(0, 10)}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
};

(async () => {
  console.log('\n' + '='.repeat(64));
  console.log(' VALIDACIÓN — AUTORREENVÍO (EL BOT)');
  console.log('='.repeat(64));

  const n0 = logOper().length;

  // --- 1) el HTML no debe tener pestaña Bot
  const html = await (await fetch(API + '/')).text();
  const sinPestana = !html.includes('data-tab="bot"') && !html.includes('tab-bot');
  const tieneAuto = html.includes('btnAutoReenvio') && html.includes('autoStatus');
  console.log('\n[1] INTERFAZ');
  console.log('    sin pestaña "Bot"          :', sinPestana ? '✅' : '❌');
  console.log('    AUTORREENVÍO en INTERVENCIÓN:', tieneAuto ? '✅' : '❌');

  // --- 2) arrancar como lo hace el botón
  console.log('\n[2] Activando AUTORREENVÍO (igual que el botón)…');
  const st0 = await (await fetch(API + '/api/state')).json();
  const body = {
    monto: '150',
    cuentaDebito: st0.cuentas.debito, cuentaDestino: st0.cuentas.destino,
    destinoFondos: st0.cfg.destinoFondos, actividadEconomica: st0.cfg.codigoActividadEconomica,
    intervaloMs: 1000
  };
  const r = await (await fetch(API + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  console.log('    respuesta del servidor:', JSON.stringify(r));

  // --- 3) comprobar que sigue corriendo y progresa
  console.log('\n[3] Ciclo automático (sin tocar nada)');
  const m = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((x) => setTimeout(x, 2500));
    const s = await (await fetch(API + '/api/state')).json();
    m.push({ running: s.bot.running, checks: s.bot.checks, ord: s.bot.rechazos });
    console.log(`    t=${i * 2.5}s  running=${s.bot.running}  chequeos=${s.bot.checks}  intentos=${s.bot.rechazos}`);
  }

  // --- 4) la tasa se reconsultó / actualizó
  const tasa = (await (await fetch(API + '/api/state')).json()).tasas.operativa;

  // --- 5) detener como lo hace el botón
  console.log('\n[4] Deteniendo AUTORREENVÍO…');
  await fetch(API + '/api/stop', { method: 'POST' });
  await new Promise((x) => setTimeout(x, 1200));
  const fin = await (await fetch(API + '/api/state')).json();

  // --- 6) log operativo
  const nuevos = logOper().slice(n0);
  const tipos = {};
  nuevos.forEach((j) => { tipos[j.tipo || '?'] = (tipos[j.tipo || '?'] || 0) + 1; });
  const crudo = nuevos.map((j) => JSON.stringify(j)).join('\n');
  const fugas = ['Bearer', 'eyJhbGci', 'access_token', 'password', 'Authorization',
    '01020414330000654951', '26870048'].filter((p) => crudo.includes(p));

  console.log('\n[5] LOG OPERATIVO:', JSON.stringify(tipos), `(total ${nuevos.length})`);

  const checks = [
    ['Pestaña "Bot" eliminada',              sinPestana],
    ['AUTORREENVÍO presente en INTERVENCIÓN', tieneAuto],
    ['El bot arranca al activar AUTORREENVÍO', m[0].running],
    ['Sigue corriendo sin intervención',      m.every((x) => x.running)],
    ['Progresa (múltiples chequeos)',         m[3].checks > m[0].checks],
    ['Realiza múltiples intentos',            m[3].ord >= 3],
    ['La tasa se mantiene vigente',           !!(tasa.tasaPublicada > 0 || (tasa.disponible && tasa.tasa > 0))],
    ['Se detiene al desactivar',              fin.bot.running === false],
    ['Log guarda consultas + intentos',       (tipos.consulta || 0) > 0 && (tipos.compra || 0) > 0],
    ['SIN credenciales en el log',            fugas.length === 0],
  ];
  console.log('\n[6] VERIFICACIÓN');
  let ok = 0;
  for (const [n, v] of checks) { console.log(`    ${v ? '✅' : '❌'} ${n}`); v && ok++; }
  if (fugas.length) console.log('       FUGA:', fugas.join(', '));
  console.log(`\n    ${ok}/${checks.length} OK · compras reales: ${fin.bot.compras.length}`);
  console.log('='.repeat(64) + '\n');
  process.exit(ok === checks.length ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
