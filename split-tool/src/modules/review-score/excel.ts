import * as XLSX from 'xlsx';
import type { ColumnDef, ExportSheetData, ImportedWorkbook, ImportedRow, MergeRange, SchemaId } from './types';

const HEADER_ROW_INDEX = 3;
const DATA_START_ROW_INDEX = 4;
const HEADER_ROW_COUNT = 4;
const SCORE_FILL = 'FDE7B3';
const SCORE_FONT = '8A4B08';

function normalizeText(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
}

function normalizeMatrix(matrix: unknown[][]): string[][] {
  const columnCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  return matrix.map((row) => Array.from({ length: columnCount }, (_, colIndex) => normalizeText(row[colIndex])));
}

function normalizeMerges(sheet: XLSX.WorkSheet): MergeRange[] {
  const merges = (sheet['!merges'] || []) as XLSX.Range[];
  return merges.map((merge) => ({
    startRow: merge.s.r,
    startCol: merge.s.c,
    endRow: merge.e.r,
    endCol: merge.e.c
  }));
}

function uniqueColumns(headerRow: unknown[]): ColumnDef[] {
  const counts = new Map<string, number>();
  return headerRow.map((rawLabel, colIndex) => {
    const label = normalizeText(rawLabel) || `空列_${colIndex + 1}`;
    const occurrence = (counts.get(label) || 0) + 1;
    counts.set(label, occurrence);
    return {
      key: occurrence === 1 ? label : `${label}#${occurrence}`,
      label,
      colIndex,
      occurrence
    };
  });
}

function detectSchemaId(columns: ColumnDef[]): SchemaId {
  const labels = new Set(columns.map((column) => column.label));
  if (labels.has('关键技术参数1-配变负载损耗（kW）')) return 'transformer';
  if (labels.has('用螺栓或螺钉与外部导体连接（用于连接外部绝缘导体）的端子温升')) return 'branch-box';
  if (labels.has('维卡软化温度（摄氏度）')) return 'conduit';
  throw new Error('未识别到受支持的表头类型');
}

function schemaName(id: SchemaId): string {
  switch (id) {
    case 'transformer':
      return '10kV箱变-欧式-硅钢片';
    case 'branch-box':
      return '低压/高压电缆分支箱';
    case 'conduit':
      return '电缆保护管 CPVC / MPP';
  }
}

function rowHasContent(cells: unknown[]): boolean {
  return cells.some((cell) => normalizeText(cell) !== '');
}

export function parseWorkbook(data: Uint8Array, fileName: string): ImportedWorkbook {
  const workbook = XLSX.read(data, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawMatrix = normalizeMatrix(XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: ''
  }));
  const merges = normalizeMerges(sheet);

  if (rawMatrix.length <= DATA_START_ROW_INDEX) {
    throw new Error('表格内容不足，无法读取评分数据');
  }

  const columns = uniqueColumns(rawMatrix[HEADER_ROW_INDEX] || []);
  const schemaId = detectSchemaId(columns);
  const rows: ImportedRow[] = [];

  for (let rowIndex = DATA_START_ROW_INDEX; rowIndex < rawMatrix.length; rowIndex++) {
    const rawRow = rawMatrix[rowIndex] || [];
    if (!rowHasContent(rawRow)) continue;

    const values: Record<string, string> = {};
    columns.forEach((column) => {
      values[column.key] = normalizeText(rawRow[column.colIndex]);
    });

    rows.push({
      rowNumber: rowIndex + 1,
      values,
      rawValues: [...rawRow]
    });
  }

  return {
    fileName,
    sheetName,
    schemaId,
    schemaName: schemaName(schemaId),
    columns,
    rows,
    rawMatrix,
    merges,
    headerRowCount: HEADER_ROW_COUNT,
    columnCount: rawMatrix[0]?.length || columns.length
  };
}

export function readWorkbookFile(file: File): Promise<ImportedWorkbook> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const buffer = new Uint8Array(reader.result as ArrayBuffer);
        resolve(parseWorkbook(buffer, file.name));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsArrayBuffer(file);
  });
}

function applyCellStyle(sheet: XLSX.WorkSheet, rowIndex: number, colIndex: number, style: Record<string, unknown>): void {
  const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
  const cell = sheet[cellAddress];
  if (!cell) return;
  (cell as XLSX.CellObject & { s?: Record<string, unknown> }).s = style;
}

function applySheetStyles(sheet: XLSX.WorkSheet, sheetData: ExportSheetData): void {
  const rowCount = sheetData.matrix.length;
  const colCount = sheetData.matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const scoreColumns = new Set(sheetData.scoreColumnIndexes);

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let colIndex = 0; colIndex < colCount; colIndex++) {
      const baseStyle: Record<string, unknown> = {
        border: {
          top: { style: 'thin', color: { rgb: 'DCCCB3' } },
          bottom: { style: 'thin', color: { rgb: 'DCCCB3' } },
          left: { style: 'thin', color: { rgb: 'DCCCB3' } },
          right: { style: 'thin', color: { rgb: 'DCCCB3' } }
        },
        alignment: {
          vertical: 'center',
          horizontal: rowIndex < HEADER_ROW_COUNT ? 'center' : 'left',
          wrapText: true
        },
        font: {
          name: 'Microsoft YaHei',
          sz: rowIndex < HEADER_ROW_COUNT ? 11 : 10,
          bold: rowIndex < HEADER_ROW_COUNT
        }
      };

      if (scoreColumns.has(colIndex)) {
        baseStyle.fill = {
          patternType: 'solid',
          fgColor: { rgb: SCORE_FILL }
        };
        baseStyle.font = {
          ...(baseStyle.font as Record<string, unknown>),
          color: { rgb: SCORE_FONT },
          bold: true
        };
        baseStyle.alignment = {
          ...(baseStyle.alignment as Record<string, unknown>),
          horizontal: 'center'
        };
      }

      applyCellStyle(sheet, rowIndex, colIndex, baseStyle);
    }
  }

  sheet['!cols'] = Array.from({ length: colCount }, (_, colIndex) => ({
    wch: scoreColumns.has(colIndex) ? 14 : 18
  }));
}

export function buildExportBuffer(resultSheetData: ExportSheetData, ruleRows: Array<Record<string, string>>): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const resultSheet = XLSX.utils.aoa_to_sheet(resultSheetData.matrix);
  resultSheet['!merges'] = resultSheetData.merges.map((merge) => ({
    s: { r: merge.startRow, c: merge.startCol },
    e: { r: merge.endRow, c: merge.endCol }
  }));
  applySheetStyles(resultSheet, resultSheetData);
  const ruleSheet = XLSX.utils.json_to_sheet(ruleRows);
  XLSX.utils.book_append_sheet(workbook, resultSheet, resultSheetData.sheetName || '评分结果');
  XLSX.utils.book_append_sheet(workbook, ruleSheet, '规则说明');
  const arrayBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array', cellStyles: true }) as ArrayBuffer;
  return new Uint8Array(arrayBuffer);
}