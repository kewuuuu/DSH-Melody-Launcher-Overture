@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
rem KEWU 启动器卸载程序：双击运行会删掉同目录下的启动器 EXE，数据默认保留（加 --delete-data 才删数据）。
rem 用法：uninstall-kewu.cmd [--delete-data] [-ExePath "<其它位置的 EXE>"]
set "HERE=%~dp0"
set "EXE=%HERE%DSH-Launcher.exe"
if not exist "%EXE%" for %%F in ("%HERE%*.exe") do set "EXE=%%~fF"
set "EXTRA="
for %%A in (%*) do (
  if /i "%%~A"=="-ExePath" ( set "NEXTEXE=1" ) else (
    if defined NEXTEXE ( set "EXE=%%~A" & set "NEXTEXE=" ) else ( set "EXTRA=!EXTRA! %%~A" )
  )
)
echo 启动器 EXE：%EXE%
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%uninstall-kewu.ps1" -ExePath "%EXE%" !EXTRA!
exit /b %errorlevel%
