# XXLink 客户端发版手册

> 本文档记录当前发版流程、版本号规则、以及将来启用"无感自动更新"所需步骤。

## 一、当前发版流程（手动下载）

### 触发条件

- 修复 bug、加新功能、调接口、改 UI

### 步骤

**1. 同步改版本号（3 个文件必须一致）**

| 文件                        | 字段         | 例        |
| --------------------------- | ------------ | --------- |
| `package.json`              | `"version"`  | `"1.0.2"` |
| `src-tauri/Cargo.toml`      | `version = ` | `"1.0.2"` |
| `src-tauri/tauri.conf.json` | `"version"`  | `"1.0.2"` |

三个值不一致时，`tauri build` 会失败或生成错误文件名的安装包。`scripts/deploy-client.sh` 也会在部署前做一致性校验。

**2. 本地打 release 包**

```bash
# 杀掉占用文件的旧 dev 实例
taskkill //F //IM xxlink-client.exe
taskkill //F //IM verge-mihomo.exe

# 构建
pnpm tauri build --target x86_64-pc-windows-gnu
```

生成物：

```
target/x86_64-pc-windows-gnu/release/bundle/nsis/XXLink_<version>_x64-setup.exe
```

> **最后出现 `Error: TAURI_SIGNING_PRIVATE_KEY` 是假错误**，忽略。安装包本身已生成。这是因为 `tauri.conf.json` 里保留了 `updater.pubkey` 但我们没配私钥——下节有启用方法。

**3. 一键部署到 VPS**

```bash
bash scripts/deploy-client.sh
```

脚本做的事：

1. 验证 3 个版本号一致
2. `scp` setup.exe 到 `root@108.61.207.72:/opt/vps-airport/infra/nginx/downloads/`
3. `sed` 改 `/opt/vps-airport/landing/components/download.tsx` 里的：
   - 下载 URL 文件名
   - "Windows 版本 X.X.X" 文案
   - "更新于 YYYY年M月" 日期
   - GitHub release tag 链接
4. `docker-compose up -d --build landing` 重建落地页容器
5. `curl -I` 验证 `https://api.xxlink.net/download/XXLink_<version>_x64-setup.exe` 返回 200

全程约 1-2 分钟（看网速 + 落地页 Next.js 构建）。

**4. 打 GitHub tag + release（可选但推荐）**

```bash
git tag -a v1.0.2 -m "XXLink 1.0.2 — <change summary>"
git push origin v1.0.2

gh release create v1.0.2 \
  --repo Inori9527/xxlink-client \
  --title "XXLink 1.0.2" \
  --notes "<changelog>" \
  target/x86_64-pc-windows-gnu/release/bundle/nsis/XXLink_1.0.2_x64-setup.exe
```

这一步给海外用户（能连 GitHub）提供下载源，以及留档 changelog。

### 用户升级体验

- 国内用户：打开 https://xxlink.net → 下载按钮 → 下载新版 → 双击 → UAC → NSIS 检测到已装旧版 → 自动 kill `xxlink-client.exe` → 覆盖所有文件 → 保留 `%APPDATA%` 数据 → 启动新版
- Windows 服务 `clash_verge_service` 路径不变，重启时会加载新的 `<INSTDIR>\resources\clash-verge-service.exe`
- 用户的 verge 配置、登录 token、节点选择都保留

---

## 二、版本号规则

遵循 SemVer：`MAJOR.MINOR.PATCH`

| 变化                  | 递增位 | 例            |
| --------------------- | ------ | ------------- |
| 新功能 / UI 重构      | MINOR  | 1.0.1 → 1.1.0 |
| Bug 修复 / 微调       | PATCH  | 1.0.1 → 1.0.2 |
| 破坏性改动 / 数据迁移 | MAJOR  | 1.x.x → 2.0.0 |

初版从 1.0.1 开始（1.0.0 保留给潜在的公测 hotfix 占位）。

---

## 三、部署基础设施

### VPS（`108.61.207.72`）

```
/opt/vps-airport/
├── infra/
│   ├── docker-compose.yml          # 全栈编排
│   ├── nginx/
│   │   ├── nginx.conf              # 所有 nginx 配置
│   │   ├── downloads/              # 本次新加：客户端安装包静态目录
│   │   │   └── XXLink_*_x64-setup.exe
│   │   └── ssl/                    # Let's Encrypt 证书
│   └── (backend / landing / admin / postgres / redis)
├── landing/                         # Next.js 落地页源码
│   └── components/download.tsx     # 下载按钮 URL 在这
└── backend/                         # Fastify API 源码
```

### 下载链接映射

| 用户                   | URL                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| 国内（Nginx 直出）     | https://api.xxlink.net/download/XXLink_<version>\_x64-setup.exe                                          |
| 海外（GitHub Release） | https://github.com/Inori9527/xxlink-client/releases/download/v<version>/XXLink\_<version>\_x64-setup.exe |
| 永久最新（GitHub）     | https://github.com/Inori9527/xxlink-client/releases/latest/download/XXLink_<version>\_x64-setup.exe      |

### Nginx 下载配置

位置：`/opt/vps-airport/infra/nginx/nginx.conf`，`api.xxlink.net` HTTPS server 块里：

```nginx
location /download/ {
    alias /usr/share/nginx/downloads/;
    autoindex off;
    add_header Cache-Control "public, max-age=3600";
    access_log /var/log/nginx/downloads.log main;
    sendfile on;
    tcp_nopush on;
}
```

Docker 挂载：`./nginx/downloads:/usr/share/nginx/downloads:ro`

---

## 四、启用无感自动更新（后续可做）

当前用户每次升级要手动去 xxlink.net 下新版。要让客户端启动时自动检查并下载更新，需要：

### 4.1 生成 Tauri updater 签名密钥

```bash
# 只做一次，终身用
pnpm tauri signer generate -w ~/.tauri/xxlink-updater.key
```

产出：

- 私钥：`~/.tauri/xxlink-updater.key`（**绝不能泄露 / 上传 git**）
- 公钥：`~/.tauri/xxlink-updater.key.pub`

当前 `src-tauri/tauri.conf.json` 里的 `updater.pubkey` 是从上游 Clash Verge Rev 继承的占位值，**必须替换成我们自己的公钥 base64**：

```json
"updater": {
  "pubkey": "<你的 xxlink-updater.key.pub 内容 base64 后填入>",
  "endpoints": [
    "https://api.xxlink.net/updater/update.json"
  ],
  "windows": { "installMode": "passive" }
}
```

### 4.2 构建时签名

```bash
# 环境变量（Windows PowerShell: $env:TAURI_SIGNING_PRIVATE_KEY="...")
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/xxlink-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""  # 生成时如果没设密码就留空

pnpm tauri build --target x86_64-pc-windows-gnu
```

这次 bundler 不会再吐 `Error: TAURI_SIGNING_PRIVATE_KEY`，并且会产出额外一个 `.sig` 文件：

```
target/.../bundle/nsis/XXLink_<version>_x64-setup.exe.sig
```

### 4.3 发布 `update.json`

把 `update.json` 放到 `api.xxlink.net/updater/update.json`，格式：

```json
{
  "version": "1.0.2",
  "notes": "修复 XXX，优化 YYY",
  "pub_date": "2026-05-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<setup.exe.sig 文件的内容>",
      "url": "https://api.xxlink.net/download/XXLink_1.0.2_x64-setup.exe"
    }
  }
}
```

扩展 nginx 配置服务 `/updater/` 目录，方式同 `/download/`。

### 4.4 扩展 deploy-client.sh

后续在脚本里加：

1. 自动读 `.sig` 文件内容
2. 生成并上传 `update.json`
3. scp 到 `/opt/vps-airport/infra/nginx/updater/update.json`

### 4.5 用户体验

客户端启动后 Tauri updater 会：

1. 请求 `https://api.xxlink.net/updater/update.json`
2. 对比 version 字段
3. 有新版 → 弹窗提示 → 用户点"更新" → 后台下载 → `installMode: passive` 静默安装 → 重启

---

## 五、紧急回滚

如果新版本有严重 bug 想回到旧版：

**方案 A（落地页改链接）**：

```bash
ssh root@108.61.207.72 \
  "sed -i 's|XXLink_1.0.2|XXLink_1.0.1|g' /opt/vps-airport/landing/components/download.tsx && \
   cd /opt/vps-airport/infra && docker-compose up -d --build landing"
```

用户接下来下的都是旧版。已下新版的用户不受影响（他们已经装了）。

**方案 B（物理删除新包）**：

```bash
ssh root@108.61.207.72 "rm /opt/vps-airport/infra/nginx/downloads/XXLink_1.0.2_x64-setup.exe"
```

直接让新包 404，落地页按钮失效（更糟——别用这个，先走方案 A）。

---

## 六、常见坑

| 现象                                                           | 原因                                  | 修法                                             |
| -------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| Release build 登录页样式全无                                   | MUI emotion CSS-in-JS 被 CSP nonce 拦 | `tauri.conf.json` 里保持 `"csp": null`（已固化） |
| NSIS 报 `sidecar/...aarch64-pc-windows-msvc.exe doesn't exist` | 默认 tauri build 尝试打包全架构       | 必须加 `--target x86_64-pc-windows-gnu`          |
| `manualChunks is not a function`                               | Rolldown 要求函数形式                 | `vite.config.mts` 已配好，别改成对象             |
| 退出码 1 但 setup.exe 已生成                                   | tauri updater 缺私钥                  | 假错误，按启用自动更新一节配                     |

---

## 七、快速参考

```bash
# 日常发版
#   1. 改 3 个版本号
#   2. pnpm tauri build --target x86_64-pc-windows-gnu
#   3. bash scripts/deploy-client.sh
#   4. git tag v<X.Y.Z> && git push origin v<X.Y.Z>
#   5. gh release create v<X.Y.Z> <installer> --notes "..."

# 回滚
#   见 § 五

# 启用自动更新
#   见 § 四（需要一次性配好密钥）
```
