import { MODULE_REGISTRY, getAvailableModules } from '../shared/registry/modules';
import type { ModuleRegistryEntry } from '../shared/registry/modules';
import { PROJECT_CATEGORY_LABELS } from '../shared/types/project';
import type { Project, ProjectCategory } from '../shared/types/project';
import {
  getAllProjects, getRecentProjects, getCurrentProject,
  setCurrentProject, createProject, removeProject,
  openProjectFromDir, PROJECT_DIR_SUFFIX
} from '../shared/store/project-store';

// ============ DOM refs ============
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const projectInfo = $('projectInfo');
const historyList = $('historyList');
const moduleCards = $('moduleCards');
const footerPath = $('footerPath');
const headerContext = $('headerContext');
const projectCount = $('projectCount');
const moduleHint = $('moduleHint');
const statusDot = $('statusDot');

// Create project modal
const createProjectModal = $('createProjectModal');
const btnCreateProject = $('btnCreateProject');
const createProjectClose = $('createProjectClose');
const createProjectCancel = $('createProjectCancel');
const createProjectOk = $('createProjectOk');
const projectNumberInput = $<HTMLInputElement>('projectNumber');
const projectCategorySelect = $<HTMLSelectElement>('projectCategory');
const projectDirPath = $('projectDirPath');
const btnPickDir = $('btnPickDir');

// Open project button
const btnOpenProject = $('btnOpenProject');

// ============ State ============
let selectedDirPath = '';

// ============ 模块活动时间存储 ============
const MODULE_ACTIVITY_KEY = 'pm_assistant_module_activity';

interface ModuleActivity {
  [moduleId: string]: { lastUsed: string }; // ISO 时间
}

function getModuleActivity(): ModuleActivity {
  try {
    const raw = localStorage.getItem(MODULE_ACTIVITY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function formatActivityTime(isoStr: string): string {
  const d = new Date(isoStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}月${day}日 ${hours}:${minutes}`;
}

function recordModuleUsage(moduleId: string): void {
  const activity = getModuleActivity();
  activity[moduleId] = { lastUsed: new Date().toISOString() };
  localStorage.setItem(MODULE_ACTIVITY_KEY, JSON.stringify(activity));
}

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  renderAll();
  bindEvents();
});

function renderAll(): void {
  renderHeaderContext();
  renderCurrentProject();
  renderHistory();
  renderModuleCards();
  renderFooter();
}

// ============ 顶栏项目摘要 ============
function renderHeaderContext(): void {
  const project = getCurrentProject();
  if (!project) {
    headerContext.innerHTML = '';
    return;
  }
  const categoryLabel = PROJECT_CATEGORY_LABELS[project.category];
  headerContext.innerHTML = `
    <span class="hc-label">当前：</span>
    <span class="hc-project">${escapeHtml(project.projectNumber)}</span>
    <span class="hc-category">${categoryLabel}</span>`;
}

// ============ 当前项目渲染 ============
function renderCurrentProject(): void {
  const project = getCurrentProject();
  statusDot.classList.toggle('no-project', !project);

  if (!project) {
    projectInfo.innerHTML = `
      <div class="wb-empty-state">
        <div class="empty-icon">📁</div>
        <p>暂未选择项目</p>
        <p class="empty-hint">点击上方"新建"创建第一个项目</p>
      </div>`;
    return;
  }
  const categoryLabel = PROJECT_CATEGORY_LABELS[project.category];
  const date = new Date(project.createdAt).toLocaleDateString('zh-CN');
  projectInfo.innerHTML = `
    <div class="wb-project-card">
      <div class="project-number">${escapeHtml(project.projectNumber)}</div>
      <div class="project-meta">
        <span>${categoryLabel}</span>
        <span>${date}</span>
      </div>
      <div class="project-dir" title="${escapeHtml(project.directoryPath)}">${escapeHtml(truncatePath(project.directoryPath, 35))}</div>
    </div>`;
}

// ============ 历史项目渲染 ============
function renderHistory(): void {
  const projects = getRecentProjects();
  const current = getCurrentProject();
  projectCount.textContent = String(projects.length);

  if (projects.length === 0) {
    historyList.innerHTML = `
      <div class="wb-empty-state"><p class="empty-hint">暂无历史项目</p></div>`;
    return;
  }

  historyList.innerHTML = projects.map(p => {
    const isActive = current && current.id === p.id;
    const categoryLabel = PROJECT_CATEGORY_LABELS[p.category];
    const date = new Date(p.createdAt).toLocaleDateString('zh-CN');
    return `
      <div class="wb-history-item${isActive ? ' active' : ''}" data-project-id="${p.id}">
        <div>
          <div class="hi-number">${escapeHtml(p.projectNumber)}</div>
          <div class="hi-meta">
            <span>${categoryLabel}</span>
            <span>${date}</span>
          </div>
        </div>
        <div class="hi-actions">
          <button class="btn-danger-text btn-remove-project" data-id="${p.id}">移除</button>
        </div>
      </div>`;
  }).join('');

  // 绑定点击选择
  historyList.querySelectorAll('.wb-history-item').forEach(el => {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('btn-remove-project')) return;
      const id = (el as HTMLElement).dataset.projectId;
      if (id) {
        setCurrentProject(id);
        renderAll();
      }
    });
  });

  // 绑定移除按钮
  historyList.querySelectorAll('.btn-remove-project').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id;
      if (id && confirm('确定从列表中移除该项目？（不会删除项目目录）')) {
        removeProject(id);
        renderAll();
      }
    });
  });
}

// ============ 模块卡片渲染 ============
function renderModuleCards(): void {
  const current = getCurrentProject();
  const modules = getAvailableModules(current?.category);
  const activity = getModuleActivity();

  moduleHint.textContent = current
    ? `当前项目下共 ${modules.length} 个可用模块`
    : '请先选择或创建项目后使用功能模块';
  moduleHint.classList.toggle('active', !!current);

  moduleCards.innerHTML = modules.map(m => {
    const disabled = !current;
    const statusBadge = disabled
      ? `<span class="mc-status-badge locked">需选项目</span>`
      : `<span class="mc-status-badge ready">可用</span>`;

    const categoryTags = m.categories.length > 0
      ? m.categories.map(c => `<span class="mc-tag"><span class="tag-icon">📂</span>${PROJECT_CATEGORY_LABELS[c]}</span>`).join('')
      : `<span class="mc-tag"><span class="tag-icon">✦</span>全部类别</span>`;

    const moduleActivity = activity[m.id];
    const activityHtml = moduleActivity
      ? `<div class="mc-activity">
          <span class="activity-icon">🕐</span>
          <span>最近处理时间：</span>
          <span class="activity-time">${formatActivityTime(moduleActivity.lastUsed)}</span>
        </div>`
      : `<div class="mc-activity">
          <span class="activity-icon">💤</span>
          <span>暂无使用记录</span>
        </div>`;

    return `
      <div class="wb-module-card${disabled ? ' disabled' : ''}" data-module-id="${m.id}">
        <div class="mc-header">
          <span class="mc-title">${escapeHtml(m.title)}</span>
          ${statusBadge}
        </div>
        <div class="mc-desc">${escapeHtml(m.description)}</div>
        <div class="mc-meta">
          ${categoryTags}
        </div>
        ${activityHtml}
      </div>`;
  }).join('');

  // 绑定卡片点击
  moduleCards.querySelectorAll('.wb-module-card').forEach(el => {
    el.addEventListener('click', () => {
      if ((el as HTMLElement).classList.contains('disabled')) {
        alert('请先选择或创建一个项目');
        return;
      }
      const moduleId = (el as HTMLElement).dataset.moduleId;
      if (moduleId) openModule(moduleId);
    });
  });
}

// ============ 底部状态栏 ============
function renderFooter(): void {
  const project = getCurrentProject();
  if (project) {
    footerPath.textContent = truncatePath(project.directoryPath, 60);
    footerPath.title = project.directoryPath;
  } else {
    footerPath.textContent = '未选择项目';
    footerPath.title = '';
  }
}

// ============ 打开模块窗口 ============
async function openModule(moduleId: string): Promise<void> {
  const entry = MODULE_REGISTRY.find(m => m.id === moduleId);
  if (!entry) return;

  const current = getCurrentProject();
  if (!current) return;

  // 记录模块使用时间
  recordModuleUsage(moduleId);
  renderModuleCards();

  try {
    // 使用 Tauri WebviewWindow API 打开模块窗口
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

    // 检查是否已有同名窗口
    const existing = await WebviewWindow.getByLabel(entry.windowLabel);
    if (existing) {
      await existing.setFocus();
      return;
    }

    // 创建新窗口，通过 URL 参数传递项目上下文
    const moduleUrl = `${entry.entryPage}?projectDir=${encodeURIComponent(current.directoryPath)}&moduleSubDir=${encodeURIComponent(entry.projectSubDir)}`;
    const webview = new WebviewWindow(entry.windowLabel, {
      url: moduleUrl,
      title: `${entry.title} - ${current.projectNumber}`,
      width: entry.windowWidth,
      height: entry.windowHeight,
      resizable: true,
      center: true,
    });

    webview.once('tauri://error', (e) => {
      console.error('模块窗口创建失败:', e);
    });
  } catch (err) {
    // 非 Tauri 环境（浏览器开发模式），退化为新标签页
    console.warn('非 Tauri 环境，使用 window.open:', err);
    const fallbackUrl = `${entry.entryPage}?projectDir=${encodeURIComponent(current.directoryPath)}&moduleSubDir=${encodeURIComponent(entry.projectSubDir)}`;
    window.open(fallbackUrl, entry.windowLabel);
  }
}

// ============ 新建项目弹窗 ============
function openCreateModal(): void {
  projectNumberInput.value = '';
  projectCategorySelect.value = 'material';
  projectDirPath.textContent = '请选择保存位置...';
  selectedDirPath = '';
  createProjectModal.classList.remove('hidden');
  projectNumberInput.focus();
}

function closeCreateModal(): void {
  createProjectModal.classList.add('hidden');
}

async function pickDirectory(): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false, title: '选择项目保存位置' });
    if (selected && typeof selected === 'string') {
      selectedDirPath = selected;
      projectDirPath.textContent = selected;
    }
  } catch {
    // 非 Tauri 环境，使用手动输入
    const path = prompt('请输入项目目录路径（桌面端可自动选择）:');
    if (path) {
      selectedDirPath = path;
      projectDirPath.textContent = path;
    }
  }
}

async function handleCreateProject(): Promise<void> {
  const number = projectNumberInput.value.trim();
  if (!number) {
    alert('请输入项目编号');
    projectNumberInput.focus();
    return;
  }
  if (!selectedDirPath) {
    alert('请选择项目保存位置');
    return;
  }
  const category = projectCategorySelect.value as ProjectCategory;
  try {
    await createProject(number, category, selectedDirPath);
    closeCreateModal();
    renderAll();
  } catch (err) {
    alert(`创建项目目录失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============ 打开项目（直接选目录，自动识别） ============
async function handleOpenProject(): Promise<void> {
  let dirPath: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      title: `选择项目文件夹（名称应以 ${PROJECT_DIR_SUFFIX} 结尾）`
    });
    if (selected && typeof selected === 'string') {
      dirPath = selected;
    }
  } catch {
    const path = prompt(`请输入项目文件夹路径（文件夹名应以 ${PROJECT_DIR_SUFFIX} 结尾）:`);
    if (path) dirPath = path;
  }

  if (!dirPath) return;

  const result = await openProjectFromDir(dirPath);
  if (result.error) {
    alert(result.error);
    return;
  }
  renderAll();
}

// ============ 事件绑定 ============
function bindEvents(): void {
  // 新建项目
  btnCreateProject.addEventListener('click', openCreateModal);
  createProjectClose.addEventListener('click', closeCreateModal);
  createProjectCancel.addEventListener('click', closeCreateModal);
  createProjectOk.addEventListener('click', handleCreateProject);
  btnPickDir.addEventListener('click', pickDirectory);

  // 打开项目（直接弹目录选择器）
  btnOpenProject.addEventListener('click', handleOpenProject);

  // ESC / 点击背景关闭弹窗
  createProjectModal.addEventListener('click', (e) => {
    if (e.target === createProjectModal) closeCreateModal();
  });
}

// ============ 工具函数 ============
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function truncatePath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return '...' + path.slice(path.length - maxLen + 3);
}
