# BOT WEB — OPERACIÓN INDEPENDIENTE

**Importante:** el BOT WEB **no depende de Hermes** para operar.

Hermes es la herramienta de **desarrollo** (analizar, actualizar, modificar el
proyecto). El bot corre por su cuenta y debe seguir funcionando aunque Hermes
esté actualizándose, apagado, reiniciándose o con errores.

---

## Arquitectura

```
HERMES      → herramienta de desarrollo/actualización (no operativa)
BOT WEB     → sistema operativo independiente (Node + panel en :3721)
MOTOR       → apk-api.js + server.js = lógica compartida
              (la usan el modo AUTOMÁTICO y el modo MANUAL)
```

---

## Arrancar el bot

```bash
# Opción 1 (Windows, la normal): doble clic o
iniciar.bat

# Opción 2 (desacoplado, sobrevive a cerrar la consola)
cscript //nologo arrancar-solo.vbs

# Opción 3 (manual)
node --use-system-ca server.js
```

El panel queda en **http://localhost:3721** (y accesible por la IP de la PC
desde otro dispositivo de la misma red).

---

## Qué se puede hacer desde la web

### Pestaña **📱 APK** (nueva)

Es el canal REAL de la intervención. El portal (bdvenlinea) responde
**siempre `code=01`** y nunca refleja si la subasta está abierta; el APK
oficial usa otra API (`bdvdigital.banvenez.com`, rutas `bdvx-*`) que sí lo
refleja.

| Botón | Qué hace |
|---|---|
| 🔄 Consultar estado | Lee el código real: `1000` abierto · `1003` sin cupo |
| 📋 Actividades | Catálogo (origen de fondos, actividades económicas) |
| 📜 Reglas | Reglas de la operación |
| 🏢 Oficinas | Oficinas disponibles |
| **⚡ COMPRAR AHORA (APK)** | **Envía la orden por el canal del APK** |
| 🧪 Verificar cupo primero | Consulta antes de disparar |
| Enviar (llamada cruda) | Llama a cualquier endpoint del APK (diagnóstico) |

### Pestaña Panel / Intervención

Las de siempre: saldo, datos del cliente, movimientos, tasa del portal.

---

## Códigos del banco

| Código | Significado |
|---|---|
| **1000** | ✅ Operación disponible — se puede comprar |
| **1002** | (observado en el flujo de intervención) |
| **1003** | ⏳ "Las operaciones cambiarias estarán disponibles más tarde" → **sin cupo**. Como la subasta se agota en segundos, es lo habitual |
| 1001 | Datos de entrada inválidos |
| 4000 | Servicio no disponible |
| 5000 | Error inesperado |
| WAF | Bloqueado por el cortafuegos del banco (F5) |

---

## Compra manual (desde la web)

En la pestaña APK:

1. **Monto (USD)** — por defecto 10
2. **Disparos en paralelo** — por defecto 3 (la subasta se agota en
   segundos; varios disparos simultáneos aumentan la probabilidad)
3. Pulsa **⚡ COMPRAR AHORA (APK)**

Si el banco tiene cupo (`1000`) → compra y confirma automáticamente,
mostrando el payload, la respuesta y la confirmación.

Si no hay cupo (`1003`) → lo indica y se puede reintentar.

**Toda la evidencia queda en `logs/apk-compras.jsonl`** (endpoint, payload,
httpStatus, respuesta, confirmación y duración) para poder reconstruir el
flujo si la compra se realiza.

---

## Compra automática

El botón **🔁 AUTORREENVÍO** de la pestaña Intervención arranca el ciclo
automático (canal del portal).

Para atacar el canal del APK en bucle:

```bash
node tools/atacante-apk.js --comprar

# ajustando velocidad:
INTERVALO_MS=250 HILOS=3 node tools/atacante-apk.js --comprar
```

- `INTERVALO_MS` — pausa entre ciclos (250 ms = 4 ciclos/s)
- `HILOS` — compras en paralelo al detectar `1000`

---

## Endpoints de la API del bot (uso interno del panel)

Todos por **POST**:

| Endpoint | Qué hace |
|---|---|
| `/api/state` | Estado general (bot, tasas, saldo, sesión) |
| `/api/apk-estado` | Estado por el canal del APK |
| `/api/apk-actividades` | Catálogo de actividades |
| `/api/apk-reglas` | Reglas |
| `/api/apk-oficinas` | Oficinas |
| `/api/apk-estados` | Estados de operaciones |
| `/api/apk-comprar` | **Compra por el canal del APK** |
| `/api/apk-raw` | Llamada cruda a cualquier endpoint del APK |
| `/api/start` `/api/stop` | Arrancar/parar el ciclo automático |
| `/api/web-tasa` etc. | Consultas del portal (las de siempre) |

---

## Archivos relevantes

| Archivo | Qué es |
|---|---|
| `server.js` | Servidor + panel. Independiente. |
| `apk-api.js` | **Canal del APK** (nuevo). Lógica compartida. |
| `public/index.html` | La web (incluye la pestaña APK). |
| `config.json` | Monto, cuentas, reglas. |
| `web-session.json` | Sesión del portal (el token sirve también para el canal del APK). |
| `logs/apk-compras.jsonl` | Evidencia de cada intento de compra por el APK. |
| `logs/apk-api.log` | Log del canal del APK. |
| `tools/atacante-apk.js` | Ataque automático por el canal del APK. |

---

## Verificado

- ✅ El bot arranca solo (maté todo y arrancó con `iniciar.bat`)
- ✅ La pestaña APK consulta el estado real (`1003` ahora mismo)
- ✅ La compra manual funciona: 3 disparos en 447 ms
- ✅ La evidencia se guarda en disco
- ✅ **No requiere Hermes en ningún momento**
