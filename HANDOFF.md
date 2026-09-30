# HANDOFF — Estado del proyecto

> **Estado cambiante.** Se actualiza al final de cada sesión.
> El contexto estable (arquitectura, reglas) está en `AGENTS.md`.

**Última actualización:** 2026-09-24

---

## Dónde quedamos

Se logró el **objetivo técnico principal**: identificar por qué el bot
nunca compraba y **reescribir el motor** para usar el canal correcto.

**El bot pasó de mirar el canal equivocado a usar la API del APK.**

---

## Estado actual

| Componente | Estado |
|---|---|
| Subasta | ❌ **`1003` — sin cupo** (cerrada) en todas las pruebas |
| Compras | **0** |
| Bot | ✅ Independiente (arranca solo, sobrevive a Hermes) |
| Panel | ✅ `localhost:3721` |
| Canal APK | ✅ Funciona — responde `1003` |
| Compra manual | ✅ Lista para disparar desde el formulario |
| Tasa | `863,00833` (menudeo) — la RGLIC no se ha publicado |

---

## Qué se hizo

1. **Diagnóstico completo del problema raíz**
   - El bot consultaba el portal (`59 consultas → todas code=01`)
   - El APK usa otra API (`bdvdigital.banvenez.com`, rutas `bdvx-*`)
   - **455 consultas al portal: ninguna reflejó la apertura**

2. **Se extrajo `libapp.so` del APK** (11 MB, Flutter/Dart AOT)
   - 129 endpoints reales mapeados
   - Tabla de códigos descifrada (`1000`/`1003`/…)

3. **Motor reescrito** (`apk-api.js`)
   - **El MISMO formulario** ahora envía por el canal del APK
   - Automático y manual usan **el mismo motor**
   - Verificado: `canal: apk`, 3 disparos en 447 ms

4. **Pestaña "Diagnóstico"** (no duplica el formulario)

5. **Auditorías de seguridad** (pasivas)
   - El bot **solo** llama a `sellbuycurrencyEXCV` y `comprar` (5.239 registros)
   - **0 llamadas** a transferencias/pagomóvil/etc.
   - El teléfono **no** es necesario para comprar (probado: `deviceId` da 401)

---

## Pendiente

| # | Tarea | Prioridad |
|---|---|---|
| 1 | **Probar cuando la subasta abra** — es lo único que falta para comprar | 🔴 |
| 2 | Proteger `BDV_PASSWORD` (está en texto plano en `.env`) | 🟡 |
| 3 | Dejar de guardar el historial bancario en los logs | 🟡 |
| 4 | Rotar la contraseña del banco (estuvo en disco) | 🟡 |

---

## Siguiente paso EXACTO

**Esperar a que la subasta abra**, y entonces:

```
1. Abrir el panel:     http://localhost:3721
2. Rellenar el formulario (monto 10 USD, cuenta …4951 → …5242)
3. Pulsar "Confirmar y ejecutar compra"
```

Si sale `1003` → sin cupo, reintentar.
Si sale `1000` → **compró**.

**Toda la evidencia queda en `logs/apk-compras.jsonl`.**

### Si el bot está apagado

```
iniciar.bat          (doble clic)
```
o
```
cscript //nologo arrancar-solo.vbs
```

---

## Preguntas abiertas (sin resolver)

1. **¿El token del portal basta para una compra ACEPTADA?**
   La cuenta KARELYS2812 no ve la intervención (el familiar la ve con
   otra cuenta). **Nunca llegamos a `1000`**, así que no se pudo verificar.

2. **¿Qué es el campo `secret`** de `registro_vinculacion`?
   Encontrado en el APK junto a `accessToken`/`refreshToken`.
   **Función no determinada.**

3. **¿El histórico usa otro token?**
   `/bdvx-consulta-historico-operaciones/*` da **401** con nuestro token.

**NO hay evidencia de que la cuenta esté bloqueada** — simplemente no
hemos pillado la ventana abierta.

---

## Pruebas realizadas

- ✅ `tools/atacante-apk.js` — 3 pet/s, todos `1003`
- ✅ Formulario original → canal APK (447 ms, 3 disparos)
- ✅ Modo automático usa el mismo motor (`ultimaCanal: apk`)
- ✅ Independencia: matar todo → `iniciar.bat` → HTTP 200
- ✅ `test-lan.sh` 13/13
- ❌ **Compra real: nunca alcanzada** (subasta cerrada)

---

## Notas

- **Perfil Hermes:** `bot-raul`
- **Puerto:** 3721 (el juego arándanos usa el 5173 — proyecto distinto)
- Hay un proceso `node --use-system-ca server.js` que puede quedar
  corriendo; para pararlo: `taskkill -F -IM node.exe`
