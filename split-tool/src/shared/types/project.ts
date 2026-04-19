/** 项目类别 */
export type ProjectCategory = 'material' | 'engineering-service';

/** 项目类别中文映射 */
export const PROJECT_CATEGORY_LABELS: Record<ProjectCategory, string> = {
  'material': '物资类',
  'engineering-service': '工程服务类'
};

/** 项目信息 */
export interface Project {
  /** 唯一标识（自动生成） */
  id: string;
  /** 项目编号（用户输入） */
  projectNumber: string;
  /** 项目类别 */
  category: ProjectCategory;
  /** 创建日期 ISO 字符串（自动记录） */
  createdAt: string;
  /** 项目本地目录绝对路径（用户创建时选择） */
  directoryPath: string;
}

/** 项目目录下的元信息文件内容 */
export interface ProjectMeta {
  /** 元信息版本号，用于后续迁移 */
  version: 1;
  /** 项目基本信息 */
  project: Project;
}

/** 应用级存储的项目列表（保存在 localStorage） */
export interface ProjectListStore {
  /** 所有已创建项目（按创建时间倒序） */
  projects: Project[];
  /** 当前选中的项目 id */
  currentProjectId: string | null;
}

/** 项目元信息文件名 */
export const PROJECT_META_FILENAME = 'project.json';

/** 历史项目最大展示数量 */
export const MAX_RECENT_PROJECTS = 10;
