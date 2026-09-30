Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\PROYECTOS\bot raul"
sh.Run "cmd /c set INTERVALO_MS=250&& set HILOS=3&& node tools\atacante-apk.js --comprar >> logs\atacante-consola.log 2>&1", 0, False
