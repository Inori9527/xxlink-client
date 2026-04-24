#!/usr/bin/env bash
# =============================================================================
# deploy-client.sh — 一键发布 XXLink Windows 客户端
#
# 前提：
#   1. 已运行 `pnpm tauri build --target x86_64-pc-windows-gnu` 生成新 setup.exe
#   2. 已 `git tag v<version>` 并推送（可选但推荐）
#   3. 本机可 SSH 到 root@108.61.207.72（key-based）
#
# 步骤：
#   1. 从 package.json 读版本号
#   2. scp setup.exe 到 VPS 的 nginx downloads 目录
#   3. 更新 landing 组件里的版本号/日期/URL（保持一方下载域名）
#   4. 重建 landing 容器让页面生效
#   5. 验证下载链接返回 200
#
# 用法：
#   bash scripts/deploy-client.sh
# =============================================================================
set -euo pipefail

# --- 配置 ---------------------------------------------------------------
REMOTE_USER="root"
REMOTE_HOST="108.61.207.72"
REMOTE_DL_DIR="/opt/vps-airport/infra/nginx/downloads"
REMOTE_LANDING_FILE="/opt/vps-airport/landing/components/download.tsx"
REMOTE_INFRA_DIR="/opt/vps-airport/infra"
DOWNLOAD_HOST="https://api.xxlink.net"
LANDING_HOST="https://xxlink.net"

# --- 读版本号 -----------------------------------------------------------
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
INSTALLER="src-tauri/../target/x86_64-pc-windows-gnu/release/bundle/nsis/XXLink_${VERSION}_x64-setup.exe"
INSTALLER="target/x86_64-pc-windows-gnu/release/bundle/nsis/XXLink_${VERSION}_x64-setup.exe"
DOWNLOAD_URL="${DOWNLOAD_HOST}/download/XXLink_${VERSION}_x64-setup.exe"

echo "🚀 Deploying XXLink ${VERSION}"
echo "   Installer: ${INSTALLER}"
echo "   URL:       ${DOWNLOAD_URL}"
echo

# --- 检查 ---------------------------------------------------------------
if [[ ! -f "${INSTALLER}" ]]; then
  echo "❌ Installer not found: ${INSTALLER}"
  echo "   Run: pnpm tauri build --target x86_64-pc-windows-gnu"
  exit 1
fi

# --- 一致性检查 ---------------------------------------------------------
CARGO_VER=$(grep -E '^version = "[^"]+"' src-tauri/Cargo.toml | head -1 | cut -d\" -f2)
TAURI_VER=$(node -p "require('./src-tauri/tauri.conf.json').version")
if [[ "${VERSION}" != "${CARGO_VER}" || "${VERSION}" != "${TAURI_VER}" ]]; then
  echo "❌ Version mismatch across manifest files:"
  echo "   package.json:     ${VERSION}"
  echo "   Cargo.toml:       ${CARGO_VER}"
  echo "   tauri.conf.json:  ${TAURI_VER}"
  exit 1
fi

# --- 上传 ---------------------------------------------------------------
echo "📤 [1/4] Uploading installer (${INSTALLER})..."
scp -q "${INSTALLER}" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DL_DIR}/"

# --- 更新 landing 组件 + 重建 -------------------------------------------
echo "🔧 [2/4] Patching landing download component..."
DATE_LABEL=$(date +"%Y年%-m月" 2>/dev/null || date +"%Y年%m月")

ssh "${REMOTE_USER}@${REMOTE_HOST}" bash <<REMOTE_EOF
set -e
# Replace download URL filename
sed -i -E 's|XXLink_[0-9]+\.[0-9]+\.[0-9]+_x64-setup\.exe|XXLink_${VERSION}_x64-setup.exe|g' "${REMOTE_LANDING_FILE}"
# Replace version label
sed -i -E 's|Windows 版本 [0-9]+\.[0-9]+\.[0-9]+|Windows 版本 ${VERSION}|g' "${REMOTE_LANDING_FILE}"
# Replace date label
sed -i -E 's|更新于 [0-9]{4}年[0-9]{1,2}月|更新于 ${DATE_LABEL}|g' "${REMOTE_LANDING_FILE}"
# Replace any GitHub release link with the first-party landing page
sed -i -E 's|https://github\.com/[^"'\'' ]+/releases/tag/v[0-9]+\.[0-9]+\.[0-9]+|${LANDING_HOST}/|g' "${REMOTE_LANDING_FILE}"
REMOTE_EOF

echo "🔨 [3/4] Rebuilding landing container..."
ssh "${REMOTE_USER}@${REMOTE_HOST}" "cd ${REMOTE_INFRA_DIR} && docker-compose up -d --build landing 2>&1 | tail -3"

# --- 验证 ---------------------------------------------------------------
echo "🔍 [4/4] Verifying download URL..."
sleep 2
HTTP_CODE=$(curl -o /dev/null -sS -w "%{http_code}" -I "${DOWNLOAD_URL}")
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "❌ Download URL returned HTTP ${HTTP_CODE}"
  exit 1
fi

CONTENT_LENGTH=$(curl -sSI "${DOWNLOAD_URL}" | grep -i '^content-length:' | awk '{print $2}' | tr -d '\r')
SIZE_MB=$(awk "BEGIN { printf \"%.1f\", ${CONTENT_LENGTH}/1024/1024 }")

echo
echo "✅ Deployed XXLink ${VERSION}"
echo "   Download:  ${DOWNLOAD_URL}"
echo "   Size:      ${SIZE_MB} MB"
echo "   Landing:   ${LANDING_HOST}/"
echo
echo "下一步（可选）："
echo "  git tag v${VERSION} && git push origin v${VERSION}"
echo "  gh release create v${VERSION} ${INSTALLER} --notes-from-tag"
