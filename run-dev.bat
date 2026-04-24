@echo off
set PATH=C:\tools\mingw64\bin;C:\Program Files\nodejs;C:\Users\41064\AppData\Roaming\npm;C:\Users\41064\.cargo\bin;%PATH%
set COREPACK_ENABLE_STRICT=0
cd /d C:\Projects\xxlink-client
node "C:\Users\41064\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs" dev
pause
