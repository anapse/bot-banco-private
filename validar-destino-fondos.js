/* VERIFICACIÓN — destinoFondos se conserva (INTERVENCIÓN → payload)
   Comprueba:
     1. la config tiene el destino del usuario ("05")
     2. al reconstruirse el combo desde el banco, el formulario CONSERVA "05"
        (se replica la lógica real del frontend contra los datos REALES del banco)
     3. el payload enviado a sellbuycurrencyEXCV lleva destinoFondos="05"
   No hace falta una compra real: el payload se comprueba en /api/web-comprar.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const API = 'http://127.0.0.1:3721';

const leerJson = () => {
  const f = path.join(__dirname, 'logs', `bot-${new Date().toISOString().slice(0, 10)}.log`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
};

let ok = 0, total = 0;
const add = (n, v) => { total++; if (v) ok++; console.log(`    ${v ? '✅' : '❌'} ${n}`); };

// --- Simula el formulario: replica EXACTAMENTE la lógica de cargarComboForm()
//     (crear opciones con value=c.id y conservar la selección previa/guardada)
function simularFormulario(combo, valorSeleccionadoAntes, cfgDestino) {
  const options = [];
  const sel = {
    set innerHTML(_) { options.length = 0; },
    get options() { return options; },
    value: valorSeleccionadoAntes,
  };
  // --- replicado de index.html ---
  const elegidoAntes = sel.value;
  sel.innerHTML = '';
  for (const c of combo.codigo) options.push({ value: c.id, text: c.codigoDestino });
  const guardado = cfgDestino || '';
  const preferido = [elegidoAntes, guardado].find((v) => v && options.some((o) => o.value === v));
  if (preferido) sel.value = preferido;
  return sel;
}

(async () => {
  console.log('\n' + '='.repeat(68));
  console.log(' VERIFICACIÓN — destinoFondos CONSERVADO');
  console.log('='.repeat(68));

  const st = await (await fetch(API + '/api/state')).json();
  const comboRes = await (await fetch(API + '/api/web-combo', { method: 'POST' })).json();
  const combo = comboRes.data || comboRes;

  console.log('\n[1] CONFIGURACIÓN DEL USUARIO');
  console.log('    destinoFondos guardado :', st.cfg.destinoFondos);
  add('La config conserva el destino del usuario ("05")', st.cfg.destinoFondos === '05');

  const nombre = (combo.codigo.find((c) => c.id === st.cfg.destinoFondos) || {}).codigoDestino;
  console.log('    destinoFondos guardado :', st.cfg.destinoFondos, `(${nombre})`);

  console.log('\n[2] EL FORMULARIO AL RECONSTRUIRSE DESDE EL BANCO');
  console.log('    opciones del banco :', combo.codigo.length);

  // Caso A: primera carga (el <select> estático traía texto, no código)
  const a = simularFormulario(combo, 'Otros', st.cfg.destinoFondos);
  console.log('    primera carga → seleccionado:', a.value, `(${(combo.codigo.find(c=>c.id===a.value)||{}).codigoDestino})`);
  add('La primera carga cae al destino guardado, no a "Otros"', a.value === '05');

  // Caso B: reconstrucción periódica (cada 10 min) con el usuario ya en "05"
  const b = simularFormulario(combo, '05', st.cfg.destinoFondos);
  console.log('    reconstrucción → seleccionado:', b.value);
  add('La reconstrucción periódica conserva la selección', b.value === '05');

  // Caso C: el usuario elige otro destino y el combo se reconstruye
  const c = simularFormulario(combo, '09', st.cfg.destinoFondos);
  console.log('    usuario eligió 09 → tras reconstruir:', c.value);
  add('Se respeta la elección manual del usuario', c.value === '09');

  // Caso D: el usuario vuelve a "05"
  const d = simularFormulario(combo, '05', st.cfg.destinoFondos);
  add('Volver a elegir "05" también se conserva', d.value === '05');

  console.log('\n[3] PAYLOAD ENVIADO A sellbuycurrencyEXCV (vía AUTORREENVÍO)');
  const n0 = leerJson().length;
  // Arrancar el ciclo igual que el botón AUTORREENVÍO (el banco rechaza: intervención cerrada)
  await fetch(API + '/api/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      monto: '150', cuentaDebito: st.cuentas.debito, cuentaDestino: st.cuentas.destino,
      destinoFondos: '05', actividadEconomica: st.cfg.codigoActividadEconomica, intervaloMs: 500
    })
  });
  await new Promise((r) => setTimeout(r, 5000));
  await fetch(API + '/api/stop', { method: 'POST' });
  await new Promise((r) => setTimeout(r, 1200));

  const ev = leerJson().slice(n0);
  const compra = ev.filter((j) => j.tipo === 'compra').pop();
  const solicitado = compra && compra.solicitud && compra.solicitud.destinoFondos;
  console.log('    destinoFondos en el payload:', solicitado);
  console.log('    endpoint                   :', compra && compra.endpoint);
  console.log('    respuesta del banco        :', JSON.stringify(compra && compra.respuestaCompleta));
  add('El payload lleva destinoFondos="05"', solicitado === '05');

  // comprobar TODOS los intentos de la tanda (no solo el último)
  const intentos = ev.filter((j) => j.tipo === 'compra' && j.solicitud);
  const todos05 = intentos.length > 0 && intentos.every((j) => j.solicitud.destinoFondos === '05');
  console.log(`    intentos en la tanda       : ${intentos.length} · todos con "05": ${todos05}`);
  add('TODOS los intentos llevan "05"', todos05);

  // el estado del servidor no debe haber cambiado
  const st2 = await (await fetch(API + '/api/state')).json();
  console.log('    config tras la operación   :', st2.cfg.destinoFondos);
  add('La config NO se sobrescribe con otro valor', st2.cfg.destinoFondos === '05');

  console.log('\n' + '='.repeat(68));
  console.log(` ${ok}/${total} comprobaciones OK`);
  console.log('='.repeat(68) + '\n');
  process.exit(ok === total ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
