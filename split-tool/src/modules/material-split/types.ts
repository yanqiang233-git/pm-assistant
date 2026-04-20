/** 预分配行分包名称正则：严格匹配 "包N" */
export const PKG_NAME_PATTERN = /^包(\d+)$/;

/** 40 个必须字段 */
export const REQUIRED_FIELDS = [
  'No.', '采购申请id', '批次计划编号', '总部采购申请号', '网省采购申请号',
  '分标名称', '分包名称', '分包编号', '项目单位', '工程项目编号',
  '工程项目名称', '工程电压等级', '物料编码', '物资大类', '物资中类',
  '物资小类', '物资名称', '物资描述', '计量单位', '数量',
  '估算单价（元）', '估算总价（元）', '首次交货时间', '最后一批交货时间',
  '交货地点', '交货方式', '联系人', '联系信息', '是否标准物料', '备注',
  '采购申请状态', '提交状态', '采购申请退回类型', '技术规范ID',
  '技术规范状态', '技术规范锁定状态', '需求单位名称', '特殊采购方式',
  '扩展编码', '扩展描述'
] as const;

/** 原始行数据 —— key 是字段名 */
export type ExcelRow = Record<string, unknown>;

/** 拆分方式 */
export type SplitMethod = 'average' | 'ratio' | 'fixedAmount';

/** 比例模板 */
export interface RatioTemplate {
  id: string;
  name: string;
  packageCount: number;
  /** 百分比列表，总和 = 10000（万分比，整数） */
  ratios: number[];
  isDefault: boolean;
}

/** 单个分标的配置 */
export interface FenbiaoConfig {
  /** 分标名称 */
  name: string;
  /** 分包数量 */
  packageCount: number;
  /** 拆分方式 */
  splitMethod: SplitMethod;
  /** 是否单独覆盖了全局拆分方式 */
  overridden: boolean;
  /** 关联的模板 id（比例模式时） */
  templateId?: string;
  /** 指定的每包金额（精确十进制字符串）（指定金额模式时） */
  fixedAmounts?: string[];
}

/** 校验错误 */
export interface ValidationError {
  type: 'missing_fields' | 'already_packed' | 'pre_alloc_invalid' | 'duplicate_申请号' | 'invalid_number';
  message: string;
  details?: string[];
}

/** 导入结果 */
export interface ImportResult {
  success: boolean;
  fileName: string;
  rows: ExcelRow[];
  headers: string[];
  headerOrder: string[];
  fenbiaoNames: string[];
  totalRows: number;
  preAllocatedCount: number;
  exactFenbiaoAmountTotals: Record<string, string>;
  errors: ValidationError[];
}

/** 粘贴解析结果 */
export interface PasteResult {
  totalParsed: number;
  successCount: number;
  failCount: number;
  unmatchedNames?: string[];
  duplicateNames?: string[];
  emptyNames?: number;
  invalidValues?: { line: number; value: string }[];
  rowDiff?: number;
}

/** 拆分后的行 */
export type SplitRow = ExcelRow;

/** 预览摘要 */
export interface PreviewSummary {
  originalRows: number;
  splitRows: number;
  totalFenbiao: number;
  totalPackages: number;
  fenbiaoDetails: {
    name: string;
    originalRows: number;
    packageCount: number;
    splitRows: number;
    totalAmount: string;
  }[];
}

/** 应用全局状态 */
export interface AppState {
  /** 导入阶段 */
  importResult: ImportResult | null;
  /** 分标配置列表（按名称升序） */
  fenbiaoConfigs: FenbiaoConfig[];
  /** 全局默认拆分方式 */
  globalSplitMethod: SplitMethod;
  /** 拆分结果 */
  splitResult: SplitRow[] | null;
  /** 预览摘要 */
  previewSummary: PreviewSummary | null;
}
