# Windows 打包提交标准流程

> 本文档用于规范“Windows 打包所需文件的更新、提交、推送”流程。
> 核心原则：提交前必须由你确认版本号。

---

## 一、目标

将 Windows 打包所需的必要文件更新到目标版本，并以标准方式提交到 GitHub 仓库。

注意：

- 本流程只负责更新和提交打包所需文件
- 本流程不负责直接执行 Windows 打包
- 真正打包时，需要你后续手动运行独立的打包工作流

适用范围：

- 更新 Windows 发版版本号
- 准备一次新的云打包提交
- 让 AI 按统一标准执行，不每次重复解释流程

---

## 二、必要文件范围

默认情况下，Windows 发版必须同步更新以下三个版本文件：

1. split-tool/package.json
2. split-tool/src-tauri/tauri.conf.json
3. split-tool/src-tauri/Cargo.toml

这三个文件的版本号必须完全一致。

说明：

- 普通 Windows 发版提交，默认只更新这三处版本号
- 只有在工作流或文档本身发生变化时，才额外提交对应文件

---

## 三、标准执行步骤

### 3.1 先确认版本号

提交前必须先由你确认版本号。

示例：

- `1.0.1`
- `1.0.2`

不允许 AI 在未确认版本号的情况下直接创建发版提交。

### 3.2 更新必要文件

在项目目录执行：

```bash
cd split-tool
npm run release:prepare -- 1.0.1
```

该命令会自动：

1. 更新 `package.json`
2. 更新 `src-tauri/tauri.conf.json`
3. 更新 `src-tauri/Cargo.toml`
4. 校验三处版本号一致

### 3.3 检查变更

执行：

```bash
git diff -- split-tool/package.json split-tool/src-tauri/tauri.conf.json split-tool/src-tauri/Cargo.toml
```

目标：

- 确认只有目标版本号发生变化
- 确认没有无关改动被混入本次发版提交

### 3.4 再次确认版本号

在提交前，AI 或执行人必须再次明确确认：

- 本次提交版本号是否确定为 `1.0.1`

只有确认后才允许提交。

### 3.5 创建标准提交

推荐提交信息：

```bash
git add split-tool/package.json split-tool/src-tauri/tauri.conf.json split-tool/src-tauri/Cargo.toml
git commit -m "release: prepare windows build v1.0.1"
```

如果本次同时修改了工作流或文档，再额外加入对应文件。

### 3.6 推送到 GitHub

```bash
git push
```

推送后：

- 不会自动执行 Windows 打包
- 只是把版本文件更新提交到 GitHub 仓库

### 3.7 GitHub 手动工作流方式

如果你希望直接在 GitHub 上执行“更新并提交版本文件”，使用以下工作流：

- `Prepare Windows Release Files`

执行方式：

1. 打开 GitHub 仓库主页
2. 点击 `Actions`
3. 在左侧选择 `Prepare Windows Release Files`
4. 点击 `Run workflow`
5. 选择目标分支，一般是 `main`
6. 在 `version` 输入框填写版本号，例如 `1.0.1`
7. 点击绿色的 `Run workflow`

该工作流会：

1. 更新三处版本文件
2. 自动校验版本一致性
3. 将版本文件提交回你选择的分支

该工作流不会：

1. 构建 Windows 安装包
2. 上传打包产物

---

## 四、AI 执行约束

以后让 AI 执行这类任务时，必须遵守以下顺序：

1. 先询问并确认版本号
2. 再运行 `npm run release:prepare -- <version>`
3. 再展示或检查 diff
4. 再次确认版本号
5. 最后才提交并推送

如果使用 GitHub 手动工作流，则“确认版本号”的动作就是你在 `Run workflow` 时填写版本号并执行。

禁止行为：

- 未确认版本号直接提交
- 将无关源码改动混入发版提交
- 跳过版本一致性检查

---

## 五、推荐提交模板

### 仅版本号提交

```bash
git add split-tool/package.json split-tool/src-tauri/tauri.conf.json split-tool/src-tauri/Cargo.toml
git commit -m "release: prepare windows build v1.0.1"
git push
```

### GitHub 工作流提交

如果你不想在本地终端执行，也可以直接运行：

- `Prepare Windows Release Files`

并在运行时输入版本号。

### 包含工作流修复

```bash
git add split-tool/package.json split-tool/src-tauri/tauri.conf.json split-tool/src-tauri/Cargo.toml .github/workflows/build-windows.yml docs/Windows云打包标准流程.md docs/Windows打包提交标准流程.md
git commit -m "release: prepare windows build v1.0.1"
git push
```

---

## 六、AI 复用提示词

以后可以直接把下面这段话发给 AI：

```text
请按 docs/Windows打包提交标准流程.md 执行 Windows 打包提交准备。
先向我确认版本号，未确认前不要提交。
确认后执行以下流程：
1. 更新 split-tool/package.json、split-tool/src-tauri/tauri.conf.json、split-tool/src-tauri/Cargo.toml
2. 运行版本一致性检查
3. 展示本次版本变更 diff
4. 再次向我确认版本号
5. 仅提交 Windows 打包所需的必要文件
6. 推送到 GitHub
7. 不要直接执行 Build Windows App
8. 告诉我后续如何手动运行对应工作流
```

---

## 七、与现有云打包流程的关系

本文档负责：

- 发版版本号更新
- 必要文件提交
- 推送到 GitHub
- GitHub 手动更新工作流使用说明

以下文档负责：

- [docs/Windows云打包标准流程.md](docs/Windows云打包标准流程.md)：GitHub Actions 云打包与产物下载

建议搭配使用：

1. 先按本文档准备提交
2. 需要真正打包时，再按云打包文档手动运行打包工作流