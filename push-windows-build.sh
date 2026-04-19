#!/bin/bash
set -euo pipefail

# ============================================================
# Windows 打包文件提交工具
# 用途：更新版本号，将 Windows 打包所需文件提交并推送到 GitHub
# 用法：./push-windows-build.sh [版本号]
# ============================================================

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
SPLIT_TOOL="$PROJECT_ROOT/split-tool"

echo ""
echo "========================================="
echo "  Windows 打包文件提交工具"
echo "========================================="
echo ""

# ----------------------------------------------------------
# 第一步：确认版本号
# ----------------------------------------------------------
if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  read -p "请输入版本号 (例如 1.0.1): " VERSION
fi

if [ -z "$VERSION" ]; then
  echo "错误：版本号不能为空"
  exit 1
fi

if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
  echo "错误：版本号格式不正确，应为 x.y.z"
  exit 1
fi

echo "目标版本: $VERSION"
echo ""

# ----------------------------------------------------------
# 第二步：更新三处版本文件
# ----------------------------------------------------------
echo ">>> [1/5] 更新版本文件..."
cd "$SPLIT_TOOL"
npm run release:prepare -- "$VERSION"
echo ""

# ----------------------------------------------------------
# 第三步：校验版本一致性
# ----------------------------------------------------------
echo ">>> [2/5] 校验版本一致性..."
npm run check:version
echo ""

# ----------------------------------------------------------
# 第四步：暂存 Windows 打包所需的全部文件
# ----------------------------------------------------------
echo ">>> [3/5] 暂存打包所需文件..."
cd "$PROJECT_ROOT"

# 使用 git add -A 自动暂存所有变更（新增/修改/删除）
# .gitignore 已排除 node_modules、target、dist 等大体积无关文件
# 新增任何源码/文档/配置文件都会自动被包含
git add -A

echo ""
echo ">>> [4/5] 将要提交的文件："
echo ""
git diff --cached --stat
echo ""

CHANGED_COUNT=$(git diff --cached --name-only | wc -l | tr -d ' ')

if [ "$CHANGED_COUNT" = "0" ]; then
  echo "没有检测到变更，无需提交。"
  exit 0
fi

# ----------------------------------------------------------
# 第五步：确认后提交并推送
# ----------------------------------------------------------
echo "版本: $VERSION"
echo "变更文件数: $CHANGED_COUNT"
echo ""
read -p "确认提交并推送到 GitHub？(y/n): " CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo ""
  echo "已取消。暂存区不会自动还原，你可以执行 git reset HEAD 撤销暂存。"
  exit 0
fi

echo ""
echo ">>> [5/5] 提交并推送..."
git commit -m "release: prepare windows build v$VERSION"
git push

echo ""
echo "========================================="
echo "  完成"
echo "========================================="
echo ""
echo "版本文件已提交并推送到 GitHub。"
echo ""
echo "如果需要执行 Windows 打包："
echo "  1. 打开 GitHub 仓库 → Actions"
echo "  2. 选择 Build Windows App"
echo "  3. 点击 Run workflow"
echo "  4. 选择分支并运行"
echo ""
