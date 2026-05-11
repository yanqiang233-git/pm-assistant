import type { ProjectCategory } from '../types/project';

/** 模块注册信息 */
export interface ModuleRegistryEntry {
  /** 模块唯一标识（英文，用作窗口 key、目录名等） */
  id: string;
  /** 模块中文标题 */
  title: string;
  /** 模块功能说明 */
  description: string;
  /** Tauri 窗口 label（与 id 保持一致） */
  windowLabel: string;
  /** 模块入口 HTML 相对路径 (相对于 dist 根) */
  entryPage: string;
  /** 是否启用 */
  enabled: boolean;
  /** 适用的项目类别（空数组 = 全部适用） */
  categories: ProjectCategory[];
  /** 在项目目录下创建的子目录名（英文） */
  projectSubDir: string;
  /** 模块窗口默认宽度 */
  windowWidth: number;
  /** 模块窗口默认高度 */
  windowHeight: number;
}

/** 模块注册表：所有可用模块 */
export const MODULE_REGISTRY: ModuleRegistryEntry[] = [
  {
    id: 'material-split',
    title: '上报物资汇总表拆分',
    description: '按分包数量对上报物资汇总表中的每一行进行拆分',
    windowLabel: 'material-split',
    entryPage: 'modules/material-split/index.html',
    enabled: true,
    categories: [],  // 全部项目类别可用
    projectSubDir: '上报物资汇总表拆分',
    windowWidth: 1200,
    windowHeight: 900
  },
  {
    id: 'review-score',
    title: '阅标记录赋分工具',
    description: '按已确认规则对指定表头的阅标记录进行自动赋分',
    windowLabel: 'review-score',
    entryPage: 'modules/review-score/index.html',
    enabled: true,
    categories: [],
    projectSubDir: '阅标记录赋分工具',
    windowWidth: 1440,
    windowHeight: 960
  }
];

/** 根据 id 查找模块 */
export function getModuleById(id: string): ModuleRegistryEntry | undefined {
  return MODULE_REGISTRY.find(m => m.id === id);
}

/** 获取当前项目类别下可用的模块列表 */
export function getAvailableModules(category?: ProjectCategory): ModuleRegistryEntry[] {
  return MODULE_REGISTRY.filter(m => {
    if (!m.enabled) return false;
    if (m.categories.length === 0) return true;
    return category ? m.categories.includes(category) : true;
  });
}
