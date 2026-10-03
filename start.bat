@echo off
rem zcode-phone-server 启动脚本：使用项目自带的 Node 22 运行桥接服务
"%~dp0..\tools\node22\node.exe" "%~dp0server.mjs" %*
