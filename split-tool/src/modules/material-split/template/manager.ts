import { RatioTemplate } from '../types';

const STORAGE_KEY = 'split_tool_ratio_templates';

/** 加载所有比例模板 */
export function loadTemplates(): RatioTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** 保存全部模板 */
export function saveTemplates(templates: RatioTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

/** 新增模板 */
export function addTemplate(template: RatioTemplate): RatioTemplate[] {
  const list = loadTemplates();
  // 如果设为默认，取消同分包数量下其他默认
  if (template.isDefault) {
    list.forEach(t => {
      if (t.packageCount === template.packageCount) t.isDefault = false;
    });
  }
  list.push(template);
  saveTemplates(list);
  return list;
}

/** 更新模板 */
export function updateTemplate(template: RatioTemplate): RatioTemplate[] {
  const list = loadTemplates();
  const idx = list.findIndex(t => t.id === template.id);
  if (idx >= 0) {
    if (template.isDefault) {
      list.forEach(t => {
        if (t.packageCount === template.packageCount) t.isDefault = false;
      });
    }
    list[idx] = template;
  }
  saveTemplates(list);
  return list;
}

/** 删除模板 */
export function deleteTemplate(id: string): RatioTemplate[] {
  let list = loadTemplates();
  list = list.filter(t => t.id !== id);
  saveTemplates(list);
  return list;
}

/** 设为默认模板 */
export function setDefaultTemplate(id: string): RatioTemplate[] {
  const list = loadTemplates();
  const target = list.find(t => t.id === id);
  if (target) {
    list.forEach(t => {
      if (t.packageCount === target.packageCount) t.isDefault = (t.id === id);
    });
  }
  saveTemplates(list);
  return list;
}

/** 获取某分包数量的默认模板 */
export function getDefaultTemplate(packageCount: number): RatioTemplate | undefined {
  return loadTemplates().find(t => t.packageCount === packageCount && t.isDefault);
}

/** 获取某分包数量的全部模板 */
export function getTemplatesByCount(packageCount: number): RatioTemplate[] {
  return loadTemplates().filter(t => t.packageCount === packageCount);
}

/** 生成唯一 ID */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
