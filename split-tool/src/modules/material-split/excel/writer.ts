import * as XLSX from 'xlsx';
import { SplitRow, FenbiaoConfig, SplitMethod, RatioTemplate } from '../types';
import { splitAverage, yuanToFen, fenToYuan } from '../split/precision';

/** 将拆分结果写入 xlsx 并下载，同时返回二进制数据用于项目目录镜像 */
export function exportToXlsx(
  rows: SplitRow[],
  headerOrder: string[],
  outputFileName: string
): Uint8Array {
  const wsData: unknown[][] = [headerOrder];
  for (const row of rows) {
    const line: unknown[] = headerOrder.map(h => row[h] ?? '');
    wsData.push(line);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, outputFileName);
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** 下载分包数量配置模板，同时返回二进制数据用于项目目录镜像 */
export function downloadConfigTemplate(fenbiaoNames: string[]): Uint8Array {
  const wsData: unknown[][] = [['分标名称', '分包数量']];
  for (const name of fenbiaoNames) {
    wsData.push([name, '']);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 30 }, { wch: 15 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '分包数量配置');
  XLSX.writeFile(wb, '分包数量配置模板.xlsx');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/** 拆分方式中文名映射 */
const METHOD_LABELS: Record<SplitMethod, string> = {
  average: '平均分',
  ratio: '比例模板',
  fixedAmount: '指定金额'
};
const LABEL_TO_METHOD: Record<string, SplitMethod> = {
  '平均分': 'average',
  '比例模板': 'ratio',
  '指定金额': 'fixedAmount'
};

/**
 * 下载拆分方式配置模板
 * 列结构: 分标名称 | 分包数量 | 拆分方式 | 包1 | 包2 | ... | 包N
 * - 平均分: 自动计算每包金额
 * - 比例模板: 填百分数
 * - 指定金额: 填金额(元)
 */
export function downloadSplitConfigTemplate(
  configs: FenbiaoConfig[],
  defaultMethod: SplitMethod,
  fenbiaoTotals: Map<string, number>,
  templates: RatioTemplate[]
): Uint8Array {
  // 计算最大分包数以确定列数
  const maxPkg = Math.max(...configs.map(c => c.packageCount), 1);
  // 表头
  const header: string[] = ['分标名称', '估算总价（元）', '分包数量', '拆分方式'];
  for (let i = 1; i <= maxPkg; i++) header.push(`包${i}`);
  const wsData: unknown[][] = [header];

  for (const c of configs) {
    if (c.packageCount < 1) continue;
    const method = c.overridden ? c.splitMethod : defaultMethod;
    const totalFen = fenbiaoTotals.get(c.name) || 0;
    const row: unknown[] = [c.name, fenToYuan(totalFen), c.packageCount, METHOD_LABELS[method]];

    if (method === 'average') {
      // 自动带出每包金额
      const shares = splitAverage(totalFen, c.packageCount);
      for (let i = 0; i < maxPkg; i++) {
        row.push(i < c.packageCount ? fenToYuan(shares[i]) : '');
      }
    } else if (method === 'ratio') {
      // 如果已关联模板，带出比例；否则留空
      const tpl = c.templateId ? templates.find(t => t.id === c.templateId) : undefined;
      for (let i = 0; i < maxPkg; i++) {
        if (i < c.packageCount && tpl) {
          row.push((tpl.ratios[i] / 100).toFixed(1) + '%');
        } else if (i < c.packageCount) {
          row.push('');
        } else {
          row.push('');
        }
      }
    } else if (method === 'fixedAmount') {
      // 如果已设金额，带出；否则留空
      for (let i = 0; i < maxPkg; i++) {
        if (i < c.packageCount && c.fixedAmounts?.[i] != null) {
          row.push(fenToYuan(c.fixedAmounts[i]));
        } else if (i < c.packageCount) {
          row.push('');
        } else {
          row.push('');
        }
      }
    }
    wsData.push(row);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  // 设置列宽
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 10 }, { wch: 12 }];
  for (let i = 0; i < maxPkg; i++) ws['!cols']!.push({ wch: 14 });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '拆分方式配置');
  XLSX.writeFile(wb, '拆分方式配置模板.xlsx');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

export interface SplitConfigRow {
  name: string;
  packageCount: number;
  method: SplitMethod;
  values: number[];   // 比例为百分数×100(万分比), 金额为分(整数), 平均分为分(整数)
  rawMethod: string;
}

export interface SplitConfigImportResult {
  success: boolean;
  rows: SplitConfigRow[];
  errors: string[];
}

/** 读取拆分方式配置模板并校验 */
export function readSplitConfigTemplate(
  file: File,
  fenbiaoNames: string[],
  fenbiaoTotals: Map<string, number>,
  currentConfigs: FenbiaoConfig[]
): Promise<SplitConfigImportResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
        const errors: string[] = [];
        const rows: SplitConfigRow[] = [];
        const seenNames = new Set<string>();

        for (let i = 0; i < jsonData.length; i++) {
          const rowNum = i + 2;
          const raw = jsonData[i];
          const name = String(raw['分标名称'] ?? '').trim();
          const countRaw = raw['分包数量'];
          const methodRaw = String(raw['拆分方式'] ?? '').trim();

          if (!name) { errors.push(`第${rowNum}行：分标名称为空`); continue; }
          if (seenNames.has(name)) { errors.push(`第${rowNum}行：分标名称"${name}"重复`); continue; }
          seenNames.add(name);

          const count = Number(countRaw);
          if (!Number.isInteger(count) || count < 1) {
            errors.push(`第${rowNum}行"${name}"：分包数量无效"${countRaw}"`); continue;
          }

          const method = LABEL_TO_METHOD[methodRaw];
          if (!method) {
            errors.push(`第${rowNum}行"${name}"：拆分方式无效"${methodRaw}"，只能填写 平均分/比例模板/指定金额`);
            continue;
          }

          // 解析各包数值
          const values: number[] = [];
          let hasParseError = false;
          for (let j = 0; j < count; j++) {
            const colKey = `包${j + 1}`;
            const cellRaw = raw[colKey];
            const cellStr = String(cellRaw ?? '').trim();
            if (!cellStr) {
              errors.push(`第${rowNum}行"${name}"：包${j + 1}的值为空`);
              hasParseError = true; break;
            }

            if (method === 'ratio') {
              // 百分数，可能带%
              const numStr = cellStr.replace(/%$/, '');
              const num = parseFloat(numStr);
              if (isNaN(num) || num < 0) {
                errors.push(`第${rowNum}行"${name}"：包${j + 1}比例"${cellStr}"无效`);
                hasParseError = true; break;
              }
              values.push(Math.round(num * 100)); // 万分比
            } else {
              // 金额(元) 或平均分金额
              const num = parseFloat(cellStr);
              if (isNaN(num) || num < 0) {
                errors.push(`第${rowNum}行"${name}"：包${j + 1}金额"${cellStr}"无效`);
                hasParseError = true; break;
              }
              values.push(Math.round(num * 100)); // 分
            }
          }
          if (hasParseError) continue;

          // 校验比例总和
          if (method === 'ratio') {
            const ratioSum = values.reduce((a, b) => a + b, 0);
            if (Math.abs(ratioSum - 10000) > 1) {
              errors.push(`第${rowNum}行"${name}"：比例总和为${(ratioSum / 100).toFixed(1)}%，应为100%`);
              continue;
            }
          }

          // 校验金额总和（指定金额模式）
          if (method === 'fixedAmount') {
            const amountSum = values.reduce((a, b) => a + b, 0);
            const targetFen = fenbiaoTotals.get(name) || 0;
            if (amountSum !== targetFen) {
              errors.push(`第${rowNum}行"${name}"：金额总和${fenToYuan(amountSum).toFixed(2)}元 ≠ 分标总金额${fenToYuan(targetFen).toFixed(2)}元，差额${fenToYuan(amountSum - targetFen).toFixed(2)}元`);
              continue;
            }
          }

          // 平均分模式也校验金额总和
          if (method === 'average') {
            const amountSum = values.reduce((a, b) => a + b, 0);
            const targetFen = fenbiaoTotals.get(name) || 0;
            if (Math.abs(amountSum - targetFen) > 1) {
              errors.push(`第${rowNum}行"${name}"：平均分金额总和${fenToYuan(amountSum).toFixed(2)}元 ≠ 分标总金额${fenToYuan(targetFen).toFixed(2)}元`);
              continue;
            }
          }

          rows.push({ name, packageCount: count, method, values, rawMethod: methodRaw });
        }

        // 检查分标是否齐全
        const importedNames = new Set(rows.map(r => r.name));
        const missing = fenbiaoNames.filter(n => !importedNames.has(n));
        if (missing.length > 0) {
          errors.push(`缺少以下分标：${missing.join('、')}`);
        }

        resolve({ success: errors.length === 0, rows, errors });
      } catch (err) {
        resolve({ success: false, rows: [], errors: [`文件读取失败: ${err}`] });
      }
    };
    reader.onerror = () => resolve({ success: false, rows: [], errors: ['文件读取失败'] });
    reader.readAsArrayBuffer(file);
  });
}

/** 读取分包数量配置模板 */
export function readConfigTemplate(file: File): Promise<{ name: string; count: number | null }[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
        const result = jsonData.map(row => {
          const name = String(row['分标名称'] ?? '').trim();
          const rawCount = row['分包数量'];
          const count = (rawCount !== '' && rawCount != null && !isNaN(Number(rawCount)))
            ? Math.floor(Number(rawCount)) : null;
          return { name, count };
        });
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('读取模板文件失败'));
    reader.readAsArrayBuffer(file);
  });
}
