import { PasteResult, FenbiaoConfig } from '../types';

/**
 * 解析单列粘贴（只有分包数量）
 * @param text 粘贴的文本
 * @param configs 当前分标配置（已按名称升序排列）
 * @returns 更新后的配置 + 解析结果
 */
export function parseSingleColumnPaste(
  text: string,
  configs: FenbiaoConfig[]
): { configs: FenbiaoConfig[]; result: PasteResult } {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const result: PasteResult = {
    totalParsed: lines.length,
    successCount: 0,
    failCount: 0,
    invalidValues: [],
    rowDiff: lines.length - configs.length
  };

  const updated = configs.map((c, i) => {
    if (i < lines.length) {
      const val = lines[i].trim();
      const num = parseInt(val, 10);
      if (!isNaN(num) && num >= 1) {
        result.successCount++;
        return { ...c, packageCount: num };
      } else {
        result.failCount++;
        result.invalidValues!.push({ line: i + 1, value: val });
        return c;
      }
    }
    return c;
  });

  return { configs: updated, result };
}

/**
 * 解析两列粘贴（分标名称 + 分包数量）
 * @param text 粘贴的文本
 * @param configs 当前分标配置
 * @returns 更新后的配置 + 解析结果
 */
export function parseTwoColumnPaste(
  text: string,
  configs: FenbiaoConfig[]
): { configs: FenbiaoConfig[]; result: PasteResult } {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const result: PasteResult = {
    totalParsed: lines.length,
    successCount: 0,
    failCount: 0,
    unmatchedNames: [],
    duplicateNames: [],
    emptyNames: 0,
    invalidValues: []
  };

  const configMap = new Map(configs.map(c => [c.name, c]));
  const seen = new Map<string, number>();
  const updates = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const parts = lines[i].split(/\t/);
    if (parts.length < 2) {
      result.failCount++;
      result.invalidValues!.push({ line: i + 1, value: lines[i] });
      continue;
    }
    const name = parts[0].trim();
    const valStr = parts[1].trim();

    if (!name) {
      result.emptyNames!++;
      result.failCount++;
      continue;
    }

    // 检查重复
    seen.set(name, (seen.get(name) || 0) + 1);
    if (seen.get(name)! > 1) {
      if (!result.duplicateNames!.includes(name)) result.duplicateNames!.push(name);
      result.failCount++;
      continue;
    }

    // 检查是否匹配
    if (!configMap.has(name)) {
      result.unmatchedNames!.push(name);
      result.failCount++;
      continue;
    }

    // 检查数值
    const num = parseInt(valStr, 10);
    if (isNaN(num) || num < 1) {
      result.invalidValues!.push({ line: i + 1, value: valStr });
      result.failCount++;
      continue;
    }

    updates.set(name, num);
    result.successCount++;
  }

  const updated = configs.map(c => {
    const count = updates.get(c.name);
    return count !== undefined ? { ...c, packageCount: count } : c;
  });

  return { configs: updated, result };
}
