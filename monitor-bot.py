#!/usr/bin/env python3
"""
MONITOR DEL BOT BDV — vigila el ciclo de producción y avisa solo cuando
hay algo que merece atención (watchdog silencioso).

Revisa:
  · que el bot siga corriendo (no se haya caído)
  · que la sesión siga activa
  · CAMBIO CLAVE: si EXRI dejó de estar cerrado (posible apertura)
  · si se registró alguna COMPRA ACEPTADA
  · si el destino/actividad/monto del payload siguen siendo los correctos
  · si hay muchos timeouts seguidos (problema de red)

SALIDA: nada si todo está normal (silencio). Solo imprime cuando algo cambia
o requiere atención.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
LOGS = os.path.join(BASE, "logs")
API = "http://127.0.0.1:3721/api/state"
ESTADO = os.path.join(BASE, ".monitor-estado.json")


def get(url, timeout=15):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def leer_estado_previo():
    try:
        with open(ESTADO, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def guardar_estado(d):
    try:
        with open(ESTADO, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
    except Exception:
        pass


def leer_log_jsonl():
    dia = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ruta = os.path.join(LOGS, f"bot-{dia}.log")
    eventos = []
    if not os.path.exists(ruta):
        return eventos
    with open(ruta, "r", encoding="utf-8", errors="replace") as f:
        for linea in f:
            linea = linea.strip()
            if linea.startswith("{"):
                try:
                    eventos.append(json.loads(linea))
                except Exception:
                    pass
    return eventos


def main():
    avisos = []
    prev = leer_estado_previo()
    nuevo = {}

    # ---------- 1. ¿el servicio responde? ----------
    try:
        st = get(API)
    except Exception as e:
        if prev.get("servicio_ok", True):
            avisos.append(f"⚠️ El servicio NO responde en {API}: {e}")
            avisos.append("   El bot dejó de estar accesible. Revisar si el proceso sigue vivo.")
        nuevo["servicio_ok"] = False
        guardar_estado(nuevo)
        if avisos:
            print("\n".join(avisos))
        return

    nuevo["servicio_ok"] = True
    bot = st.get("bot", {})
    tasas = st.get("tasas", {})
    cfg = st.get("cfg", {})
    iv = tasas.get("intervencion", {})
    op = tasas.get("operativa", {})

    # ---------- 2. ¿el bot sigue corriendo? ----------
    corriendo = bool(bot.get("running"))
    if prev.get("corriendo") and not corriendo:
        avisos.append("🔴 El CICLO SE DETUVO (antes estaba corriendo).")
        avisos.append(f"   Motivo/estado: {bot.get('status')} · último error: {bot.get('lastError')}")
    nuevo["corriendo"] = corriendo

    # ---------- 3. ¿la sesión sigue viva? ----------
    sesion = bool((st.get("sesion") or {}).get("loggedIn"))
    if prev.get("sesion") and not sesion:
        avisos.append("🔴 La SESIÓN se perdió (sin login). El bot no podrá enviar órdenes.")
    nuevo["sesion"] = sesion

    # ---------- 4. 🎯 CAMBIO CLAVE: ¿el banco abrió? ----------
    estado_exri = iv.get("estado")
    code_exri = iv.get("code")
    nuevo["estado_exri"] = estado_exri
    nuevo["code_exri"] = code_exri
    if prev.get("estado_exri") is not None and estado_exri != prev.get("estado_exri"):
        if estado_exri not in ("cerrada", "error"):
            avisos.append("🟢🟢 ¡CAMBIO DE ESTADO EN LA INTERVENCIÓN! 🟢🟢")
            avisos.append(f"   {prev.get('estado_exri')} (code {prev.get('code_exri')}) → {estado_exri} (code {code_exri})")
            avisos.append(f"   Regla: {iv.get('regla')} · Descripción: {iv.get('description')}")
            avisos.append(f"   Tasa EXRI: {iv.get('tasaTexto')}")
            avisos.append("   → Revisar YA si el bot pudo comprar.")

    # ---------- 5. 🎉 ¿hubo alguna compra? ----------
    compras = bot.get("compras") or []
    nuevo["compras"] = len(compras)
    if len(compras) > prev.get("compras", 0):
        avisos.append("🎉🎉 ¡COMPRA ACEPTADA POR EL BANCO! 🎉🎉")
        for c in compras[:3]:
            avisos.append(f"   {c.get('fecha')} · {c.get('montoUSD')} USD @ {c.get('tasa')} Bs · ref {c.get('referencia')}")
        nuevo["compra_avisada"] = len(compras)

    # ---------- 6. payload correcto (destino/actividad/monto) ----------
    eventos = leer_log_jsonl()
    intentos = [e for e in eventos if e.get("tipo") == "compra"]
    ultimos = intentos[-20:]
    malos = [
        e for e in ultimos
        if (e.get("solicitud") or {}).get("destinoFondos") != cfg.get("destinoFondos")
        or (e.get("solicitud") or {}).get("codigoActividadEconomica") != cfg.get("codigoActividadEconomica")
    ]
    if ultimos and malos and prev.get("payload_ok", True):
        avisos.append(f"⚠️ PAYLOAD INCORRECTO en {len(malos)} de los últimos {len(ultimos)} intentos.")
        m = malos[-1]
        avisos.append(f"   Último: destino={m.get('solicitud',{}).get('destinoFondos')} "
                      f"act={m.get('solicitud',{}).get('codigoActividadEconomica')} "
                      f"(config: destino={cfg.get('destinoFondos')} act={cfg.get('codigoActividadEconomica')})")
    nuevo["payload_ok"] = not malos

    # ---------- 7. timeouts seguidos ----------
    tos = [e for e in ultimos if e.get("timeout")]
    if len(tos) >= 5:
        avisos.append(f"⚠️ Muchos TIMEOUTS seguidos ({len(tos)} de {len(ultimos)}). Posible problema de red o del banco.")

    # ---------- 8. resumen diario (una vez al día, a la primera corrida) ----------
    hoy = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if prev.get("ultimo_resumen") != hoy and corriendo:
        nuevo["ultimo_resumen"] = hoy
        avisos.append(f"📊 MONITOR ACTIVO — {hoy}")
        avisos.append(f"   Intentos de hoy: {len(intentos)} · compras: {len(compras)}")
        avisos.append(f"   Monto: {cfg.get('montoMaxUSD')} USD · destino: {cfg.get('destinoFondos')} · actividad: {cfg.get('codigoActividadEconomica')}")
        avisos.append(f"   Tasa: {op.get('tasaPublicadaTexto')} Bs ({op.get('fuenteTasaPublicada')})")
        avisos.append(f"   Intervención: {estado_exri} (code {code_exri})")
        avisos.append("   Vigilando hasta que el banco abra.")

    guardar_estado(nuevo)

    # Silencio si todo está normal (watchdog)
    if avisos:
        print("\n".join(avisos))
    return


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"⚠️ Monitor con error: {e}")
        sys.exit(0)
