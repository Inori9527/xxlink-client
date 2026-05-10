# XXLink Windows Client

XXLink 是面向 Windows 用户的加密网络客户端，提供一键连接、节点选择、套餐用量查看、公益流量领取、公告与更新提示等功能。

## 下载

请从官网下载安装：

https://xxlink.net/download

当前 Windows 客户端仅发布 x64 版本。旧 x86 客户端会保留在历史版本中，但不再作为新版下载入口。

## 功能

- 一键连接，浏览器加速与全局加速两种模式。
- 节点按城市与线路名称展示，复杂细节由客户端自动整理。
- 套餐页显示当前权益、周期用量与公益流量领取入口。
- 我的页面集中管理账号、公告、优惠码、更新检查与设置。
- 启动时检查最新公告，用户关闭后不会重复打扰，直到下一条新公告发布。

## 开发

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm web:build
```

Windows x64 打包：

```bash
corepack pnpm tauri build --target x86_64-pc-windows-gnu
```

## 注意

- 客户端用量展示以 `GET /api/v1/user/usage` 为准。
- 公益流量状态以 `GET /api/v1/user/public-benefit` 为准。
- `POST /api/v1/traffic/report` 仅作为连接心跳与超额检查，不作为账单用量来源。
