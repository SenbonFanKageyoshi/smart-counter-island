@echo off
rem 测试通知触发程序：运行后发送 Windows Toast 通知（小岛应弹出显示）
cd /d "%~dp0\.."
start "" node_modules\.bin\electron.cmd scripts\toast-test.js
