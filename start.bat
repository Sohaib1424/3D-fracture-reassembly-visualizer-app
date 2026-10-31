@echo off
rem Reassembly Visualizer: starts a small server on this computer and opens the page.
rem To start on a folder of dumps, drop the folder on this file, or run:  start.bat "E:\dumps"
cd /d "%~dp0"
set "PYTHON="
where py >nul 2>nul && set "PYTHON=py -3"
if not defined PYTHON where python >nul 2>nul && set "PYTHON=python"
if not defined PYTHON (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)
%PYTHON% serve.py %*
if errorlevel 1 pause
