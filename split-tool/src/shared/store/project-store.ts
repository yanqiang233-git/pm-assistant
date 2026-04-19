import type { Project, ProjectListStore, ProjectCategory, ProjectMeta } from '../types/project';
import { MAX_RECENT_PROJECTS, PROJECT_META_FILENAME } from '../types/project';

const STORE_KEY = 'pm_assistant_projects';

/** 项目文件夹后缀 */
export const PROJECT_DIR_SUFFIX = '_PMA';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadStore(): ProjectListStore {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : { projects: [], currentProjectId: null };
  } catch {
    return { projects: [], currentProjectId: null };
  }
}

function saveStore(store: ProjectListStore): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

/** 构建项目文件夹名称：{projectNumber}_PMA */
export function buildProjectDirName(projectNumber: string): string {
  return `${projectNumber}${PROJECT_DIR_SUFFIX}`;
}

/** 判断文件夹名是否符合 *_PMA 命名规则 */
export function isValidProjectDir(dirName: string): boolean {
  return dirName.endsWith(PROJECT_DIR_SUFFIX) && dirName.length > PROJECT_DIR_SUFFIX.length;
}

/** 从文件夹名中提取项目编号 */
export function extractProjectNumber(dirName: string): string {
  return dirName.slice(0, -PROJECT_DIR_SUFFIX.length);
}

// ============ 文件系统操作（Tauri 环境） ============

/** 在 Tauri 环境下创建项目目录并写入配置文件 */
async function createProjectDir(project: Project): Promise<void> {
  const { mkdir, writeTextFile } = await import('@tauri-apps/plugin-fs');
  // 创建项目文件夹
  await mkdir(project.directoryPath, { recursive: true });
  // 写入配置文件
  const meta: ProjectMeta = { version: 1, project };
  const configPath = `${project.directoryPath}/${PROJECT_META_FILENAME}`;
  await writeTextFile(configPath, JSON.stringify(meta, null, 2));
}

/** 在 Tauri 环境下从项目目录读取配置文件 */
async function readProjectMeta(dirPath: string): Promise<ProjectMeta | null> {
  try {
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const configPath = `${dirPath}/${PROJECT_META_FILENAME}`;
    const raw = await readTextFile(configPath);
    return JSON.parse(raw) as ProjectMeta;
  } catch {
    return null;
  }
}

/** 更新项目目录下的配置文件 */
async function updateProjectMeta(project: Project): Promise<void> {
  try {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const meta: ProjectMeta = { version: 1, project };
    const configPath = `${project.directoryPath}/${PROJECT_META_FILENAME}`;
    await writeTextFile(configPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.warn('更新配置文件失败:', err);
  }
}

/** 获取所有项目 */
export function getAllProjects(): Project[] {
  return loadStore().projects;
}

/** 获取最近项目（最多 MAX_RECENT_PROJECTS 条） */
export function getRecentProjects(): Project[] {
  const store = loadStore();
  return store.projects
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_RECENT_PROJECTS);
}

/** 获取当前选中的项目 */
export function getCurrentProject(): Project | null {
  const store = loadStore();
  if (!store.currentProjectId) return null;
  return store.projects.find(p => p.id === store.currentProjectId) ?? null;
}

/** 设置当前选中的项目 */
export function setCurrentProject(projectId: string): void {
  const store = loadStore();
  store.currentProjectId = projectId;
  saveStore(store);
}

/** 创建新项目（在选定目录下创建 {编号}_PMA 文件夹 + 写入配置） */
export async function createProject(
  projectNumber: string,
  category: ProjectCategory,
  parentDir: string
): Promise<Project> {
  const dirName = buildProjectDirName(projectNumber);
  const projectPath = `${parentDir}/${dirName}`;

  const project: Project = {
    id: generateId(),
    projectNumber,
    category,
    createdAt: new Date().toISOString(),
    directoryPath: projectPath
  };

  // 先创建目录和配置文件，成功后再写入 localStorage
  await createProjectDir(project);

  const store = loadStore();
  store.projects.unshift(project);
  store.currentProjectId = project.id;
  saveStore(store);

  return project;
}

/** 从目录打开已有项目（自动读取配置，无需用户填写信息）
 *  @returns 项目信息，或 null 表示目录不合法 / 配置不存在
 */
export async function openProjectFromDir(dirPath: string): Promise<{ project: Project; error?: undefined } | { project?: undefined; error: string }> {
  // 提取文件夹名
  const dirName = dirPath.split('/').pop() ?? '';
  if (!isValidProjectDir(dirName)) {
    return { error: `文件夹名"${dirName}"不符合规则，应以 ${PROJECT_DIR_SUFFIX} 结尾（如 XXXX${PROJECT_DIR_SUFFIX}）` };
  }

  const store = loadStore();

  // 检查是否已在列表中
  const existing = store.projects.find(p => p.directoryPath === dirPath);
  if (existing) {
    store.currentProjectId = existing.id;
    saveStore(store);
    return { project: existing };
  }

  // 尝试读取配置文件
  const meta = await readProjectMeta(dirPath);
  if (meta?.project) {
    // 从配置文件还原，但用新 id（可能来自另一台机器）
    const project: Project = {
      ...meta.project,
      id: generateId(),
      directoryPath: dirPath
    };
    store.projects.unshift(project);
    store.currentProjectId = project.id;
    saveStore(store);
    return { project };
  }

  // 无配置文件，从文件夹名推断项目编号
  const projectNumber = extractProjectNumber(dirName);
  const project: Project = {
    id: generateId(),
    projectNumber,
    category: 'material',  // 默认类别
    createdAt: new Date().toISOString(),
    directoryPath: dirPath
  };
  store.projects.unshift(project);
  store.currentProjectId = project.id;
  saveStore(store);

  // 补写配置文件
  await updateProjectMeta(project);

  return { project };
}

/** 打开已有项目（通过选择目录导入） - 兼容旧版调用 */
export function openProject(
  projectNumber: string,
  category: ProjectCategory,
  directoryPath: string
): Project {
  const store = loadStore();
  // 检查是否已存在相同目录的项目
  const existing = store.projects.find(p => p.directoryPath === directoryPath);
  if (existing) {
    store.currentProjectId = existing.id;
    saveStore(store);
    return existing;
  }
  // 创建新记录并设为当前
  const project: Project = {
    id: generateId(),
    projectNumber,
    category,
    createdAt: new Date().toISOString(),
    directoryPath
  };
  store.projects.unshift(project);
  store.currentProjectId = project.id;
  saveStore(store);
  return project;
}

/** 删除项目（仅从列表中移除，不删目录） */
export function removeProject(id: string): void {
  const store = loadStore();
  store.projects = store.projects.filter(p => p.id !== id);
  if (store.currentProjectId === id) {
    store.currentProjectId = store.projects[0]?.id ?? null;
  }
  saveStore(store);
}
