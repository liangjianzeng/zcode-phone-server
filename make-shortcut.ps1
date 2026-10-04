# 一次性工具：在 Windows 启动文件夹创建 zcode-phone-server 自启快捷方式
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\ZcodePhoneServer.lnk")
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "E:\DTXY\DSH-Phone\zcode-phone-server\start-hidden.ps1"'
$lnk.WindowStyle = 7
$lnk.Description = "zcode-phone-server keepalive (logon autostart)"
$lnk.Save()
Write-Output "lnk created"
