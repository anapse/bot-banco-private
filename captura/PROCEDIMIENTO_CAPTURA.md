# PROCEDIMIENTO DE CAPTURA — APK OFICIAL BDV

> **Fase actual:** ingeniería inversa dinámica. **NO se ejecuta ninguna compra.**
> Solo se captura lo que la app hace: login, consultas, y navegación hasta la
> pantalla de compra **SIN pulsar "Comprar"**.

---

## 0. Verificado en tu PC

| Componente | Estado |
|---|---|
| `mitmproxy 12.2.3` | ✅ instalado |
| `adb` (dentro de scrcpy) | ✅ `D:\PROYECTOS\scrcpy-win64-v4.1\scrcpy-win64-v4.1\adb.exe` |
| Addon de captura | ✅ `captura/capturar_bdv.py` (probado, redacta bien) |
| Analizador | ✅ `captura/analizar_captura.py` (probado) |
| **IP LAN de tu PC** | ✅ **`192.168.1.3`** |
| Teléfono conectado | ❌ ninguno todavía |

---

## 1. Ejecutar la APK en un Android físico

**Requisitos:** teléfono Android 7.0+ (la APK es `min_api 24`), **mismo WiFi** que tu PC.

### 1.1 Instalar la APK
El paquete es **APKM** (bundle con splits). Necesitas **APKMirror Installer** o instalar los splits:

```bash
# Opción A — APKMirror Installer (más fácil)
# Instala la app "APKMirror Installer" desde Play Store en el teléfono
# y ábrela apuntando al archivo .apkm/.rar que tienes.

# Opción B — por adb (instalar base + splits)
cd "D:\PROYECTOS\RAUL APK\com.bancodevenezuela.bdvdigital_583fce89-342_3arch_7dpi_24lang_15c78dd334d6a5ea5968766198b09d33_apkmirror.com"
adb install-multiple base.apk split_config.arm64_v8a.apk split_config.es.apk split_config.xxhdpi.apk
```

> ⚠️ **NO** uses la APK para nada financiero todavía.

### 1.2 Activar depuración USB (para verificar, opcional)
Ajustes → Información del teléfono → tocar 7× "Número de compilación" → Opciones de desarrollador → **Depuración USB**.

```bash
adb devices          # debe listar tu teléfono
```

---

## 2. Configurar mitmproxy (en tu PC)

Abre **una** terminal y ejecuta:

```bash
MITM="$APPDATA/Python/Python313/Scripts/mitmdump.exe"
cd "D:\PROYECTOS\bot raul\captura"
BDV_CAP_DIR="D:/PROYECTOS/bot raul/captura/salida" \
  "$MITM" -s capturar_bdv.py -p 8080 --set block_global=false \
  -w "D:/PROYECTOS/bot raul/captura/salida/flujo.mitm"
```

Debe aparecer: `Proxy server listening at http://*:8080`

**Encontrar la IP a usar en el teléfono** (ya la sabemos, pero por si cambia):
```bash
ipconfig | grep "IPv4"      # usa la que empiece por 192.168.
```
→ **`192.168.1.3`**

### Permitir la entrada en el Firewall (una vez, como admin)
```powershell
netsh advfirewall firewall add rule name="mitmproxy 8080" dir=in action=allow protocol=TCP localport=8080
```

---

## 3. Instalar el certificado en el teléfono 🔑

**Este es el paso clave.** Sin él, HTTPS no se puede leer.

### 3.1 Descargar el certificado
Con mitmproxy corriendo, en el **navegador del teléfono** abre:

```
http://mitm.it
```

Descarga la sección **Android** → `mitmproxy-ca-cert.cer`

### 3.2 Instalarlo
**Android 7+ (API 24+):** los certificados de usuario **NO se aplican a las apps** (solo a navegador). La APK es Flutter, que usa su propio almacén.

**Necesitas una de estas dos vías:**

#### Vía A — Sin root: **PCAPdroid** (RECOMENDADA)
Flutter **ignora el proxy del sistema**. Si la captura por proxy sale vacía, usa esto:

1. Instala **PCAPdroid** (F-Droid / Play Store).
2. PCAPdroid → *Ajustes* → **TLS decryption** → activa y **confía en el certificado que genera** (PCAPdroid instala su propia CA como CA de **sistema** vía VPN local, sin root).
3. PCAPdroid → *Target apps* → selecciona solo **BDV**.
4. Pulsa ▶ y navega en la app.
5. Al terminar, exporta el **PCAP** y pásalo al PC:
   ```bash
   adb pull /sdcard/Download/pcapdroid_bdv.pcap "D:/PROYECTOS/bot raul/captura/salida/"
   ```

#### Vía B — Con root: certificado como CA de sistema
```bash
# El telefono debe estar rooteado
adb root
adb remount
# convertir el .cer a formato hash
openssl x509 -inform PEM -subject_hash_old -in mitmproxy-ca-cert.pem -noout
# renombrar a <hash>.0 y copiar
adb push mitmproxy-ca-cert.<hash>.0 /system/etc/security/cacerts/
adb shell chmod 644 /system/etc/security/cacerts/<hash>.0
adb reboot
```

#### Vía C — Frida (extrae también el `app-key` en memoria)
```bash
pip install frida-tools
# en el telefono (root): subir frida-server y arrancarlo
frida-ps -U | grep -i bdv
```

---

## 4. Configurar el proxy en el teléfono

Ajustes → **WiFi** → tu red → **Modificar red** → Avanzado:
- Proxy: **Manual**
- Nombre de host: **`192.168.1.3`**
- Puerto: **`8080`**

---

## 5. Capturar el tráfico HTTPS

Con todo listo, en el teléfono **abre la APK BDV** y haz **exactamente** esto:

| Paso | Acción en la app | Etapa capturada |
|---|---|---|
| 1 | **Login** (usuario + clave) | `AUTH` |
| 2 | Esperar a que cargue la pantalla principal | `AUTH` (refresh) |
| 3 | Ir a **Divisas → Mesa de Cambio / Intervención** | `MERCADO`, `REGLAS_INTERVENCION` |
| 4 | **Seleccionar moneda (USD)** | `REGLAS_POR_MONEDA` |
| 5 | **Elegir tipo de operación / actividad** | `ACTIVIDADES` |
| 6 | Rellenar el monto y llegar a la pantalla de confirmación | `CUENTAS/SALDO`, `OFICINAS` |
| 7 | **NO PULSAR "Comprar"** ✋ | — |

> ## 🛑 DETENTE AQUÍ EN LA PRIMERA RONDA
> Con esto ya tenemos: auth, refresh, mercado, reglas, reglas por moneda,
> actividades y preparación. **Eso es todo lo que necesitamos de la ronda 1.**

**Deja la app abierta** unos segundos para que se registren los refrescos de token.

Para parar la captura: `Ctrl+C` en la terminal de mitmproxy.

---

## 6. Redactado de datos sensibles ✅

**Ya está implementado** en `capturar_bdv.py` y **probado**. Enmascara antes de escribir a disco:

| Tipo | Resultado en el log |
|---|---|
| `password`, contraseña | `«REDACTADO:17»` |
| `Authorization`, `Bearer <jwt>` | `«REDACTADO»` |
| `refresh_token`, `access_token` | `«REDACTADO»` |
| `app-key`, `X-MEDIA` | `«REDACTADO:20»` |
| Cédula (`V-26870048`) | `«CEDULA»` |
| Cuenta 20 dígitos | `«CUENTA»` |
| JWT sueltos | `«JWT-REDACTADO»` |

**Conservamos la longitud** (`:20`) para poder comparar estructuras **sin** ver el dato. Los códigos (`1000`, `13`, `1001`) y las tasas **sí** quedan legibles — son lo que necesitamos.

Verificado con `probar_redactado.py` → **sin fugas**.

---

## 7. Guardar los requests/responses

Los archivos quedan en `captura/salida/`:

| Archivo | Contenido |
|---|---|
| `contratos.jsonl` | Cada llamada en JSON, redactada, clasificada por etapa |
| `flujo.mitm` | Flujo completo de mitmproxy (para re-inspeccionar) |
| `captura.log` | Línea por llamada |

---

## 8-9. Determinar `app-key` y `X-MEDIA`

Al analizar la captura, el analizador **imprime estos headers** de cada request:

```
HEADERS req:
    Content-Type: application/json
    Authorization: ***
    app-key: «REDACTADO:20»     ← longitud real (¿fijo o variable?)
    X-MEDIA: «REDACTADO:16»     ← longitud real
```

**Para obtener los valores reales** necesitamos comparar varias llamadas:

```bash
# ¿el app-key cambia entre llamadas? (mirar longitudes)
grep -o '"app-key":"«REDACTADO:[0-9]*»"' "captura/salida/contratos.jsonl" | sort | uniq -c
```

- Si **siempre mide igual** → es una constante → la leemos del `.mitm` con mitmproxy
- Si **varía** → se deriva de algo (timestamp / dispositivo) → necesitamos **Frida**

**Para ver el valor real** (solo para el desarrollo, en tu PC):
```bash
mitmdump -nr "captura/salida/flujo.mitm" \
  --set flow_detail=3 -s "print('app-key:', flow.request.headers.get('app-key'))"
```

---

## 10. Contratos de COMPRA y CONFIRMACIÓN

**En la ronda 1 NO se capturan** (no se pulsa Comprar).

Se harán en una **ronda 2 dedicada**, cuando:
1. Tengamos los contratos de consulta ya reconstruidos.
2. El motor web funcione en **modo diagnóstico**.
3. Se haga **una sola** compra controlada, con monto mínimo, para capturar `comprar`/`confirmar`.

---

## 11. Analizar la captura

```bash
cd "D:\PROYECTOS\bot raul\captura"
python analizar_captura.py "salida"
```

Genera:
- Resumen por etapa del flujo
- Endpoints únicos (método + ruta)
- **Contrato detallado**: query, headers, body, response, **código**
- `salida/CONTRATOS.json`

---

## 12. Detección de la apertura (para el bot final)

Una vez tengamos los contratos, el motor web consultará en bucle:

```
consultar reglas / disponibilidad
      ↓
¿code == 1000 y hay tasa?
   ├── NO  → esperar intervalo configurable, reintentar (MISMA sesión)
   └── SÍ  → pasar INMEDIATAMENTE al flujo de compra
```

**Regla estricta (ya establecida):**
```
UNA CUENTA → UNA SESIÓN → UN AUTH MANAGER → UN FLUJO CONTROLADO
```
Los reintentos **reutilizan la sesión**. Nunca logins ni refresh en paralelo.

---

## Checklist antes de empezar

- [ ] Teléfono Android 7+ con la APK instalada
- [ ] Teléfono en la **misma WiFi** que el PC
- [ ] mitmproxy corriendo en `:8080`
- [ ] Firewall permitiendo el puerto 8080
- [ ] Certificado instalado (o PCAPdroid configurado)
- [ ] Proxy del WiFi apuntando a `192.168.1.3:8080`
- [ ] `captura/salida/` vacía y lista
- [ ] **Decidido: NO pulsar "Comprar" en esta ronda**
