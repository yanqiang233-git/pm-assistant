import { buildExportBuffer, readWorkbookFile } from './excel';
import { getSchemaDefinition, scoreWorkbookRows } from './rules';
import {
  ensureModuleDirs,
  mirrorExportResult,
  mirrorImportFile
} from '../../shared/store/project-files';
import type {
  ExportSheetData,
  ImportedWorkbook,
  MergeRange,
  ScoredRow,
  SchemaDefinition,
  ScoreRule
} from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('fileInput');
const btnImport = $('btnImport');
const btnRetry = $('btnRetry');
const btnScore = $('btnScore');
const btnExport = $('btnExport');

const importStatus = $('importStatus');
const schemaStatus = $('schemaStatus');
const previewStatus = $('previewStatus');
const exportStatus = $('exportStatus');

const importInfo = $('importInfo');
const importErrors = $('importErrors');
const schemaSummary = $('schemaSummary');
const previewSummary = $('previewSummary');
const exportSummary = $('exportSummary');
const previewErrors = $('previewErrors');

const ruleTableBody = $('ruleTableBody');
const previewHead = $('previewHead');
const previewBody = $('previewBody');
const configPanel = $('configPanel');
const configFields = $('configFields');

type AppState = {
  imported: ImportedWorkbook | null;
  schema: SchemaDefinition | null;
  configValues: Record<string, string>;
  manualValues: Record<string, Record<string, string>>;
  lastFile: File | null;
};

const state: AppState = {
  imported: null,
  schema: null,
  configValues: {},
  manualValues: {},
  lastFile: null
};

void ensureModuleDirs();

function setStatus(element: HTMLElement, text: string, kind?: 'success' | 'warning' | 'error'): void {
  element.textContent = text;
  element.className = `status-badge${kind ? ` ${kind}` : ''}`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatScore(score: number | null): string {
  if (score == null) return '--';
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function truncatePreviewText(text: string, limit = 100): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

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
    // Not in Tauri, fall back to browser download.
  }

  const browserData = new Uint8Array(data.byteLength);
  browserData.set(data);
  const blob = new Blob([browserData], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

function enableSections(): void {
  document.querySelectorAll('.disabled-module').forEach((element) => {
    element.classList.remove('disabled-module');
  });
}

function renderRuleTable(): void {
  if (!state.schema) {
    ruleTableBody.innerHTML = '';
    return;
  }
  ruleTableBody.innerHTML = state.schema.rules.map((rule, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(rule.module)}</td>
      <td>${esc(rule.item)}</td>
      <td>${esc(rule.fields.join('；'))}</td>
      <td>${esc(rule.algorithm)}</td>
      <td>${rule.mode === 'auto' ? '自动' : '人工'}</td>
    </tr>
  `).join('');
}

function renderConfigPanel(): void {
  if (!state.schema || state.schema.configFields.length === 0) {
    configPanel.classList.add('hidden');
    configFields.innerHTML = '';
    return;
  }
  configPanel.classList.remove('hidden');
  configFields.innerHTML = state.schema.configFields.map((field) => `
    <div class="config-field">
      <label for="cfg-${field.key}">${esc(field.label)}</label>
      <input id="cfg-${field.key}" data-config-key="${field.key}" type="number" step="0.001" value="${esc(state.configValues[field.key] || '')}" placeholder="${esc(field.placeholder || '请输入数值')}" />
    </div>
  `).join('');
}

function renderSchemaSummary(): void {
  if (!state.imported || !state.schema) return;
  schemaSummary.classList.remove('hidden');
  schemaSummary.textContent = [
    `识别规则集：${state.schema.name}`,
    `工作表：${state.imported.sheetName}`,
    `有效数据行数：${state.imported.rows.length}`,
    `自动规则：${state.schema.rules.filter((rule) => rule.mode === 'auto').length} 条`,
    `人工规则：${state.schema.rules.filter((rule) => rule.mode === 'manual').length} 条`
  ].join('\n');
}

type Placement = {
  rule: ScoreRule;
  afterCol: number;
};

type HeaderRenderCell = {
  value: string;
  colspan: number;
  rowspan: number;
  isScore: boolean;
  title?: string;
};

function expandHeaderMatrix(workbook: ImportedWorkbook): string[][] {
  const headerRows = workbook.rawMatrix.slice(0, workbook.headerRowCount).map((row) => [...row]);
  const matrix = Array.from({ length: workbook.headerRowCount }, (_, rowIndex) => (
    Array.from({ length: workbook.columnCount }, (_, colIndex) => rowIndex < headerRows.length ? (headerRows[rowIndex]?.[colIndex] || '') : '')
  ));

  workbook.merges.forEach((merge) => {
    if (merge.startRow >= workbook.headerRowCount) return;
    const value = matrix[merge.startRow]?.[merge.startCol] || '';
    for (let rowIndex = merge.startRow; rowIndex <= Math.min(merge.endRow, workbook.headerRowCount - 1); rowIndex++) {
      for (let colIndex = merge.startCol; colIndex <= merge.endCol; colIndex++) {
        matrix[rowIndex][colIndex] = value;
      }
    }
  });

  return matrix;
}

function findRuleAnchorColumn(rule: ScoreRule, workbook: ImportedWorkbook): number {
  const findCandidateColumn = (candidate: string): number => {
    const exactKeyMatch = workbook.columns.find((column) => column.key === candidate);
    if (exactKeyMatch) return exactKeyMatch.colIndex;

    const exactLabelMatch = workbook.columns.find((column) => column.label === candidate);
    if (exactLabelMatch) return exactLabelMatch.colIndex;

    if (candidate !== '人工录入' && candidate !== '各省提供' && candidate !== '主观项得分') {
      const fuzzyMatch = workbook.columns.find((column) => column.label.includes(candidate) || candidate.includes(column.label));
      if (fuzzyMatch) return fuzzyMatch.colIndex;
    }

    return -1;
  };

  if (rule.sourceFieldKey) {
    const sourceColumn = findCandidateColumn(rule.sourceFieldKey);
    if (sourceColumn >= 0) return sourceColumn;
  }

  const candidates = rule.fields.filter((value): value is string => Boolean(value));
  let found = -1;

  candidates.forEach((candidate) => {
    const candidateColumn = findCandidateColumn(candidate);
    if (candidateColumn >= 0) {
      found = Math.max(found, candidateColumn);
    }
  });

  return found >= 0 ? found : workbook.columnCount - 1;
}

function buildPlacements(workbook: ImportedWorkbook, schema: SchemaDefinition): Placement[] {
  return schema.rules
    .map((rule) => ({ rule, afterCol: findRuleAnchorColumn(rule, workbook) }))
    .sort((left, right) => left.afterCol - right.afterCol);
}

function buildAugmentedHeaderMatrix(workbook: ImportedWorkbook, placements: Placement[]): { matrix: string[][]; scoreColumnIndexes: number[] } {
  const originalHeader = expandHeaderMatrix(workbook);
  const matrix = Array.from({ length: workbook.headerRowCount }, () => [] as string[]);
  const scoreColumnIndexes: number[] = [];

  for (let colIndex = 0; colIndex < workbook.columnCount; colIndex++) {
    for (let rowIndex = 0; rowIndex < workbook.headerRowCount; rowIndex++) {
      matrix[rowIndex].push(originalHeader[rowIndex]?.[colIndex] || '');
    }

    placements.filter((placement) => placement.afterCol === colIndex).forEach((placement) => {
      matrix[0].push(originalHeader[0]?.[colIndex] || '评分结果');
      matrix[1].push(originalHeader[1]?.[colIndex] || originalHeader[0]?.[colIndex] || '评分结果');
      matrix[2].push(placement.rule.item);
      matrix[3].push('得分');
      scoreColumnIndexes.push(matrix[3].length - 1);
    });
  }

  matrix[0].push('评分结果');
  matrix[1].push('评分结果');
  matrix[2].push('总分');
  matrix[3].push('得分');
  scoreColumnIndexes.push(matrix[3].length - 1);

  return { matrix, scoreColumnIndexes };
}

function compressHeaderMatrix(matrix: string[][], scoreColumnIndexes: number[]): { rows: HeaderRenderCell[][]; merges: MergeRange[] } {
  const rowCount = matrix.length;
  const colCount = matrix[0]?.length || 0;
  const covered = Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => false));
  const scoreColumns = new Set(scoreColumnIndexes);
  const rows: HeaderRenderCell[][] = Array.from({ length: rowCount }, () => []);
  const merges: MergeRange[] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    for (let colIndex = 0; colIndex < colCount; colIndex++) {
      if (covered[rowIndex][colIndex]) continue;
      const value = matrix[rowIndex][colIndex] || '';

      let colspan = 1;
      while (
        colIndex + colspan < colCount &&
        !covered[rowIndex][colIndex + colspan] &&
        matrix[rowIndex][colIndex + colspan] === value
      ) {
        colspan += 1;
      }

      let rowspan = 1;
      rowLoop: while (rowIndex + rowspan < rowCount) {
        for (let offset = 0; offset < colspan; offset++) {
          if (covered[rowIndex + rowspan][colIndex + offset] || matrix[rowIndex + rowspan][colIndex + offset] !== value) {
            break rowLoop;
          }
        }
        rowspan += 1;
      }

      for (let y = rowIndex; y < rowIndex + rowspan; y++) {
        for (let x = colIndex; x < colIndex + colspan; x++) {
          covered[y][x] = true;
        }
      }

      rows[rowIndex].push({
        value,
        colspan,
        rowspan,
        isScore: Array.from({ length: colspan }, (_, offset) => scoreColumns.has(colIndex + offset)).every(Boolean),
        title: value
      });

      if (colspan > 1 || rowspan > 1) {
        merges.push({
          startRow: rowIndex,
          startCol: colIndex,
          endRow: rowIndex + rowspan - 1,
          endCol: colIndex + colspan - 1
        });
      }
    }
  }

  return { rows, merges };
}

function getScoreCellMarkup(rowId: string, rule: ScoreRule, scoreRow: ScoredRow): string {
  const cell = scoreRow.cells[rule.key];
  if (cell.mode === 'manual') {
    return `<input class="score-input score-input-inline" data-row-id="${rowId}" data-rule-key="${rule.key}" type="number" step="${cell.step || 1}" min="${cell.min ?? ''}" max="${cell.max ?? ''}" value="${cell.score == null ? '' : cell.score}" placeholder="人工" />`;
  }
  const tone = cell.score == null ? 'pending' : '';
  const title = cell.note ? ` title="${esc(cell.note)}"` : '';
  return `<span class="score-text ${tone}"${title}>${cell.score == null ? '待补' : formatScore(cell.score)}</span>`;
}

function buildPreviewTable(scoredRows: ScoredRow[]): { headHtml: string; bodyHtml: string; exportSheetData: ExportSheetData } {
  if (!state.imported || !state.schema) {
    return {
      headHtml: '',
      bodyHtml: '',
      exportSheetData: { sheetName: '评分结果', matrix: [], merges: [], scoreColumnIndexes: [] }
    };
  }

  const placements = buildPlacements(state.imported, state.schema);
  const { matrix: augmentedHeaderMatrix, scoreColumnIndexes } = buildAugmentedHeaderMatrix(state.imported, placements);
  const { rows: headerRows, merges } = compressHeaderMatrix(augmentedHeaderMatrix, scoreColumnIndexes);
  const scoreRowMap = new Map(scoredRows.map((row) => [row.rowId, row]));

  const headHtml = headerRows.map((row) => `
    <tr>
      ${row.map((cell) => {
        const compactValue = cell.isScore && cell.value !== '得分' && cell.value !== '总分' ? '评分项' : cell.value;
        const title = cell.title ? ` title="${esc(cell.title)}"` : '';
        const body = cell.isScore
          ? `<span class="score-head-text">${esc(compactValue)}</span>`
          : esc(truncatePreviewText(compactValue));
        return `<th class="${cell.isScore ? 'score-col score-head' : ''}" colspan="${cell.colspan}" rowspan="${cell.rowspan}"${title}>${body}</th>`;
      }).join('')}
    </tr>
  `).join('');

  const bodyHtml = scoredRows.map((scoreRow) => {
    const workbookRow = state.imported!.rows.find((item) => String(item.rowNumber) === scoreRow.rowId);
    const rawValues = workbookRow?.rawValues || [];
    const cells: string[] = [];

    for (let colIndex = 0; colIndex < state.imported!.columnCount; colIndex++) {
      const rawValue = rawValues[colIndex] || '';
      const title = rawValue ? ` title="${esc(rawValue)}"` : '';
      cells.push(`<td class="raw-cell"${title}><span class="cell-clip">${esc(truncatePreviewText(rawValue))}</span></td>`);
      placements.filter((placement) => placement.afterCol === colIndex).forEach((placement) => {
        cells.push(`<td class="score-col score-body">${getScoreCellMarkup(scoreRow.rowId, placement.rule, scoreRow)}</td>`);
      });
    }

    cells.push(`<td class="score-col score-total">${formatScore(scoreRow.currentTotal)}</td>`);
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const exportMatrix: Array<Array<string | number>> = augmentedHeaderMatrix.map((row) => [...row]);
  scoredRows.forEach((scoreRow) => {
    const workbookRow = state.imported!.rows.find((item) => String(item.rowNumber) === scoreRow.rowId);
    const rawValues = workbookRow?.rawValues || [];
    const exportRow: Array<string | number> = [];

    for (let colIndex = 0; colIndex < state.imported!.columnCount; colIndex++) {
      exportRow.push(rawValues[colIndex] || '');
      placements.filter((placement) => placement.afterCol === colIndex).forEach((placement) => {
        const cell = scoreRow.cells[placement.rule.key];
        exportRow.push(cell.score == null ? '' : cell.score);
      });
    }

    exportRow.push(scoreRow.currentTotal);
    exportMatrix.push(exportRow);
  });

  return {
    headHtml,
    bodyHtml,
    exportSheetData: {
      sheetName: '评分结果',
      matrix: exportMatrix,
      merges,
      scoreColumnIndexes
    }
  };
}

function scoreAndRender(): void {
  if (!state.imported || !state.schema) return;
  const { rows, metrics } = scoreWorkbookRows(state.imported, state.schema, state.configValues, state.manualValues);
  const previewTable = buildPreviewTable(rows);
  previewHead.innerHTML = previewTable.headHtml;
  previewBody.innerHTML = previewTable.bodyHtml;

  previewSummary.classList.remove('hidden');
  previewSummary.textContent = [
    `数据行数：${metrics.rowCount}`,
    `自动规则数：${metrics.autoRuleCount}`,
    `人工规则数：${metrics.manualRuleCount}`,
    `待补采购标准/缺数据的自动项单元格：${metrics.pendingAutoCells}`,
    `已填写人工分单元格：${metrics.filledManualCells}`
  ].join('\n');

  exportSummary.classList.remove('hidden');
  exportSummary.textContent = '评分结果已生成，可直接导出为 Excel。';

  setStatus(previewStatus, '已计算', metrics.pendingAutoCells > 0 ? 'warning' : 'success');
  setStatus(exportStatus, '可导出', 'success');
}

function buildExportRows() {
  if (!state.imported || !state.schema) {
    return {
      resultSheetData: { sheetName: '评分结果', matrix: [], merges: [], scoreColumnIndexes: [] },
      ruleRows: []
    };
  }
  const { rows } = scoreWorkbookRows(state.imported, state.schema, state.configValues, state.manualValues);
  const { exportSheetData } = buildPreviewTable(rows);

  const ruleRows = state.schema.rules.map((rule, index) => ({
    序号: String(index + 1),
    评分模块: rule.module,
    评分项: rule.item,
    取数字段: rule.fields.join('；'),
    算法摘要: rule.algorithm,
    状态: rule.mode === 'auto' ? '自动' : '人工'
  }));

  return { resultSheetData: exportSheetData, ruleRows };
}

async function handleImport(file: File): Promise<void> {
  setStatus(importStatus, '读取中', 'warning');
  importErrors.classList.add('hidden');
  previewErrors.classList.add('hidden');

  try {
    const imported = await readWorkbookFile(file);
    const schema = getSchemaDefinition(imported.schemaId);

    state.imported = imported;
    state.schema = schema;
    state.lastFile = file;
    state.manualValues = {};

    importInfo.classList.remove('hidden');
    importInfo.textContent = `文件：${file.name}\n工作表：${imported.sheetName}\n规则集：${schema.name}\n数据行数：${imported.rows.length}`;

    renderSchemaSummary();
    renderRuleTable();
    renderConfigPanel();
    enableSections();
    setStatus(importStatus, '已识别', 'success');
    setStatus(schemaStatus, schema.name, 'success');
    setStatus(previewStatus, '待计算');
    setStatus(exportStatus, '待计算');
    btnRetry.classList.remove('hidden');

    await mirrorImportFile(file);
  } catch (error) {
    importErrors.classList.remove('hidden');
    importErrors.textContent = error instanceof Error ? error.message : String(error);
    setStatus(importStatus, '识别失败', 'error');
  } finally {
    fileInput.value = '';
  }
}

btnImport.addEventListener('click', () => fileInput.click());
btnRetry.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  await handleImport(file);
});

configFields.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  const configKey = target.dataset.configKey;
  if (!configKey) return;
  state.configValues[configKey] = target.value;
});

btnScore.addEventListener('click', () => {
  if (!state.imported || !state.schema) {
    previewErrors.classList.remove('hidden');
    previewErrors.textContent = '请先导入并识别 Excel 文件。';
    return;
  }
  previewErrors.classList.add('hidden');
  scoreAndRender();
});

previewBody.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  const rowId = target.dataset.rowId;
  const ruleKey = target.dataset.ruleKey;
  if (!rowId || !ruleKey) return;
  state.manualValues[rowId] = state.manualValues[rowId] || {};
  state.manualValues[rowId][ruleKey] = target.value;
  scoreAndRender();
});

btnExport.addEventListener('click', async () => {
  if (!state.imported || !state.schema) {
    previewErrors.classList.remove('hidden');
    previewErrors.textContent = '请先完成导入和赋分。';
    return;
  }
  const { resultSheetData, ruleRows } = buildExportRows();
  if (resultSheetData.matrix.length === 0) {
    previewErrors.classList.remove('hidden');
    previewErrors.textContent = '当前没有可导出的评分结果。';
    return;
  }

  const buffer = buildExportBuffer(resultSheetData, ruleRows);
  await saveToFile(buffer, `${state.schema.name}_评分结果.xlsx`);
  await mirrorExportResult(buffer);
});