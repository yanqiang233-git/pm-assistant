export type SchemaId = 'transformer' | 'branch-box' | 'conduit';
export type RuleMode = 'auto' | 'manual';

export interface ColumnDef {
  key: string;
  label: string;
  colIndex: number;
  occurrence: number;
}

export interface MergeRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export interface ImportedRow {
  rowNumber: number;
  values: Record<string, string>;
  rawValues: string[];
}

export interface ImportedWorkbook {
  fileName: string;
  sheetName: string;
  schemaId: SchemaId;
  schemaName: string;
  columns: ColumnDef[];
  rows: ImportedRow[];
  rawMatrix: string[][];
  merges: MergeRange[];
  headerRowCount: number;
  columnCount: number;
}

export interface ConfigField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

export interface RuleScoreResult {
  score: number | null;
  note?: string;
}

export interface RuleHelper {
  sectionName: string;
  getText(label: string): string;
  getNumber(label: string): number | null;
  getBoolean(label: string): boolean | null;
  countTruthy(labels: string[]): number;
  configNumber(key: string): number | null;
}

export interface ScoreRule {
  key: string;
  module: string;
  item: string;
  fields: string[];
  algorithm: string;
  mode: RuleMode;
  min?: number;
  max?: number;
  step?: number;
  sourceFieldKey?: string;
  score?: (helper: RuleHelper) => RuleScoreResult;
}

export interface SchemaDefinition {
  id: SchemaId;
  name: string;
  description: string;
  configFields: ConfigField[];
  rules: ScoreRule[];
}

export interface ScoredCell {
  ruleKey: string;
  mode: RuleMode;
  score: number | null;
  note: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface ScoredRow {
  rowId: string;
  rowNumber: number;
  sectionName: string;
  supplierName: string;
  socialCreditCode: string;
  cells: Record<string, ScoredCell>;
  autoTotal: number;
  currentTotal: number;
}

export interface PreviewMetrics {
  rowCount: number;
  autoRuleCount: number;
  manualRuleCount: number;
  pendingAutoCells: number;
  filledManualCells: number;
}

export interface ExportSheetData {
  sheetName: string;
  matrix: Array<Array<string | number>>;
  merges: MergeRange[];
  scoreColumnIndexes: number[];
}