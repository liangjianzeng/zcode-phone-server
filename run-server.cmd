@echo off
rem zcode-phone-server 守护脚本：进程退出后 3 秒自动重启，独立于 ZCode 生命周期
rem 幂等修复(2026-11-03)：此前端口被占时仍盲目拉起 -> EADDRINUSE 每 3 秒崩溃一次无限刷日志
rem （keepalive.log/server.log 暴涨，日志全被 EADDRINUSE 堆栈淹没，故障无法定位）。
rem 现改为：端口有监听者时只等待接管（5 秒复查），原实例退出后自动补位重启；
rem 多个守护实例共存安全（输家等待，赢家服务），手动拉起 server.mjs 也不再打架。
cd /d "%~dp0"
rem 全新 clone 没有 logs/ 目录：cmd 重定向不会创建目录，下面两行重定向会直接
rem 失败导致 node 根本拉不起来（守护循环空转、keepalive.log 也写不出）——先建目录
if not exist logs mkdir logs
rem node 解析不依赖 PATH（守护的继承环境可能没有 node：9009 → 探测失败 → PORT 清空
rem → findstr ": " 误匹配全部 LISTENING 行 → 永远静默等待，从不启动）。与 config.json
rem 的 nodePath 同源（nvm4w 常规安装位优先，其次 Program Files，最后 PATH 兜底）
set NODE_EXE=node
if exist "C:\nvm4w\nodejs\node.exe" set NODE_EXE=C:\nvm4w\nodejs\node.exe
if not exist "%NODE_EXE%" if exist "%ProgramFiles%\nodejs\node.exe" set NODE_EXE=%ProgramFiles%\nodejs\node.exe
rem 端口以 config.json 为单一来源（与 server.mjs 一致），读取失败回落 8787
set PORT=8787
"%NODE_EXE%" -e "try{const c=JSON.parse(require('fs').readFileSync('config.json','utf8'));process.stdout.write(String(c.port||8787))}catch(e){process.stdout.write('8787')}" > "%TEMP%\zps_port.txt" 2>nul
set /p PORT=<"%TEMP%\zps_port.txt"
set PORT=%PORT: =%

:loop
rem 端口已有监听者 = 已有实例在服务：不拉起，5 秒后复查，等它退出后接管
netstat -ano -p TCP | findstr /c:":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  timeout /t 5 /nobreak >nul
  goto loop
)
rem 路径全部用 %~dp0 绝对形式：工作目录不对时相对路径会让 echo 写丢、node 找不到
rem server.mjs——守护沦为静默空转循环（2026-11-10 孤儿守护卡死 3 天的教训）
echo [%date% %time%] server starting >> "%~dp0logs\keepalive.log"
"%NODE_EXE%" "%~dp0server.mjs" >> "%~dp0logs\server.log" 2>&1
echo [%date% %time%] server exited (code %errorlevel%), restarting in 3s >> "%~dp0logs\keepalive.log"
timeout /t 3 /nobreak >nul
goto loop
