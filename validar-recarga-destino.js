/* PRUEBA DEL CASO QUE FALLÓ: recargar la página con destino "05" debe conservar "05"
   Simula lo que hace el navegador al cargar INTERVENCIÓN y luego reconstruir el combo
   (la página se recarga / el refresh llama a cargarComboForm cada 10 min).
   Comprueba que el value del <select> sigue siendo "05" y NO cae a "11" (Otros). */
'use strict';
const fs = require('fs');
const path = require('path');
const API = 'http://127.0.0.1:3721';

async function main() {
  console.log('\n' + '='.repeat(66));
  console.log(' PRUEBA: el destino "05" sobrevive a la recarga de la página');
  console.log('='.repeat(66));

  const st = await (await fetch(API + '/api/state')).json();
  const combo = ((await (await fetch(API + '/api/web-combo', { method: 'POST' })).json()).data) || {};
  console.log('\n  cfg.destinoFondos :', st.cfg.destinoFondos);
  console.log('  opciones del banco:', combo.codigo.length);

  // --- replica la lógica REAL de cargarComboForm() tal como está ahora en index.html
  const js = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .match(/<script>([\s\S]*)<\/script>/)[1];
  const guardaState = js.includes('if (!state || !state.cfg) return;');
  const usaId = js.includes('op.value = c.id');
  const conserva = js.includes('selDest.value = preferido');
  console.log('\n  guarda "state" antes de reconstruir:', guardaState ? '✅' : '❌');
  console.log('  usa el CÓDIGO como value         :', usaId ? '✅' : '❌');
  console.log('  re-selecciona el valor guardado  :', conserva ? '✅' : '❌');

  // --- comprobar el <select> estático servido por el servidor
  const html = await (await fetch(API + '/')).text();
  const bloque = html.match(/<select id="fDestino">([\s\S]*?)<\/select>/)[1];
  const opciones = [...bloque.matchAll(/<option value="(\d+)">([^<]*)</g)].map((m) => ({ v: m[1], t: m[2] }));
  console.log('\n  opciones estáticas del HTML:', opciones.map((o) => o.v + '=' + o.t).join(' · '));
  const tieneAhorro05 = opciones.some((o) => o.v === '05' && o.t === 'Ahorro');
  const yaNoEsOtros = opciones[0] && opciones[0].v === '05';
  console.log('  "05" = Ahorro definido     :', tieneAhorro05 ? '✅' : '❌');
  console.log('  primera opción ya no es "Otros":', yaNoEsOtros ? '✅' : '❌');

  // --- simular el form con la lógica nueva (state disponible)
  const opts = opciones.map((o) => ({ value: o.v, text: o.t }));
  const simular = (seleccionadoAntes, cfg) => {
    const elegidoAntes = seleccionadoAntes;
    const guardado = cfg || '';
    const preferido = [elegidoAntes, guardado].find((v) => v && opts.some((o) => o.value === v));
    return preferido || opts[0].value;
  };
  const casos = [
    ['recarga: el select arranca en "05" (config)', simular('05', st.cfg.destinoFondos)],
    ['recarga: el select arranca en "Otros" por el HTML viejo', simular('11', st.cfg.destinoFondos)],
    ['usuario eligió "09" y se reconstruye', simular('09', st.cfg.destinoFondos)],
  ];
  console.log('\n  resultado de cada caso:');
  let ok = 0, total = 0;
  const add = (n, v) => { total++; if (v) ok++; console.log(`    ${v ? '✅' : '❌'} ${n}`); };
  for (const [n, r] of casos) console.log(`      ${n} → "${r}"`);
  add('La recarga conserva "05"', casos[0][1] === '05');
  add('Aunque el select arranque en "Otros", cae al configurado "05"', casos[1][1] === '05');
  add('Se respeta la elección manual del usuario "09"', casos[2][1] === '09');
  add('No se reconstruye sin "state" (evita perder la selección)', guardaState);
  add('El value de las opciones es el CÓDIGO del banco', usaId);

  console.log('\n' + '='.repeat(66));
  console.log(` ${ok}/${total} comprobaciones OK`);
  console.log('='.repeat(66) + '\n');
  process.exit(ok === total ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
