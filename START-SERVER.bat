@echo off
title IB Planner — Local Server
color 1F
echo.
echo  =============================================
echo   IB Planner — Starting Local Server
echo  =============================================
echo.
echo  Opening at: http://localhost:8080
echo  Press Ctrl+C to stop the server.
echo.

:: Try Python 3 first
python --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Python found. Starting server...
    echo.
    start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:8080/login.html"
    python -m http.server 8080
    goto :end
)

:: Try py launcher
py --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Python (py) found. Starting server...
    echo.
    start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:8080/login.html"
    py -m http.server 8080
    goto :end
)

:: Try Node.js npx http-server
node --version >nul 2>&1
if %errorlevel% == 0 (
    echo  [OK] Node.js found. Starting server...
    echo.
    start "" /b cmd /c "timeout /t 3 >nul && start http://localhost:8080/login.html"
    npx --yes http-server -p 8080 -c-1
    goto :end
)

:: Nothing found
echo  [ERROR] Neither Python nor Node.js is installed.
echo.
echo  Please install one of the following:
echo    - Python (free): https://www.python.org/downloads/
echo    - Node.js (free): https://nodejs.org/
echo.
echo  After installing, double-click this file again.
echo.
pause

:end
