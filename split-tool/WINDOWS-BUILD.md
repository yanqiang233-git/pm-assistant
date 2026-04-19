# Windows 构建指南

> **本文档供 AI 助手在 Windows 电脑上快速完成打包使用。**
> 人类开发者也可直接参照执行。

---

## 一、项目概况

| 项目 | 值 |
|------|-----|
| 应用名称 | 项目经理助手 |
| 技术栈 | Tauri v2 + Vite v8 + TypeScript v6 + xlsx |
| 前端多页面 | `index.html`（工作台） + `modules/material-split/index.html`（模块） |
| Rust 入口 | `src-tauri/src/main.rs`（注册 dialog + fs 插件） |
| 打包标识 | `com.pm-assistant.desktop` |
| 产物类型 | NSIS 安装包 (.exe) + MSI 安装包 (.msi) |

---

## 零、推荐路径

当前项目支持两条 Windows 打包路径：

### 路径 A：本机 Windows 打包

适合已有 Windows 电脑，并且需要本地直接生成安装包。

### 路径 B：GitHub Actions 云打包

适合不想复制整个项目到 Windows 电脑，或者希望后续按标准流程一键打包。

**推荐优先使用路径 B。**

云打包标准流程见：

- `../docs/Windows云打包标准流程.md`

---

## 二、环境要求

### 2.1 必要软件

| 软件 | 最低版本 | 安装方式 | 验证命令 |
|------|----------|----------|----------|
| Node.js | 18+ | https://nodejs.org/ 下载 LTS | `node --version` |
| npm | 9+ | 随 Node.js 自带 | `npm --version` |
| Rust | 1.70+ | https://rustup.rs/ | `rustc --version` |
| Visual Studio Build Tools | 2022 | 见下方说明 | `cl` 或查看已安装组件 |

### 2.2 Visual Studio Build Tools 安装（关键步骤）

Tauri 在 Windows 上需要 MSVC 编译工具链。如果未安装：

1. 下载 [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/zh-hans/visual-cpp-build-tools/)
2. 运行安装程序，勾选以下工作负载：
   - **"使用 C++ 的桌面开发"**（Desktop development with C++）
3. 确保以下组件被选中（通常默认已选）：
   - MSVC v143 C++ 生成工具
   - Windows 10/11 SDK
4. 安装完成后**重启终端**

### 2.3 WebView2 运行时

Tauri v2 依赖 Microsoft Edge WebView2。Windows 10 (1803+) 和 Windows 11 通常已预装。

当前 `tauri.conf.json` 配置为 `downloadBootstrapper` 模式：安装包运行时会自动下载安装 WebView2（如果用户电脑缺失）。

---

## 三、一键打包

### 方法 A：运行批处理脚本

```cmd
cd split-tool
build-windows.bat
```

### 方法 B：手动执行

```powershell
cd split-tool

# 1. 安装 npm 依赖
npm install

# 2.（可选）更新图标 — 如果替换了 src-tauri/icons/app-icon.png
npx tauri icon src-tauri\icons\app-icon.png

# 3. 打包
npm run tauri build
```

`npm run tauri build` 会自动执行：
- `npm run build`（TypeScript 编译 + Vite 构建前端到 `dist/`）
- Cargo 编译 Rust 后端（Release 模式）
- 生成 NSIS 安装包 + MSI 安装包

---

## 四、产物位置

构建成功后，安装包位于：

```
split-tool/src-tauri/target/release/bundle/
├── nsis/
│   └── 项目经理助手_1.0.0_x64-setup.exe    ← NSIS 安装包（推荐分发）
└── msi/
    └── 项目经理助手_1.0.0_x64_zh-CN.msi    ← MSI 安装包
```

| 产物 | 格式 | 说明 |
|------|------|------|
| NSIS .exe | 安装向导 | 推荐分发，支持自定义安装路径，中文界面 |
| MSI .msi | Windows Installer | 企业部署，支持组策略推送 |

独立可执行文件（不含安装器）：
```
split-tool/src-tauri/target/release/项目经理助手.exe
```

---

## 五、NSIS 安装包配置说明

当前 `tauri.conf.json` 中的 Windows 打包配置：

```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "installMode": "perMachine",
        "languages": ["SimpChinese"],
        "displayLanguageSelector": false
      },
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      }
    }
  }
}
```

| 配置项 | 当前值 | 说明 |
|--------|--------|------|
| `installMode` | `perMachine` | 为所有用户安装（需管理员权限） |
| `languages` | `["SimpChinese"]` | 安装界面语言：简体中文 |
| `displayLanguageSelector` | `false` | 不显示语言选择器 |
| `webviewInstallMode.type` | `downloadBootstrapper` | 自动下载 WebView2（如缺失） |

如需改为仅当前用户安装（无需管理员）：将 `installMode` 改为 `"currentUser"`。

---

## 六、常见问题排查

### Q1: `error: linker 'link.exe' not found`
**原因：** 未安装 Visual Studio Build Tools 或未选择 C++ 工作负载。
**解决：** 安装 Build Tools 2022 并勾选"使用 C++ 的桌面开发"，重启终端。

### Q2: `npm run build` 失败
**原因：** TypeScript 编译错误或依赖未安装。
**解决：**
```cmd
npm install
npx tsc --noEmit
```
查看具体错误后修复。

### Q3: `error[E0463]: can't find crate for 'std'`
**原因：** Rust 工具链不完整。
**解决：**
```cmd
rustup toolchain install stable-x86_64-pc-windows-msvc
rustup default stable-msvc
```

### Q4: 图标异常或缺失
**原因：** `src-tauri/icons/` 下缺少 `icon.ico` 或各尺寸 PNG。
**解决：** 准备一张 1024×1024 的 PNG 命名为 `app-icon.png` 放入 `src-tauri/icons/`，然后运行：
```cmd
npx tauri icon src-tauri\icons\app-icon.png
```

### Q5: 打包速度慢（首次）
首次构建需编译所有 Rust 依赖（约 300+ crates），耗时可达 5-15 分钟。后续增量构建会很快。
可通过以下方式加速：
```cmd
set CARGO_INCREMENTAL=1
npm run tauri build
```

### Q6: `beforeDevCommand` 报错 `sh: not found`
**说明：** `tauri.conf.json` 中 `beforeDevCommand` 使用了 `sh start-dev.sh`，这是 macOS/Linux 命令。
**Windows 开发模式：** 直接运行：
```cmd
npm run dev
:: 另一个终端
npm run tauri dev -- --no-dev-server-wait
```
或安装 Git Bash 后在 Git Bash 终端中运行 `npm run tauri dev`。

---

## 七、版本更新打包

修改版本号后重新打包：

1. 更新 `package.json` 中的 `version`
2. 更新 `src-tauri/tauri.conf.json` 中的 `version`
3. 更新 `src-tauri/Cargo.toml` 中的 `version`
4. 运行 `npm run tauri build`

三处版本号建议保持一致。

---

## 八、关键文件清单（AI 参考）

| 文件 | 作用 | 打包时是否需要修改 |
|------|------|-------------------|
| `package.json` | npm 依赖和构建脚本 | 通常不需要 |
| `tsconfig.json` | TypeScript 配置 | 不需要 |
| `vite.config.ts` | 前端构建配置（多页面入口） | 不需要 |
| `src-tauri/tauri.conf.json` | Tauri 应用配置（名称、图标、打包） | 可能需要改版本号 |
| `src-tauri/Cargo.toml` | Rust 依赖配置 | 可能需要改版本号 |
| `src-tauri/capabilities/default.json` | Tauri 权限配置 | 不需要 |
| `src-tauri/src/main.rs` | Rust 入口 | 不需要 |
| `build-windows.bat` | 一键打包脚本 | 不需要 |

---

## 九、AI 快速打包指令模板

将项目文件夹复制到 Windows 电脑后，AI 可直接执行以下流程：

```
1. 检查环境：node --version && rustc --version && cargo --version
2. 进入目录：cd split-tool
3. 安装依赖：npm install
4. 类型检查：npx tsc --noEmit
5. 执行打包：npm run tauri build
6. 验证产物：dir src-tauri\target\release\bundle\nsis\
```

如果环境未就绪，按第二节指引安装即可。

---

## 十、推荐的后续使用方式

如果你的目标是后续反复执行 Windows 打包，并且尽量减少人工操作，建议改用 GitHub Actions 云打包。

标准入口文档：

- `../docs/Windows云打包标准流程.md`

后续你只需要：

1. 修改版本号
2. 提交并推送
3. 在 GitHub Actions 中点击 `Build Windows App`
4. 下载构建产物

这样不需要把整个项目目录复制到 Windows 电脑。
