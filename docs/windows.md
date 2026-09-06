# Windows 版

目标平台：Windows 10/11 x64。基于 Tauri 2 + Edge WebView2，不需要重写前端。

## 安装与数据

在本仓库 Actions 的成功 CI 中下载 `scholay-tody-Windows-<commit>`，解压后运行 NSIS `setup.exe`。按当前用户安装，无需把程序放入系统目录。安装器会在缺少 WebView2 时调用微软官方引导安装器，首次安装需要网络。

当前二进制尚未购买 Windows 代码签名证书，可能出现 SmartScreen 提醒。请核对仓库、提交与 SHA-256；不要为了安装而关闭系统安全保护。

Windows 使用自己的本地资料库，不会自动同步 Mac 上的订阅、阅读记录或凭证。订阅可通过 OPML 导入；需要完整迁移时，应另做停机备份及版本核对，不能复制正在写入的 SQLite/WAL 文件。不要把个人资料库提交到 Git。

## 功能

- Reading / Web / AI formatted 使用同一套交互、外部 AI 配置、订阅与目录代码。
- 原网页使用 WebView2；主框架抓取运行在独立脚本环境，检查 URL、文档 ID 和导航版本后再接受结果。不开放浏览器调试端口，也不让网页调用原生导出或 MCP。
- 图文导出继续产生 Markdown、JSON、来源清单和本地图片 ZIP。离线包格式与 Mac 相同。
- MCP 使用 Windows 命名管道，限制为当前 Windows 账户并拒绝远程客户端；默认关闭、写权限单独开启。设置页生成对应 `.exe` 和管道地址的客户端配置。
- Product Hunt 的 API 令牌保存在 Windows Credential Manager，单项上限 2560 字节；其他 AI 服务沿用既有配置机制。

## 可选授权连接器

普通 RSS 不需要下面的组件。它们没有捆绑个人账号或登录会话，也不会在安装主程序时自动下载。

### 知乎

使用[知乎官方发布目录](https://developer-cdn.zhihu.com/zhihu-cli/releases/stable/manifest.json)的 `zhihu-cli`，不是第三方同名 npm/PyPI 工具。

在项目根目录，用 PowerShell 显式运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-zhihu-windows.ps1
```

这只为该进程选择执行策略，不修改全局策略。脚本验证官方 HTTPS 来源、压缩包大小、SHA-256 和版本，安装到 `%LOCALAPPDATA%\ZhihuCLI\current\zhihu-cli.exe`，已有安装不覆盖。随后在应用「设置 → 平台与授权」输入自己申请的 Access Secret；凭证交由官方 CLI 的系统凭证库管理。

### 微信公众号

使用独立的 [WechRss](https://github.com/johamwon/wechrss)。本应用最初对接版本为 4.1.0、提交 `a99675f7ef1f3d457991d441a9124d3f6666bd45`。

按其上游说明安装 Python，下载源码并运行 `start.bat`。服务保持监听 `127.0.0.1:8080`，不要改成公网或局域网监听。回到「设置 → 平台与授权」点击「扫码 / 管理授权」。扫码必须由用户本人完成；连接器在线、保存过凭证、最近抓取成功是不同状态。

主应用不安装开机服务、不迁移旧会话、不绕过平台登录。初次启动 WechRss 可能下载 Python 依赖及 Chromium。支持 `/api/health`、`/api/sources` 和 `/settings` 的本机连接器是当前兼容边界。

## 从源码构建

先准备 Node.js 22、pnpm 9、Rust stable、Visual Studio C++ Build Tools 和 Windows SDK，再执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm prepare:mcp
cargo test --workspace --locked
cargo run --locked -p papr --features windows-smoke --example windows-smoke
pnpm build:desktop
```

安装器在 `target/release/bundle/nsis/`。`prepare:mcp` 会构建并打包同一平台的伴随程序，不会误装 macOS 二进制。

WebView2 smoke 使用独立临时浏览器配置和虚构文章，验证真实渲染、中文、隔离抓取、排除表单/隐藏内容及带图 ZIP，不访问用户数据库或模型。它不等同于已验证每个平台的登录成功，也不覆盖所有 DPI、网页与 Windows 驱动组合。

## CI/CD

- 推送 `main` / `codex/**` 或提交 PR：执行前端测试、Mac/Windows 原生测试和打包，另跑 Linux 核心库测试。
- Windows CI 额外运行真实 WebView2 图文 smoke；构建失败不上传安装包。
- 每个成功的桌面任务保留安装包/应用 ZIP 和 SHA-256，默认保留 30 天。
- 推送 `v*` 标签：重新测试并生成 Windows Release **草稿**，由维护者检查后发布。
- 不需要 AI、知乎、微信密钥；不要向 Actions 上传私人账号或数据库。默认 Actions Token 只读，只有 Release 草稿任务获得仓库写权限。
- 原 Papr 自动更新仍禁用；没有签名与校验的自建更新源前，不自动替换用户已安装的程序。

抓取实现参考：[WebView2 CDP](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/chromium-devtools-protocol)、[Chromium 隔离脚本环境](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-createIsolatedWorld)。
