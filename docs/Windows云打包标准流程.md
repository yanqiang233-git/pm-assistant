# Windows 云打包标准流程

> 本文档用于 GitHub Actions 云端 Windows 打包。
> 目标是让后续打包变成标准流程：准备版本文件、手动触发打包工作流、下载安装包。

---

## 一、适用场景

当你满足以下任意一个条件时，优先使用本流程：

- 本地项目目录过大，不想复制到 Windows 电脑
- 没有可用的 Windows 开发机
- 希望以后 Windows 打包可以稳定复用
- 希望 AI 按固定步骤执行，不再每次重新解释流程

本流程基于仓库中的 GitHub Actions 工作流：

- `.github/workflows/build-windows.yml`

---

## 二、首次接入要求

首次使用前需要满足以下条件：

1. 项目已经初始化 Git 仓库
2. 项目已经推送到 GitHub 仓库
3. GitHub 仓库已启用 Actions
4. 默认分支为 `main`，或者你明确知道自己使用的分支名

说明：

- 本仓库中的 `.gitignore` 已忽略 `node_modules`、`dist`、`src-tauri/target`、`.vite` 等大目录
- 上传到 GitHub 的应是源码和配置，而不是构建缓存

---

## 三、标准打包步骤

### 3.1 更新版本号

每次正式打包前，先同步更新以下三个文件中的版本号：

1. `split-tool/package.json`
2. `split-tool/src-tauri/tauri.conf.json`
3. `split-tool/src-tauri/Cargo.toml`

三处版本号必须一致。

当前工作流内置了版本一致性校验，如果三处不一致，构建会直接失败。

推荐使用以下命令统一更新：

```bash
cd split-tool
npm run release:prepare -- 1.0.1
```

提交规范见：

- [docs/Windows打包提交标准流程.md](docs/Windows打包提交标准流程.md)

### 3.2 提交并推送

推荐使用项目根目录的一键脚本：

```bash
./push-windows-build.sh 1.0.1
```

脚本会自动更新版本、校验一致性、暂存打包所需文件、提交并推送。

详细步骤见 [docs/Windows打包提交标准流程.md](Windows打包提交标准流程.md)。

注意：

- 推送后不会自动触发打包
- 需要你手动运行打包工作流

### 3.3 触发云端打包

当前只保留手动执行方式：

在 GitHub 页面操作：

1. 打开仓库
2. 点击 `Actions`
3. 选择 `Build Windows App`
4. 点击 `Run workflow`
5. 选择分支并执行

这样可以避免“刚推送版本文件就立刻开始打包”，把“准备提交”和“真正打包”拆成两个独立动作。

### 3.4 下载产物

工作流成功后：

1. 打开该次 Actions 运行页面
2. 在页面底部找到 `Artifacts`
3. 下载以下产物：
   - `windows-nsis`
   - `windows-exe`

---

## 四、工作流做了什么

`.github/workflows/build-windows.yml` 在你手动运行后会执行以下步骤：

1. 拉取仓库代码
2. 安装 Node.js 20
3. 安装 Rust stable + `x86_64-pc-windows-msvc`
4. 缓存 Rust 依赖
5. 校验 `package.json`、`tauri.conf.json`、`Cargo.toml` 的版本号一致
6. 执行 `npm ci`
7. 执行 `npx tsc --noEmit`
8. 执行 `npm run tauri build -- --bundles nsis`
9. 上传 NSIS 安装包和原始 exe 文件

---

## 五、AI 执行模板

以后你可以直接把下面这段话发给 AI：

```text
请按 docs/Windows云打包标准流程.md 执行 Windows 云打包：
1. 先向我确认版本号
2. 运行 ./push-windows-build.sh 提交打包所需文件
3. 不要直接执行打包工作流
4. 等我需要真正打包时，再告诉我如何手动运行 Build Windows App
```

如果你只想让 AI 做“准备工作”而不立即推送，也可以这样说：

```text
请按 docs/Windows云打包标准流程.md 把本次 Windows 发版准备好：
1. 版本号改为 1.0.1
2. 校验三处版本一致
3. 更新必要文档
4. 不要推送，只告诉我下一步在 GitHub 上点哪里触发打包
```

---

## 六、VS Code 中的推荐操作方式

### 方式 A：一键脚本（推荐）

在 VS Code 终端执行：

```bash
./push-windows-build.sh 1.0.1
```

脚本会自动完成版本更新、校验、暂存、提交和推送。

### 方式 B：手动打包

推送完成后，如果需要打包：

1. 打开 GitHub 仓库 → `Actions`
2. 选择 `Build Windows App`
3. 点击 `Run workflow`
4. 选择已更新版本的分支
5. 点击运行

---

## 七、失败排查

### 7.1 版本一致性检查失败

说明三处版本号不一致：

- `split-tool/package.json`
- `split-tool/src-tauri/tauri.conf.json`
- `split-tool/src-tauri/Cargo.toml`

解决：统一为同一个版本号后重新提交。

### 7.2 npm 安装失败

优先检查：

- `package-lock.json` 是否提交
- `package.json` 是否损坏

### 7.3 TypeScript 检查失败

说明当前源码本身不可编译，需要先在本地修复再推送。

### 7.4 Tauri 构建失败

优先查看 Actions 日志中的以下阶段：

- `Validate version consistency`
- `Type check`
- `Build Windows installers`

---

## 八、产物说明

工作流成功后会提供：

- `windows-nsis`：推荐分发的安装向导 `.exe`
- `windows-exe`：原始可执行文件，便于调试或手动封装

说明：

- 云打包当前默认只产出 `NSIS` 和原始 `exe`
- 本机 Windows 打包仍可使用 `MSI`
- 这样做是为了绕开 GitHub Actions 上 `WiX/light.exe` 的不稳定失败点，优先保证云端打包流程稳定可复用

---

## 九、当前建议

日常开发继续在本机进行。

正式 Windows 打包时，统一走以下路径：

1. 运行 `./push-windows-build.sh <版本号>` 提交打包所需文件
2. 需要真正打包时，手动运行 `Build Windows App`
3. 下载 Artifacts

这样可以避免把整个项目复制到 Windows 电脑，也避免本地维护一套 Windows 打包环境。
