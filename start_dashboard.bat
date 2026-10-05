@echo off
cd /d "%~dp0"
echo Starting Crime Dashboard server...
where python >nul 2>nul
if %errorlevel%==0 (
  python dev_server.py --host 127.0.0.1 --port 8085
) else (
  py dev_server.py --host 127.0.0.1 --port 8085
)
echo.
echo Server stopped. Press any key to close.
pause >nul
