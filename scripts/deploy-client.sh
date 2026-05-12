#!/usr/bin/env bash
# Deploy the XXLink Windows x64 client to the first-party download host.
#
# The script publishes three things together:
#   1. NSIS installer: https://api.xxlink.net/download/XXLink_<version>_x64-setup.exe
#   2. Tauri updater signature: same directory as the installer
#   3. Updater manifest: https://api.xxlink.net/updater/update.json
#
# Usage:
#   bash scripts/deploy-client.sh

set -euo pipefail

REMOTE_USER="root"
REMOTE_HOST="108.61.207.72"
REMOTE_DL_DIR="/opt/vps-airport/infra/nginx/downloads"
REMOTE_UPDATER_DIR="/opt/vps-airport/infra/nginx/updater"
REMOTE_LANDING_FILE="/opt/vps-airport/landing/components/download.tsx"
REMOTE_INFRA_DIR="/opt/vps-airport/infra"
DOWNLOAD_HOST="https://api.xxlink.net"
LANDING_HOST="https://xxlink.net"

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
INSTALLER="target/x86_64-pc-windows-gnu/release/bundle/nsis/XXLink_${VERSION}_x64-setup.exe"
SIGNATURE="${INSTALLER}.sig"
DOWNLOAD_URL="${DOWNLOAD_HOST}/download/XXLink_${VERSION}_x64-setup.exe"
UPDATE_JSON="$(mktemp)"

cleanup() {
  rm -f "${UPDATE_JSON}"
}
trap cleanup EXIT

echo "Deploying XXLink ${VERSION}"
echo "  Installer: ${INSTALLER}"
echo "  Download:  ${DOWNLOAD_URL}"
echo

if [[ ! -f "${INSTALLER}" ]]; then
  echo "Installer not found: ${INSTALLER}"
  echo "Run: corepack pnpm tauri build --target x86_64-pc-windows-gnu"
  exit 1
fi

if [[ ! -f "${SIGNATURE}" ]]; then
  echo "Updater signature not found: ${SIGNATURE}"
  echo "Build with TAURI_SIGNING_PRIVATE_KEY so auto-update can verify the installer."
  exit 1
fi

CARGO_VER=$(grep -E '^version = "[^"]+"' src-tauri/Cargo.toml | head -1 | cut -d\" -f2)
TAURI_VER=$(node -p "require('./src-tauri/tauri.conf.json').version")
if [[ "${VERSION}" != "${CARGO_VER}" || "${VERSION}" != "${TAURI_VER}" ]]; then
  echo "Version mismatch across manifest files:"
  echo "  package.json:    ${VERSION}"
  echo "  Cargo.toml:      ${CARGO_VER}"
  echo "  tauri.conf.json: ${TAURI_VER}"
  exit 1
fi

echo "[1/5] Generating updater manifest..."
VERSION="${VERSION}" DOWNLOAD_URL="${DOWNLOAD_URL}" SIGNATURE="${SIGNATURE}" node <<'NODE_EOF' > "${UPDATE_JSON}"
const fs = require('fs')

const signature = fs.readFileSync(process.env.SIGNATURE, 'utf8').trim()
const data = {
  version: process.env.VERSION,
  notes: '优化启动响应速度，修复首次打开未响应问题。',
  pub_date: new Date().toISOString(),
  platforms: {
    win64: {
      signature,
      url: process.env.DOWNLOAD_URL,
    },
    'windows-x86_64': {
      signature,
      url: process.env.DOWNLOAD_URL,
    },
  },
}

process.stdout.write(JSON.stringify(data, null, 2))
NODE_EOF

echo "[2/5] Uploading installer, signature, and updater manifest..."
ssh "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p '${REMOTE_DL_DIR}' '${REMOTE_UPDATER_DIR}'"
scp -q "${INSTALLER}" "${SIGNATURE}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DL_DIR}/"
scp -q "${UPDATE_JSON}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_UPDATER_DIR}/update.json"

echo "[3/5] Updating landing download card..."
DATE_LABEL=$(date +"%Y年%-m月" 2>/dev/null || date +"%Y年%m月")

ssh "${REMOTE_USER}@${REMOTE_HOST}" bash <<REMOTE_EOF
set -e
sed -i -E 's|XXLink_[0-9]+\.[0-9]+\.[0-9]+_x64-setup\.exe|XXLink_${VERSION}_x64-setup.exe|g' "${REMOTE_LANDING_FILE}"
sed -i -E 's|Windows 版本 [0-9]+\.[0-9]+\.[0-9]+|Windows 版本 ${VERSION}|g' "${REMOTE_LANDING_FILE}"
sed -i -E 's|更新于 [0-9]{4}年[0-9]{1,2}月|更新于 ${DATE_LABEL}|g' "${REMOTE_LANDING_FILE}"
sed -i -E 's|https://github\.com/[^"'\'' ]+/releases/tag/v[0-9]+\.[0-9]+\.[0-9]+|${LANDING_HOST}/|g' "${REMOTE_LANDING_FILE}"
REMOTE_EOF

echo "[4/5] Rebuilding landing container..."
ssh "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_INFRA_DIR} && docker-compose up -d --build landing 2>&1 | tail -3"

echo "[5/5] Verifying public URLs..."
sleep 2

HTTP_CODE=$(curl -o /dev/null -sS -w "%{http_code}" -I "${DOWNLOAD_URL}")
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "Download URL returned HTTP ${HTTP_CODE}"
  exit 1
fi

UPDATE_URL="${DOWNLOAD_HOST}/updater/update.json"
UPDATE_CODE=$(curl -o /dev/null -sS -w "%{http_code}" -I "${UPDATE_URL}")
if [[ "${UPDATE_CODE}" != "200" ]]; then
  echo "Updater manifest returned HTTP ${UPDATE_CODE}"
  exit 1
fi

REMOTE_VERSION=$(curl -fsS "${UPDATE_URL}" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version||''))")
if [[ "${REMOTE_VERSION}" != "${VERSION}" ]]; then
  echo "Updater manifest version mismatch: ${REMOTE_VERSION}"
  exit 1
fi

CONTENT_LENGTH=$(curl -sSI "${DOWNLOAD_URL}" | grep -i '^content-length:' | awk '{print $2}' | tr -d '\r')
SIZE_MB=$(awk "BEGIN { printf \"%.1f\", ${CONTENT_LENGTH}/1024/1024 }")

echo
echo "Deployed XXLink ${VERSION}"
echo "  Download: ${DOWNLOAD_URL}"
echo "  Updater:  ${UPDATE_URL}"
echo "  Size:     ${SIZE_MB} MB"
echo "  Landing:  ${LANDING_HOST}/"
echo
echo "Optional archive:"
echo "  git tag v${VERSION} && git push origin v${VERSION}"
echo "  gh release create v${VERSION} ${INSTALLER} ${SIGNATURE} --notes-from-tag"
