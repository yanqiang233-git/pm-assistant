import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { SplitRow, FenbiaoConfig, SplitMethod, RatioTemplate } from '../types';
import {
  bigIntToDecimalString,
  compareDecimalStrings,
  decimalToBigInt,
  getDecimalScale,
  getMaxDecimalScale,
  isDecimalAbsLessThan,
  normalizeDecimalString,
  splitAverageBigInt,
  subtractDecimalStrings,
  sumDecimalStrings,
  toFixedDecimalString
} from '../split/precision';

const AMOUNT_TOLERANCE = '0.01';

const EXPORT_FIELD_FORMATTERS: Partial<Record<string, string>> = {
  '估算总价（元）': '0.00',
  '估算单价（元）': '0.00',
  '数量': '0.000'
};

const DISPLAYED_PRECISION_CALC_PR = '<calcPr calcMode="auto" calcOnSave="1" fullCalcOnLoad="1" fullPrecision="0"/>';

async function applyDisplayedPrecisionToWorkbook(data: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const workbookEntry = zip.file('xl/workbook.xml');
  if (!workbookEntry) return data;

  const workbookXml = await workbookEntry.async('string');
  const nextWorkbookXml = workbookXml.includes('<calcPr')
    ? workbookXml.replace(/<calcPr[^>]*\/>/, DISPLAYED_PRECISION_CALC_PR)
    : workbookXml.replace('</workbook>', `${DISPLAYED_PRECISION_CALC_PR}</workbook>`);

  if (nextWorkbookXml === workbookXml) return data;

  zip.file('xl/workbook.xml', nextWorkbookXml);
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
}

function applyExportNumberFormat(ws: XLSX.WorkSheet, headerOrder: string[], rowCount: number): void {
  for (let colIndex = 0; colIndex < headerOrder.length; colIndex++) {
    const format = EXPORT_FIELD_FORMATTERS[headerOrder[colIndex]];
    if (!format) continue;
    for (let rowIndex = 1; rowIndex < rowCount; rowIndex++) {
      const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      const cell = ws[cellRef];
      if (cell?.t === 'n') {
        cell.z = format;
      }
    }
  }
}

function applyMoneyNumberFormat(ws: XLSX.WorkSheet, rowCount: number, maxPkg: number): void {
  const moneyCols = [1, ...Array.from({ length: maxPkg }, (_, index) => 4 + index)];
  for (let rowIndex = 1; rowIndex < rowCount; rowIndex++) {
    for (const colIndex of moneyCols) {
      const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      const cell = ws[cellRef];
      if (cell?.t === 'n') {
        cell.z = '0.0000';
      }
    }
  }
}

/** 通过 Tauri 原生对话框保存文件，浏览器环境回退到 Blob 下载 */
async function saveToFile(data: Uint8Array, filename: string): Promise<void> {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const filePath = await save({
      title: '保存文件',
      defaultPath: filename,
      filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
    });
    if (filePath) {
      await writeFile(filePath, data);
    }
    return;
  } catch {
    // Not in Tauri, fall back to browser download
  }
  const blob = new Blob([data.buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

const AMOUNT_TEXT_EXPORT_FIELDS = new Set(['估算总价（元）', '估算单价（元）']);
const NUMERIC_EXPORT_FIELDS = new Set(['数量']);

function formatExportCellValue(field: string, value: unknown): unknown {
  if (AMOUNT_TEXT_EXPORT_FIELDS.has(field)) {
    if (value === '' || value == null) return '';
    return toFixedDecimalString(value, 2) ?? String(value);
  }

  if (NUMERIC_EXPORT_FIELDS.has(field) && value !== '' && value != null) {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }

  return value;
}

/** 将拆分结果写入 xlsx 并下载，同时返回二进制数据用于项目目录镜像 */
export async function exportToXlsx(
  rows: SplitRow[],
  headerOrder: string[],
  outputFileName: string
): Promise<Uint8Array> {
  const wsData: unknown[][] = [headerOrder];
  for (const row of rows) {
    const line: unknown[] = headerOrder.map(h => formatExportCellValue(h, row[h] ?? ''));
    wsData.push(line);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  applyExportNumberFormat(ws, headerOrder, wsData.length);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const rawData = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  const data = await applyDisplayedPrecisionToWorkbook(rawData);
  await saveToFile(data, outputFileName);
  return data;
}

/** 下载分包数量配置模板，同时返回二进制数据用于项目目录镜像 */
export async function downloadConfigTemplate(fenbiaoNames: string[]): Promise<Uint8Array> {
  const wsData: unknown[][] = [['分标名称', '分包数量']];
  for (const name of fenbiaoNames) {
    wsData.push([name, '']);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 30 }, { wch: 15 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '分包数量配置');
  const rawData = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  const data = await applyDisplayedPrecisionToWorkbook(rawData);
  await saveToFile(data, '分包数量配置模板.xlsx');
  return data;
}

/** 拆分方式中文名映射 */
const METHOD_LABELS: Record<SplitMethod, string> = {
  average: '平均分',
  ratio: '比例模板',
  fixedAmount: '参考金额'
};
const LABEL_TO_METHOD: Record<string, SplitMethod> = {
  '平均分': 'average',
  '比例模板': 'ratio',
  '指定金额': 'fixedAmount',
  '参考金额': 'fixedAmount'
};

/**
 * 下载拆分方式配置模板
 * 列结构: 分标名称 | 分包数量 | 拆分方式 | 包1 | 包2 | ... | 包N
 * - 平均分: 自动计算每包金额
 * - 比例模板: 填百分数
 * - 参考金额: 填参考金额(元)，仅作为拆分权重
 */
export async function downloadSplitConfigTemplate(
  configs: FenbiaoConfig[],
  defaultMethod: SplitMethod,
  templates: RatioTemplate[],
  exactFenbiaoAmountTotals: Record<string, string> = {}
): Promise<Uint8Array> {
  // 计算最大分包数以确定列数
  const maxPkg = Math.max(...configs.map(c => c.packageCount), 1);
  // 表头
  const header: string[] = ['分标名称', '估算总价（元）', '分包数量', '拆分方式'];
  for (let i = 1; i <= maxPkg; i++) header.push(`包${i}`);
  const wsData: unknown[][] = [header];

  for (const c of configs) {
    if (c.packageCount < 1) continue;
    const method = c.overridden ? c.splitMethod : defaultMethod;
    const exactTotal = exactFenbiaoAmountTotals[c.name] ?? '0';
    const row: unknown[] = [c.name, exactTotal, c.packageCount, METHOD_LABELS[method]];

    if (method === 'average') {
      // 自动带出每包金额
      const scale = getMaxDecimalScale([exactTotal]);
      const shares = splitAverageBigInt(decimalToBigInt(exactTotal, scale), c.packageCount)
        .map(share => bigIntToDecimalString(share, scale));
      for (let i = 0; i < maxPkg; i++) {
        row.push(i < c.packageCount ? shares[i] : '');
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
      // 如果已设参考金额，带出；否则留空
      for (let i = 0; i < maxPkg; i++) {
        if (i < c.packageCount && c.fixedAmounts?.[i] != null) {
          row.push(c.fixedAmounts[i]);
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
  applyMoneyNumberFormat(ws, wsData.length, maxPkg);
  // 设置列宽
  ws['!cols'] = [{ wch: 30 }, { wch: 18 }, { wch: 10 }, { wch: 12 }];
  for (let i = 0; i < maxPkg; i++) ws['!cols']!.push({ wch: 14 });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '拆分方式配置');
  const rawData = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  const data = await applyDisplayedPrecisionToWorkbook(rawData);
  await saveToFile(data, '拆分方式配置模板.xlsx');
  return data;
}

export interface SplitConfigRow {
  name: string;
  packageCount: number;
  method: SplitMethod;
  ratioValues?: number[];
  amountValues?: string[];
  rawMethod: string;
}

export interface SplitConfigImportResult {
  success: boolean;
  rows: SplitConfigRow[];
  errors: string[];
  notices: string[];
}

/** 读取拆分方式配置模板并校验 */
export function readSplitConfigTemplate(
  file: File,
  fenbiaoNames: string[],
  exactFenbiaoAmountTotals: Record<string, string>,
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
        const notices: string[] = [];
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
            errors.push(`第${rowNum}行"${name}"：拆分方式无效"${methodRaw}"，只能填写 平均分/比例模板/参考金额`);
            continue;
          }

          // 解析各包数值
          const ratioValues: number[] = [];
          const amountValues: string[] = [];
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
              ratioValues.push(Math.round(num * 100)); // 万分比
            } else {
              // 金额(元) 或平均分金额
              const normalized = normalizeDecimalString(cellStr);
              if (normalized == null || normalized.startsWith('-')) {
                errors.push(`第${rowNum}行"${name}"：包${j + 1}金额"${cellStr}"无效`);
                hasParseError = true; break;
              }
              amountValues.push(normalized);
            }
          }
          if (hasParseError) continue;

          // 校验比例总和
          if (method === 'ratio') {
            const ratioSum = ratioValues.reduce((a, b) => a + b, 0);
            if (Math.abs(ratioSum - 10000) > 1) {
              errors.push(`第${rowNum}行"${name}"：比例总和为${(ratioSum / 100).toFixed(1)}%，应为100%`);
              continue;
            }
          }

          // 指定金额模式下，这里只作为参考金额导入，不再要求总和贴合分标总额。
          if (method === 'fixedAmount') {
            const targetAmount = exactFenbiaoAmountTotals[name] ?? '0';
            const amountSum = sumDecimalStrings(amountValues);
            const diff = subtractDecimalStrings(amountSum, targetAmount);
            if (compareDecimalStrings(diff, '0') !== 0) {
              notices.push(`第${rowNum}行“${name}”参考金额合计为${amountSum}元，与分标总金额${targetAmount}元差额${diff}元；系统将其仅作为拆分权重使用`);
            }
          }

          // 平均分模式也校验金额总和
          if (method === 'average') {
            const amountSum = sumDecimalStrings(amountValues);
            const targetAmount = exactFenbiaoAmountTotals[name] ?? '0';
            const diff = subtractDecimalStrings(amountSum, targetAmount);
            if (compareDecimalStrings(diff, '0') !== 0 && !isDecimalAbsLessThan(diff, AMOUNT_TOLERANCE)) {
              errors.push(`第${rowNum}行“${name}”：平均分金额总和${amountSum}元 ≠ 分标总金额${targetAmount}元，差额${diff}元`);
              continue;
            }
            if (compareDecimalStrings(diff, '0') !== 0 && isDecimalAbsLessThan(diff, AMOUNT_TOLERANCE)) {
              notices.push(`第${rowNum}行“${name}”平均分金额差额${diff}元，小于${AMOUNT_TOLERANCE}元，允许导入，拆分时按系统金额结果补齐尾差`);
            }
          }

          rows.push({
            name,
            packageCount: count,
            method,
            ratioValues: method === 'ratio' ? ratioValues : undefined,
            amountValues: method === 'ratio' ? undefined : amountValues,
            rawMethod: methodRaw
          });
        }

        // 检查分标是否齐全
        const importedNames = new Set(rows.map(r => r.name));
        const missing = fenbiaoNames.filter(n => !importedNames.has(n));
        if (missing.length > 0) {
          errors.push(`缺少以下分标：${missing.join('、')}`);
        }

        resolve({ success: errors.length === 0, rows, errors, notices });
      } catch (err) {
        resolve({ success: false, rows: [], errors: [`文件读取失败: ${err}`], notices: [] });
      }
    };
    reader.onerror = () => resolve({ success: false, rows: [], errors: ['文件读取失败'], notices: [] });
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
