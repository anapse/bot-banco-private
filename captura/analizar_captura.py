"""
================================================================================
 ANALIZADOR DE CAPTURA — reconstruye los CONTRATOS desde el tráfico real
================================================================================
 Lee `contratos.jsonl` (salida del addon de captura) y produce un documento
 con el contrato exacto de cada endpoint: método, URL, headers, body, response
 y código de éxito.

 NO interpreta de más: muestra lo que se capturó, literal.

 Uso:
   python analizar_captura.py <carpeta_de_captura>
================================================================================
"""
import json
import os
import sys
import collections

def cargar(carpeta):
    ruta = os.path.join(carpeta, "contratos.jsonl")
    if not os.path.exists(ruta):
        print(f"NO se encontró {ruta}")
        sys.exit(1)
    regs = []
    with open(ruta, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if ln:
                try: regs.append(json.loads(ln))
                except Exception: pass
    return regs

def main():
    carpeta = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.expanduser("~"), "bdv_captura")
    regs = cargar(carpeta)
    print("=" * 78)
    print(f" CONTRATOS RECONSTRUIDOS DESDE TRÁFICO REAL  ·  {len(regs)} llamadas")
    print("=" * 78)
    if not regs:
        print("\n No hay llamadas capturadas todavía.")
        print(" Ejecuta la captura siguiendo PROCEDIMIENTO_CAPTURA.md\n")
        return

    # --- resumen por etapa
    por_etapa = collections.OrderedDict()
    for r in regs:
        por_etapa.setdefault(r["etapa"], []).append(r)

    print("\n--- RESUMEN POR ETAPA DEL FLUJO ---")
    orden = ["AUTH","MERCADO","REGLAS_INTERVENCION","REGLAS_POR_MONEDA/COMPRA",
             "ACTIVIDADES","CUENTAS/SALDO","OFICINAS","COMPRA","CONFIRMACION","ESTADO","OTRO"]
    for et in orden:
        if et in por_etapa:
            print(f"  {et:28} {len(por_etapa[et]):>4} llamadas")

    # --- endpoints únicos (identidad del contrato)
    print("\n--- ENDPOINTS ÚNICOS (método + ruta) ---")
    uniq = collections.OrderedDict()
    for r in regs:
        ruta = r["url_redactada"].split("?")[0]
        clave = (r["metodo"], ruta)
        uniq.setdefault(clave, []).append(r)
    for (met, ruta), lista in uniq.items():
        print(f"  {met:6} {ruta}   ({len(lista)}x)")

    # --- contrato detallado del primer ejemplo de cada endpoint
    print("\n" + "=" * 78)
    print(" CONTRATO DETALLADO POR ENDPOINT")
    print("=" * 78)
    informe = []
    for (met, ruta), lista in uniq.items():
        ej = lista[0]
        print(f"\n{'─'*78}\n### {met} {ruta}")
        print(f"  etapa      : {ej['etapa']}")
        print(f"  status     : {ej['status']}")
        print(f"  llamadas   : {len(lista)}")
        print(f"  QUERY      : {json.dumps(ej['request']['query'], ensure_ascii=False)}")
        print(f"  HEADERS req:")
        for k, v in ej["request"]["headers"].items():
            if k.lower() in ("authorization","app-key","x-media","content-type",
                             "accept","user-agent","x-api-key","deviceid"):
                print(f"      {k}: {v}")
        print(f"  BODY req   : {json.dumps(ej['request']['body'], ensure_ascii=False)[:700]}")
        print(f"  HEADERS res:")
        for k, v in ej["response"]["headers"].items():
            if k.lower() in ("content-type","x-correlation-id","x-request-id"):
                print(f"      {k}: {v}")
        print(f"  BODY res   : {json.dumps(ej['response']['body'], ensure_ascii=False)[:900]}")
        # código de respuesta si existe
        b = ej["response"]["body"]
        if isinstance(b, dict):
            for k in ("code","codigo","status","message","description"):
                if k in b:
                    print(f"  >>> {k} = {b[k]}")
        informe.append({"metodo": met, "ruta": ruta, "etapa": ej["etapa"],
                        "status": ej["status"], "ejemplo": ej})

    # guardar informe
    salida = os.path.join(carpeta, "CONTRATOS.json")
    with open(salida, "w", encoding="utf-8") as f:
        json.dump(informe, f, ensure_ascii=False, indent=2)
    print(f"\n{'='*78}")
    print(f" Informe guardado en: {salida}")
    print(f"{'='*78}\n")

if __name__ == "__main__":
    main()
