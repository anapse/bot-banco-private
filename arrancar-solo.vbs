' Lanza el bot DESACOPLADO de la consola.
' Asi el bot sigue vivo aunque se cierre la ventana que lo lanzo.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\PROYECTOS\bot raul"
sh.Run "cmd /c node --use-system-ca server.js >> logs\consola.log 2>&1", 0, False
