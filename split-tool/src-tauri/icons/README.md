# 图标替换说明

## 替换步骤

1. 准备一张 **1024×1024** 像素的 PNG 图标文件
2. 将其覆盖到当前目录，命名为 `app-icon.png`
3. 在 `split-tool` 目录下执行：
   ```bash
   npx tauri icon src-tauri/icons/app-icon.png
   ```
   这会自动生成所有平台所需的图标格式（.ico、.icns、各尺寸 PNG）
4. 重新打包：
   ```bash
   # Mac
   npm run tauri build
   # Windows（在 Windows 机器上执行）
   npm run tauri build -- --target x86_64-pc-windows-msvc
   ```

## 文件说明

| 文件 | 用途 |
|------|------|
| `app-icon.png` | **源图标（请替换此文件）** |
| `icon.icns` | macOS 应用图标（自动生成） |
| `icon.ico` | Windows 应用图标（自动生成） |
| `32x32.png` | 小尺寸图标（自动生成） |
| `128x128.png` | 中尺寸图标（自动生成） |
| `128x128@2x.png` | Retina 图标（自动生成） |
