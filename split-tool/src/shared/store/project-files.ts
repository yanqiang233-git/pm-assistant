/**
 * 项目文件镜像服务
 * 在用户正常导入/导出的同时，将文件同步存储到项目目录下的模块子目录中
 * 支持模块状态持久化和恢复
 *
 * 目录结构：{projectDir}/{moduleSubDir}/导入文件|配置模板|导出文件/
 * 文件命名：{固定前缀}_{yyyyMMdd_HHmmss}.xlsx
 */

/** 模块内子目录名 */
export const DIR_IMPORT = '导入文件';
export const DIR_TEMPLATE = '配置模板';
export const DIR_EXPORT = '导出文件';

/** 固定文件前缀 */
const PREFIX_SOURCE = '源文件';
const PREFIX_PKG_TPL = '分包数量配置';
const PREFIX_SPLIT_TPL = '拆分方式配置';
const PREFIX_RESULT = '拆分结果';

/** 模块状态文件名 */
const MODULE_STATE_FILE = 'module-state.json';

interface ProjectContext {
  projectDir: string;
  moduleSubDir: string;
}

interface MirroredFile {
  fileName: string;
  data: number[];
}

/** 模块持久化状态 */
export interface ModulePersistedState {
  /** 源文件原始名 */
  sourceFileName: string;
  /** 分标配置 */
  fenbiaoConfigs: unknown[];
  /** 全局拆分方式 */
  globalSplitMethod: string;
  /** 最后更新时间 */
  updatedAt: string;
}

/** 生成时间戳字符串：yyyyMMdd_HHmmss */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 构建带时间戳的文件名 */
function stampedName(prefix: string, ext: string): string {
  return `${prefix}_${timestamp()}${ext}`;
}

function getFileExtension(fileName: string, fallback = '.xlsx'): string {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : fallback;
  return ext || fallback;
}

async function invokeProjectCommand<T>(command: string, args: object): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args as Record<string, unknown>);
}

/** 从 URL 参数读取当前模块的项目上下文 */
export function getProjectContext(): ProjectContext | null {
  const params = new URLSearchParams(window.location.search);
  const projectDir = params.get('projectDir');
  const moduleSubDir = params.get('moduleSubDir');
  if (!projectDir || !moduleSubDir) return null;
  return { projectDir, moduleSubDir };
}

/** 获取模块根目录路径 */
function getModuleBasePath(ctx: ProjectContext): string {
  return `${ctx.projectDir}/${ctx.moduleSubDir}`;
}

/** 初始化模块三级目录结构（导入文件、配置模板、导出文件） */
export async function ensureModuleDirs(): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    await invokeProjectCommand('ensure_module_dirs', ctx);
  } catch (err) {
    console.warn('初始化模块目录失败:', err);
  }
}

// ======== 清理旧文件：按前缀删除同目录下的同类型文件 ========

async function clearByPrefix(dirPath: string, prefix: string): Promise<void> {
  try {
    const { readDir, remove } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(dirPath);
    for (const entry of entries) {
      if (entry.name?.startsWith(prefix)) {
        await remove(`${dirPath}/${entry.name}`).catch(() => {});
      }
    }
  } catch {
    // 目录可能不存在，忽略
  }
}

// ======== 镜像操作（带时间戳命名 + 清理旧文件） ========

/** 镜像导入的源文件（清理旧源文件后写入新文件） */
export async function mirrorImportFile(file: File): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    const buffer = await file.arrayBuffer();
    await invokeProjectCommand('mirror_import_file', {
      ...ctx,
      ext: getFileExtension(file.name),
      data: Array.from(new Uint8Array(buffer))
    });
  } catch (err) {
    console.warn(`镜像导入文件失败:`, err);
  }
}

/** 镜像配置模板（分包数量 / 拆分方式） */
export async function mirrorTemplate(data: Uint8Array, type: 'pkg' | 'split'): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    await invokeProjectCommand('mirror_template_file', {
      ...ctx,
      templateType: type,
      ext: '.xlsx',
      data: Array.from(data)
    });
  } catch (err) {
    console.warn(`镜像模板失败:`, err);
  }
}

/** 镜像上传的配置模板文件 */
export async function mirrorUploadedTemplate(file: File, type: 'pkg' | 'split'): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    const buffer = await file.arrayBuffer();
    await invokeProjectCommand('mirror_template_file', {
      ...ctx,
      templateType: type,
      ext: getFileExtension(file.name),
      data: Array.from(new Uint8Array(buffer))
    });
  } catch (err) {
    console.warn(`镜像上传模板失败:`, err);
  }
}

/** 镜像导出结果 */
export async function mirrorExportResult(data: Uint8Array): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    await invokeProjectCommand('mirror_export_result', {
      ...ctx,
      data: Array.from(data)
    });
  } catch (err) {
    console.warn(`镜像导出结果失败:`, err);
  }
}

// ======== 模块状态持久化 ========

/** 保存模块状态到项目目录 */
export async function saveModuleState(stateData: ModulePersistedState): Promise<void> {
  const ctx = getProjectContext();
  if (!ctx) return;
  try {
    await invokeProjectCommand('save_module_state', {
      ...ctx,
      stateJson: JSON.stringify(stateData, null, 2)
    });
  } catch (err) {
    console.warn('保存模块状态失败:', err);
  }
}

/** 从项目目录加载模块状态 */
export async function loadModuleState(): Promise<ModulePersistedState | null> {
  const ctx = getProjectContext();
  if (!ctx) return null;
  try {
    const raw = await invokeProjectCommand<string | null>('load_module_state', ctx);
    return raw ? JSON.parse(raw) as ModulePersistedState : null;
  } catch {
    return null;
  }
}

// ======== 恢复导入文件 ========

/** 查找导入目录下最新的源文件，返回文件路径和二进制数据 */
export async function loadLatestImportFile(): Promise<{ fileName: string; data: Uint8Array } | null> {
  const ctx = getProjectContext();
  if (!ctx) return null;
  try {
    const latest = await invokeProjectCommand<MirroredFile | null>('load_latest_import_file', ctx);
    if (!latest) return null;
    return { fileName: latest.fileName, data: new Uint8Array(latest.data) };
  } catch {
    return null;
  }
}
