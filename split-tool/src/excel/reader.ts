import * as XLSX from 'xlsx';
import { REQUIRED_FIELDS, ExcelRow, ValidationError, ImportResult } from '../types';

/** 核心校验逻辑：接收二进制数据和文件名，返回 ImportResult */
function validateExcelData(data: Uint8Array, fileName: string): ImportResult {
  try {
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json<ExcelRow>(sheet, { defval: '' });
    if (jsonData.length === 0) {
      return {
        success: false, fileName, rows: [], headers: [],
        headerOrder: [], fenbiaoNames: [], totalRows: 0,
        errors: [{ type: 'missing_fields', message: '表格为空或无法读取数据' }]
      };
    }

    // 获取原始列顺序
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const headerOrder: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r: range.s.r, c })];
      if (cell && cell.v != null) headerOrder.push(String(cell.v).trim());
    }

    const headers = headerOrder;
    const errors: ValidationError[] = [];

    // 1. 表头完整性校验
    const missing = REQUIRED_FIELDS.filter(f => !headers.includes(f));
    if (missing.length > 0) {
      errors.push({
        type: 'missing_fields',
        message: `缺少 ${missing.length} 个必要字段`,
        details: [...missing]
      });
      return {
        success: false, fileName, rows: jsonData, headers,
        headerOrder, fenbiaoNames: [], totalRows: jsonData.length, errors
      };
    }

    // 2. 分包状态校验
    const hasPackage = jsonData.some(row => {
      const v = row['分包名称'];
      return v !== undefined && v !== null && String(v).trim() !== '';
    });
    if (hasPackage) {
      errors.push({
        type: 'already_packed',
        message: '该表已完成分包，无需再分包'
      });
      return {
        success: false, fileName, rows: jsonData, headers,
        headerOrder, fenbiaoNames: [], totalRows: jsonData.length, errors
      };
    }

    // 3. 网省采购申请号唯一性校验
    const idMap = new Map<string, number>();
    jsonData.forEach(row => {
      const id = String(row['网省采购申请号'] ?? '').trim();
      if (id) idMap.set(id, (idMap.get(id) || 0) + 1);
    });
    const duplicates = [...idMap.entries()].filter(([, count]) => count > 1);
    if (duplicates.length > 0) {
      errors.push({
        type: 'duplicate_申请号',
        message: `发现 ${duplicates.length} 个重复的网省采购申请号`,
        details: duplicates.map(([id, count]) => `${id} (出现 ${count} 次)`)
      });
      return {
        success: false, fileName, rows: jsonData, headers,
        headerOrder, fenbiaoNames: [], totalRows: jsonData.length, errors
      };
    }

    // 4. 数值字段校验
    const numErrors: string[] = [];
    jsonData.forEach((row, idx) => {
      const rowNum = idx + 2; // Excel 行号 = 索引 + 2 (1为表头)
      const qty = row['数量'];
      const price = row['估算总价（元）'];
      if (qty === '' || qty === null || qty === undefined || isNaN(Number(qty))) {
        numErrors.push(`第 ${rowNum} 行"数量"字段异常: "${qty}"`);
      }
      if (price === '' || price === null || price === undefined || isNaN(Number(price))) {
        numErrors.push(`第 ${rowNum} 行"估算总价（元）"字段异常: "${price}"`);
      }
    });
    if (numErrors.length > 0) {
      errors.push({
        type: 'invalid_number',
        message: `发现 ${numErrors.length} 处数值异常`,
        details: numErrors
      });
      return {
        success: false, fileName, rows: jsonData, headers,
        headerOrder, fenbiaoNames: [], totalRows: jsonData.length, errors
      };
    }

    // 提取分标名称（升序）
    const fenbiaoSet = new Set<string>();
    jsonData.forEach(row => {
      const name = String(row['分标名称'] ?? '').trim();
      if (name) fenbiaoSet.add(name);
    });
    const fenbiaoNames = [...fenbiaoSet].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    return {
      success: true, fileName, rows: jsonData, headers,
      headerOrder, fenbiaoNames, totalRows: jsonData.length, errors: []
    };
  } catch (err) {
    return {
      success: false, fileName, rows: [], headers: [],
      headerOrder: [], fenbiaoNames: [], totalRows: 0,
      errors: [{ type: 'missing_fields', message: `读取文件失败: ${err}` }]
    };
  }
}

/** 读取 xlsx 文件并进行全部校验 */
export function readAndValidate(file: File): Promise<ImportResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target!.result as ArrayBuffer);
      resolve(validateExcelData(data, file.name));
    };
    reader.onerror = () => {
      resolve({
        success: false, fileName: file.name, rows: [], headers: [],
        headerOrder: [], fenbiaoNames: [], totalRows: 0,
        errors: [{ type: 'missing_fields', message: '文件读取失败' }]
      });
    };
    reader.readAsArrayBuffer(file);
  });
}

/** 从二进制数据直接校验（用于从磁盘恢复） */
export function readAndValidateBuffer(data: Uint8Array, fileName: string): ImportResult {
  return validateExcelData(data, fileName);
}
