#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  python3 - <<'PY'
import os,secrets
fd=os.open('.env',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
    for key in ['MAYA_ACCESS_TOKEN','COMPANY_A_TOKEN','COMPANY_B_TOKEN']:
        f.write(key+'='+secrets.token_urlsafe(32)+'\n')
PY
fi
docker compose pull
docker compose up --detach --wait
printf '\nMAYA: http://localhost:%s\nCompany A: http://localhost:%s\nCompany B: http://localhost:%s\n\nUse MAYA_ACCESS_TOKEN from deploy/.env to sign in. Keep that file private.\n' "${MAYA_PORT:-4200}" "${COMPANY_A_PORT:-4100}" "${COMPANY_B_PORT:-4300}"
