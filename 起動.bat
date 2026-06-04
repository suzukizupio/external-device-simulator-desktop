@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install
)
echo Starting External Device Simulator...
call npm start
