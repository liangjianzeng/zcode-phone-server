# zcode-phone-server 隐藏启动器：由计划任务在登录时调用，隐藏窗口拉起守护脚本
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c", "`"$PSScriptRoot\run-server.cmd`""
