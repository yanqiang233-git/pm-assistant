import type {
  ConfigField,
  ImportedRow,
  ImportedWorkbook,
  PreviewMetrics,
  RuleHelper,
  RuleScoreResult,
  ScoredCell,
  ScoredRow,
  SchemaDefinition,
  SchemaId,
  ScoreRule
} from './types';

function normalizeValue(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSectionName(value: string): string {
  return value.replace(/\s+/g, '');
}

function isHighVoltageBranchBox(sectionName: string): boolean {
  const normalized = normalizeSectionName(sectionName);
  return normalized.includes('高压电缆分支箱')
    || (normalized.includes('高压') && normalized.includes('电缆分支箱'));
}

function isLowVoltageBranchBox(sectionName: string): boolean {
  const normalized = normalizeSectionName(sectionName);
  return normalized.includes('低压电缆分支箱')
    || (normalized.includes('低压') && normalized.includes('电缆分支箱'));
}

function parseNumber(value: string): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, '').replace(/%/g, '').trim();
  if (!normalized || normalized === '/' || normalized === '-') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: string): boolean | null {
  const normalized = normalizeValue(value);
  if (!normalized) return null;
  if (['是', '有', 'true', '1', '已建立', '通过', 'yes'].includes(normalized)) return true;
  if (['否', '无', 'false', '0', '未建立', '未通过', 'no'].includes(normalized)) return false;
  return null;
}

function parseDateValue(value: string): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw || raw === '/' || raw === '-') return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial > 0) {
      const utcDays = Math.floor(serial - 25569);
      const utcValue = utcDays * 86400 * 1000;
      const date = new Date(utcValue);
      return Number.isNaN(date.getTime()) ? null : date;
    }
  }

  const normalized = raw
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/[./]/g, '-')
    .replace(/\s+/g, '');
  const match = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isCertificateValidOnOrAfter(helper: RuleHelper, dateLabels: string[], fallbackLabels: string[] = [], threshold = new Date(2026, 4, 19)): boolean {
  for (const label of dateLabels) {
    const date = parseDateValue(helper.getText(label));
    if (date && date >= threshold) return true;
  }
  return fallbackLabels.some((label) => helper.getBoolean(label) === true);
}
function hasCertificateDateOrFallback(helper: RuleHelper, dateLabels: string[], fallbackLabels: string[] = []): boolean {
  for (const label of dateLabels) {
    if (parseDateValue(helper.getText(label))) return true;
  }
  return fallbackLabels.some((label) => {
    const boolValue = helper.getBoolean(label);
    if (boolValue === true) return true;
    return boolValue === null && helper.getText(label).trim().length > 0;
  });
}

function sumNumbers(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function compareAgainstLowerIsBetter(actual: number | null, standard: number | null, thresholds: Array<{ ratio: number; score: number }>): RuleScoreResult {
  if (actual == null) return { score: null, note: '缺少参数值' };
  if (standard == null || standard <= 0) return { score: null, note: '缺少采购标准值' };
  const improvement = (standard - actual) / standard;
  for (const threshold of thresholds) {
    if (improvement >= threshold.ratio) {
      return { score: threshold.score, note: `优于标准值 ${(threshold.ratio * 100).toFixed(0)}%` };
    }
  }
  return { score: 0, note: '未达到最低档阈值' };
}

function performanceRule(base: number, sourceFieldKey = '既有业绩汇总'): ScoreRule {
  return {
    key: 'performance',
    module: '业绩水平',
    item: '供货业绩',
    fields: [sourceFieldKey],
    sourceFieldKey,
    algorithm: `达到基准值 ${base} 得 10 分；1.5 倍得 13 分；2 倍得 16 分；3 倍得 19 分；低于基准值记 0 分。`,
    mode: 'auto',
    score: (helper) => {
      const actual = helper.getNumber(sourceFieldKey)
        ?? helper.getNumber('既有业绩汇总')
        ?? helper.getNumber('既有业绩汇总(2022-2024）单位：台')
        ?? helper.getNumber('2022年～2024年既有业绩(台)')
        ?? helper.getNumber('2022年～2024年既有业绩(米)');
      if (actual == null) return { score: null, note: '缺少业绩数据' };
      if (actual >= base * 3) return { score: 19 };
      if (actual >= base * 2) return { score: 16 };
      if (actual >= base * 1.5) return { score: 13 };
      if (actual >= base) return { score: 10 };
      return { score: 0 };
    }
  };
}

function transformerInnovationStandardRule(): ScoreRule {
  return {
    key: 'innovation-standard',
    module: '资源实力',
    item: '创新能力-标准',
    fields: ['企业参与制定与投标产品相关的行业及以上标准数量', '企业参与制定与投标产品相关的团标标准数量', '企业参与制定与投标产品相关的企标标准数量'],
    algorithm: '行业及以上数量大于 0 得 4 分；否则若团标或企标数量大于 0 得 2 分；否则 0 分。',
    mode: 'auto',
    sourceFieldKey: '【后加】标准总和',
    score: (helper) => {
      const industry = helper.getNumber('行业及以上标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的行业及以上标准数量') ?? 0;
      const group = helper.getNumber('团标标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的团标标准数量') ?? 0;
      const enterprise = helper.getNumber('企标标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的企标标准数量') ?? 0;
      if (industry > 0) return { score: 4 };
      if (group > 0 || enterprise > 0) return { score: 2 };
      return { score: 0 };
    }
  };
}

function humanResourceRule(key: string, fields: string[]): ScoreRule {
  return {
    key,
    module: '资源实力',
    item: '人力资源',
    fields,
    algorithm: '正高级工程师 2 人以上或高级工程师（含高级技师）4 人以上得 2 分；高级工程师（含高级技师）2 人以上得 1 分；否则 0 分。',
    mode: 'auto',
    score: (helper) => {
      const total = helper.getNumber(fields[0]) ?? 0;
      if (total >= 4) return { score: 2 };
      if (total >= 2) return { score: 1 };
      return { score: 0 };
    }
  };
}

function researchTeamRule(key: string, fields: string[]): ScoreRule {
  return {
    key,
    module: '高质量发展评价',
    item: '研发团队规模',
    fields,
    algorithm: '人数大于等于 20 得 10 分；5-19 得 8 分；小于 5 得 6 分。',
    mode: 'auto',
    score: (helper) => {
      const total = helper.getNumber(fields[0]) ?? 0;
      if (total >= 20) return { score: 10 };
      if (total >= 5) return { score: 8 };
      return { score: 6 };
    }
  };
}

function transformerHumanResourceRule(): ScoreRule {
  const fields = ['人员情况-高级及以上职称人员和高级技师人员数量', '高级及以上职称人员和高级技师人员数量'];
  return {
    ...humanResourceRule('transformer-human-resource', fields),
    sourceFieldKey: '仅有商务部分阅标记录里有相关内容'
  };
}

function transformerResearchTeamRule(): ScoreRule {
  const fields = ['人员情况-高级及以上职称人员和高级技师人员数量', '高级及以上职称人员和高级技师人员数量'];
  return {
    ...researchTeamRule('transformer-research-team', fields),
    sourceFieldKey: '人员情况-高级及以上职称人员和高级技师人员数量',
    score: (helper) => {
      const total = helper.getNumber(fields[0]) ?? helper.getNumber(fields[1]) ?? 0;
      if (total >= 20) return { score: 10 };
      if (total >= 5) return { score: 8 };
      return { score: 6 };
    }
  };
}

function productCarbonRule(key: string, field: string): ScoreRule {
  return {
    key,
    module: '绿色制造',
    item: '产品碳足迹证书',
    fields: [field],
    algorithm: '有得 1 分；无得 0 分。',
    mode: 'auto',
    score: (helper) => ({ score: helper.getBoolean(field) ? 1 : 0 })
  };
}

function aftersalesRule(key: string, field: string): ScoreRule {
  return {
    key,
    module: '履约能力评价',
    item: '售后服务',
    fields: [field],
    algorithm: '大于等于 20 得 5 分；10-19 得 3 分；小于 10 得 1 分。',
    mode: 'auto',
    score: (helper) => {
      const count = helper.getNumber(field);
      if (count == null) return { score: null, note: '缺少售后服务网点数据' };
      if (count >= 20) return { score: 5 };
      if (count >= 10) return { score: 3 };
      return { score: 1 };
    }
  };
}

function highTechRule(key: string, field: string): ScoreRule {
  return {
    key,
    module: '高质量发展评价',
    item: '高新技术企业',
    fields: [field],
    algorithm: '取得 1 项及以上得 4 分；未取得得 0 分。',
    mode: 'auto',
    score: (helper) => ({ score: helper.getBoolean(field) ? 4 : 0 })
  };
}

function nationalQualityAwardRule(key: string, field: string): ScoreRule {
  return {
    key,
    module: '高质量发展评价',
    item: '中国质量奖',
    fields: [field],
    algorithm: '获得国家级质量奖得 3 分；未获得得 0 分。',
    mode: 'auto',
    score: (helper) => ({ score: helper.getBoolean(field) ? 3 : 0 })
  };
}

function specializedRule(key: string, fields: string[]): ScoreRule {
  return {
    key,
    module: '高质量发展评价',
    item: '专精特新认定',
    fields,
    algorithm: '被国家或地方政府部门认定为专精特新企业得 2 分；未获得得 0 分。',
    mode: 'auto',
    score: (helper) => ({ score: fields.some((field) => helper.getBoolean(field)) ? 2 : 0 })
  };
}

function buildRuleHelper(row: ImportedRow, workbook: ImportedWorkbook, configValues: Record<string, string>): RuleHelper {
  const columns = workbook.columns;
  const findKey = (label: string): string | null => {
    const exact = columns.find((column) => column.key === label || column.label === label);
    if (exact) return exact.key;
    const fuzzy = columns.find((column) => column.label.includes(label) || label.includes(column.label));
    return fuzzy ? fuzzy.key : null;
  };

  return {
    sectionName: row.values[findKey('预审标段') || '预审标段'] || '',
    getText(label: string) {
      const key = findKey(label);
      return key ? (row.values[key] || '') : '';
    },
    getNumber(label: string) {
      return parseNumber(this.getText(label));
    },
    getBoolean(label: string) {
      return parseBoolean(this.getText(label));
    },
    countTruthy(labels: string[]) {
      return labels.reduce((count, label) => count + (this.getBoolean(label) ? 1 : 0), 0);
    },
    configNumber(key: string) {
      return parseNumber(configValues[key] || '');
    }
  };
}

function getSectionBase(sectionName: string): number {
  if (isHighVoltageBranchBox(sectionName)) return 80;
  if (isLowVoltageBranchBox(sectionName)) return 1000;
  return 1000;
}

const transformerConfigFields: ConfigField[] = [
  { key: 'transformerLoadLossStd', label: '采购标准值-配变负载损耗（kW）', required: true },
  { key: 'transformerNoLoadLossStd', label: '采购标准值-空载损耗（kW）', required: true },
  { key: 'transformerOilTempStd', label: '采购标准值-顶层油温（油浸）', required: true },
  { key: 'transformerWindingTempStd', label: '采购标准值-绕组温升（干式）', required: true },
  { key: 'transformerNoiseStd', label: '采购标准值-噪声水平（dB）', required: true }
];

function standardScoreRules(): ScoreRule[] {
  return [
    {
      key: 'innovation-standard',
      module: '资源实力',
      item: '创新能力-标准',
      fields: ['企业参与制定与投标产品相关的行业及以上标准数量', '企业参与制定与投标产品相关的团标标准数量', '企业参与制定与投标产品相关的企标标准数量'],
      algorithm: '行业及以上标准优先得高分，取最高分，不叠加。',
      mode: 'auto',
      sourceFieldKey: '【后加】标准总和',
      score: (helper) => {
        if ((helper.getNumber('行业及以上标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的行业及以上标准数量') ?? 0) > 0) return { score: 4 };
        const groupScore = Math.max(
          (helper.getNumber('团标标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的团标标准数量') ?? 0) > 0 ? 3 : 0,
          (helper.getNumber('企标标准数量') ?? helper.getNumber('企业参与制定与投标产品相关的企标标准数量') ?? 0) > 0 ? 1 : 0
        );
        return { score: groupScore };
      }
    },
    {
      key: 'patent',
      module: '资源实力',
      item: '发明专利',
      fields: ['与投标产品相关的发明专利（个）', '企业具有类似投标产品的发明专利数量'],
      algorithm: '4/3/2/1/0 分档。',
      mode: 'auto',
      score: (helper) => {
        const count = helper.getNumber('与投标产品相关的发明专利（个）') ?? helper.getNumber('企业具有类似投标产品的发明专利数量') ?? 0;
        if (count >= 4) return { score: 4 };
        if (count >= 3) return { score: 3 };
        if (count >= 2) return { score: 2 };
        if (count >= 1) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'award',
      module: '资源实力',
      item: '科技奖励',
      fields: ['国家级科技奖励', '省部级科技奖励', '其他科技奖励'],
      algorithm: '按最高等级奖励取分，不叠加。',
      mode: 'auto',
      score: (helper) => {
        const national = helper.getNumber('国家级科技奖励') ?? 0;
        const provincial = helper.getNumber('省部级科技奖励') ?? helper.getNumber('省部级及以上科技奖励数量') ?? 0;
        const other = helper.getNumber('其他科技奖励') ?? helper.getNumber('其他科技奖励数量') ?? 0;
        if (national > 0) return { score: 4 };
        if (provincial > 0) return { score: helper.sectionName.includes('电缆分支箱') || helper.sectionName.includes('电缆保护管') ? 2 : 4 };
        if (other > 0) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'green-low-carbon',
      module: '绿色制造',
      item: '绿色低碳生产及绿色回收',
      fields: ['国家级绿色工厂（是/否）', '国家级绿色供应链管理企业（是/否）', '绿色生产和绿色回收制（主观项得分）'],
      algorithm: '2 项认证=3 分；1 项=2 分；制度人工确认=1 分；默认未确认时不取 1 分。',
      mode: 'auto',
      sourceFieldKey: '绿色生产和绿色回收制（主观项得分）',
      score: (helper) => {
        const count = helper.countTruthy(['国家级绿色工厂（是/否）', '国家级绿色供应链管理企业（是/否）']);
        if (count >= 2) return { score: 3 };
        if (count === 1) return { score: 2 };
        const manual = helper.getNumber('绿色生产和绿色回收制（主观项得分）');
        if ((manual ?? 0) > 0) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'green-management-planning',
      module: '高质量发展评价',
      item: '绿色发展规划制度',
      fields: ['绿色发展规划制度', '投标人补充：绿色发展规划制度'],
      algorithm: '建立绿色发展规划制度得 1 分；无得 0 分。',
      mode: 'auto',
      sourceFieldKey: '投标人补充：绿色发展规划制度',
      score: (helper) => ({
        score: helper.getBoolean('绿色发展规划制度') || helper.getBoolean('投标人补充：绿色发展规划制度') ? 1 : 0
      })
    },
    {
      key: 'green-management-energy',
      module: '高质量发展评价',
      item: '能源管理体系认证证书',
      fields: ['能源管理体系证书', '能源管理体系认证证书', '国家级能源管理体系认证证书-有效期至', '能源管理体系认证证书-有效期至', '能源管理体系证书-有效期至', '绿色体系认证-国家级能源管理体系认证证书（有/无）'],
      algorithm: '能源管理体系证书相关字段中有有效日期即视为有证书，得 2 分，否则 0 分。',
      mode: 'auto',
      sourceFieldKey: '国家级能源管理体系认证证书-有效期至',
      score: (helper) => ({
        score: hasCertificateDateOrFallback(
          helper,
          ['国家级能源管理体系认证证书-有效期至', '能源管理体系认证证书-有效期至', '能源管理体系证书-有效期至'],
          ['绿色体系认证-国家级能源管理体系认证证书（有/无）', '能源管理体系认证证书', '能源管理体系证书']
        ) ? 2 : 0
      })
    },
    {
      key: 'green-management-systems',
      module: '高质量发展评价',
      item: '质量/职业健康安全/环境管理体系认证证书',
      fields: ['质量管理体系认证证书', '质量管理体系认证证书-有效期至', '绿色体系认证-质量管理体系认证证书（有/无）', '职业健康安全管理体系认证证书', '职业健康安全管理体系认证证书-有效期至', '绿色体系认证-职业健康安全管理体系认证证书（有/无）', '环境管理体系认证证书', '环境管理体系认证证书-有效期至', '绿色体系认证-环境管理体系认证证书（有/无）'],
      algorithm: '三体系各字段中有有效日期即视为有该项证书，按证书数量取 3/2/1/0 分。',
      mode: 'auto',
      sourceFieldKey: '职业健康安全管理体系认证证书-有效期至',
      score: (helper) => {
        const qualityCount = [
          hasCertificateDateOrFallback(
            helper,
            ['质量管理体系认证证书-有效期至'],
            ['绿色体系认证-质量管理体系认证证书（有/无）', '质量管理体系认证证书']
          ),
          hasCertificateDateOrFallback(
            helper,
            ['职业健康安全管理体系认证证书-有效期至'],
            ['绿色体系认证-职业健康安全管理体系认证证书（有/无）', '职业健康安全管理体系认证证书']
          ),
          hasCertificateDateOrFallback(
            helper,
            ['环境管理体系认证证书-有效期至'],
            ['绿色体系认证-环境管理体系认证证书（有/无）', '环境管理体系认证证书']
          )
        ].filter(Boolean).length;
        return { score: qualityCount >= 3 ? 3 : qualityCount === 2 ? 2 : qualityCount === 1 ? 1 : 0 };
      }
    },
    {
      key: 'environment-impact',
      module: '高质量发展评价',
      item: '环境影响评价',
      fields: ['ESG 报告', '环评/能评报告', '废水/废气/废固报告', '企业发布ESG（环境、社会和公司治理）报告（有/无）', '环境影响评价-ESG（环境、社会和公司治理）报告（有/无）', '环评/能评报告（有/无）', '环境影响评价-环评或能评报告（有/无）', '废水/废气/废固监（检）测报告（有/无）', '环境影响评价-废水、废气或废固报告（有/无）'],
      algorithm: '三类都有 5 分；一至两类 3 分；没有 0 分。',
      mode: 'auto',
      sourceFieldKey: '废水/废气/废固监（检）测报告（有/无）',
      score: (helper) => {
        const count = [
          helper.getBoolean('企业发布ESG（环境、社会和公司治理）报告（有/无）') || helper.getBoolean('环境影响评价-ESG（环境、社会和公司治理）报告（有/无）'),
          helper.getBoolean('环评/能评报告（有/无）') || helper.getBoolean('环境影响评价-环评或能评报告（有/无）'),
          helper.getBoolean('废水/废气/废固监（检）测报告（有/无）') || helper.getBoolean('环境影响评价-废水、废气或废固报告（有/无）')
        ].filter(Boolean).length;
        if (count >= 3) return { score: 5 };
        if (count >= 1) return { score: 3 };
        return { score: 0 };
      }
    },
    {
      key: 'green-power',
      module: '高质量发展评价',
      item: '绿电绿证',
      fields: ['绿色电力证书'],
      algorithm: '绿色电力证书有 5 分，无 0 分。',
      mode: 'auto',
      score: (helper) => ({ score: helper.getBoolean('绿色电力证书') ? 5 : 0 })
    },
    {
      key: 'innovation-achievement',
      module: '高质量发展评价',
      item: '企业创新成果',
      fields: ['国家级科技创新成果', '省级科技创新成果', '近3年科技创新成果数量（国家级）', '近3年科技创新成果数量（省部级）', '近3年科技创新成果数量（其他）'],
      algorithm: '国家级 8 分；省级 6 分；其他 4 分。',
      mode: 'auto',
      score: (helper) => {
        const national = helper.getNumber('国家级科技创新成果') ?? helper.getNumber('近3年科技创新成果数量（国家级）') ?? 0;
        const provincial = helper.getNumber('省级科技创新成果') ?? helper.getNumber('近3年科技创新成果数量（省部级）') ?? 0;
        if (national > 0) return { score: 8 };
        if (provincial > 0) return { score: 6 };
        return { score: 4 };
      }
    },
    {
      key: 'digital',
      module: '高质量发展评价',
      item: '数智化评价',
      fields: ['数智化认定项数量', '“数字领航”企业（是/否）', '智能制造示范工厂（是/否）', '智能制造优秀场景（是/否）', '智能工厂（是/否）', '数字化车间（是/否）', '卓越级智能工厂（是/否）'],
      algorithm: '3 项及以上 5 分；1-2 项 3 分；0 项 0 分。',
      mode: 'auto',
      score: (helper) => {
        const count = helper.getNumber('数智化认定项数量') ?? helper.countTruthy([
          '“数字领航”企业（是/否）',
          '智能制造示范工厂（是/否）',
          '智能制造优秀场景（是/否）',
          '智能工厂（是/否）',
          '数字化车间（是/否）',
          '卓越级智能工厂（是/否）'
        ]);
        if (count >= 3) return { score: 5 };
        if (count >= 1) return { score: 3 };
        return { score: 0 };
      }
    }
  ];
}

const transformerSchema: SchemaDefinition = {
  id: 'transformer',
  name: '10kV箱变-欧式-硅钢片',
  description: '包含采购标准值比较项与若干高质量发展评价项。',
  configFields: transformerConfigFields,
  rules: [
    performanceRule(150, '既有业绩汇总(2022-2024）单位：台'),
    transformerInnovationStandardRule(),
    ...standardScoreRules().slice(1, 3),
    {
      key: 'transformer-load-loss',
      module: '资源实力',
      item: '关键技术参数-配变负载损耗',
      fields: ['关键技术参数1-配变负载损耗（kW）', '采购标准值-配变负载损耗（kW）'],
      algorithm: '优于标准值超过 10% 得 4 分；5%-10%（含）得 2 分；不到 5%（含）得 1 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => compareAgainstLowerIsBetter(helper.getNumber('关键技术参数1-配变负载损耗（kW）'), helper.configNumber('transformerLoadLossStd'), [
        { ratio: 0.10, score: 4 },
        { ratio: 0.05, score: 2 },
        { ratio: 0.000001, score: 1 }
      ])
    },
    {
      key: 'transformer-no-load-loss',
      module: '资源实力',
      item: '关键技术参数-空载损耗',
      fields: ['关键技术参数2-空载损耗（kW）', '采购标准值-空载损耗（kW）'],
      algorithm: '优于标准值超过 20% 得 4 分；10%-20%（含）得 2 分；不到 10%（含）得 1 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => compareAgainstLowerIsBetter(helper.getNumber('关键技术参数2-空载损耗（kW）'), helper.configNumber('transformerNoLoadLossStd'), [
        { ratio: 0.20, score: 4 },
        { ratio: 0.10, score: 2 },
        { ratio: 0.000001, score: 1 }
      ])
    },
    {
      key: 'transformer-temperature',
      module: '资源实力',
      item: '关键技术参数-温升',
      fields: ['关键技术参数3-顶层油温（油浸变压器）', '关键技术参数4-绕组温升（干式变压器）'],
      algorithm: '油浸按顶层油温，干式按绕组温升；优于标准值 15%（含）得 4 分；优于不到 15% 得 2 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => {
        const oil = helper.getNumber('关键技术参数3-顶层油温（油浸变压器）');
        if (oil != null) {
          return compareAgainstLowerIsBetter(oil, helper.configNumber('transformerOilTempStd'), [
            { ratio: 0.15, score: 4 },
            { ratio: 0.000001, score: 2 }
          ]);
        }
        const winding = helper.getNumber('关键技术参数4-绕组温升（干式变压器）');
        return compareAgainstLowerIsBetter(winding, helper.configNumber('transformerWindingTempStd'), [
          { ratio: 0.15, score: 4 },
          { ratio: 0.000001, score: 2 }
        ]);
      }
    },
    {
      key: 'transformer-noise',
      module: '资源实力',
      item: '关键技术参数-噪声水平',
      fields: ['关键技术参数5-噪声水平（dB）', '采购标准值-噪声水平（dB）'],
      algorithm: '优于标准值 12dB（含）以上得 4 分；8-12dB（含）得 2 分；不到 8dB 得 1 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => compareAgainstLowerIsBetter(helper.getNumber('关键技术参数5-噪声水平（dB）'), helper.configNumber('transformerNoiseStd'), [
        { ratio: 12 / Math.max(helper.configNumber('transformerNoiseStd') || 1, 1), score: 4 },
        { ratio: 8 / Math.max(helper.configNumber('transformerNoiseStd') || 1, 1), score: 2 },
        { ratio: 0.000001, score: 1 }
      ])
    },
    {
      key: 'transformer-production-total',
      module: '资源实力',
      item: '生产试验设备-工装设备总数',
      fields: ['主要生产设备1-母线加工机数量', '主要生产设备2-起重设备数量', '主要生产设备3-剪板机数量', '主要生产设备4-折弯机数量', '主要生产设备5-真空滤油/注油设备数量', '主要生产设备6-真空浇注设备数量', '主要生产设备7-绕线机数量', '主要生产设备8-干燥设备数量'],
      algorithm: '设备总数大于等于 30 得 3 分；15-29 得 2 分；其余 1 分。',
      mode: 'auto',
      score: (helper) => {
        const total = sumNumbers([
          helper.getNumber('主要生产设备1-母线加工机数量'),
          helper.getNumber('主要生产设备2-起重设备数量'),
          helper.getNumber('主要生产设备3-剪板机数量'),
          helper.getNumber('主要生产设备4-折弯机数量'),
          helper.getNumber('主要生产设备5-真空滤油/注油设备数量'),
          helper.getNumber('主要生产设备6-真空浇注设备数量'),
          helper.getNumber('主要生产设备7-绕线机数量'),
          helper.getNumber('主要生产设备8-干燥设备数量')
        ]);
        if (total >= 30) return { score: 3 };
        if (total >= 15) return { score: 2 };
        return { score: 1 };
      }
    },
    {
      key: 'transformer-test-total',
      module: '资源实力',
      item: '生产试验设备-试验设备总数',
      fields: ['主要试验设备1-主回路绝缘试验设备数量', '主要试验设备2-二次回路工频耐压设备数量', '主要试验设备3-接地电阻测试仪数量'],
      algorithm: '设备总数大于等于 7 得 3 分；5-6 得 2 分；其余 1 分。',
      mode: 'auto',
      score: (helper) => {
        const total = sumNumbers([
          helper.getNumber('主要试验设备1-主回路绝缘试验设备数量'),
          helper.getNumber('主要试验设备2-二次回路工频耐压设备数量'),
          helper.getNumber('主要试验设备3-接地电阻测试仪数量')
        ]);
        if (total >= 7) return { score: 3 };
        if (total >= 5) return { score: 2 };
        return { score: 1 };
      }
    },
    {
      key: 'transformer-environment',
      module: '资源实力',
      item: '环境',
      fields: ['生产厂房-厂房总面积（平方米）', '封闭厂房数量', '净化车间数量'],
      algorithm: '封闭厂房与净化车间都具备且面积超 60000 得 6 分；面积 12000-60000 得 4 分；其余情况 1 分。',
      mode: 'auto',
      score: (helper) => {
        const area = helper.getNumber('生产厂房-厂房总面积（平方米）') ?? 0;
        const enclosed = helper.getNumber('封闭厂房数量') ?? 0;
        const clean = helper.getNumber('净化车间数量') ?? 0;
        if (enclosed > 0 && clean > 0 && area > 60000) return { score: 6 };
        if (enclosed > 0 && clean > 0 && area >= 12000) return { score: 4 };
        return { score: 1 };
      }
    },
    ...standardScoreRules().slice(3),
    productCarbonRule('transformer-product-carbon', '产品碳足迹证书'),
    aftersalesRule('transformer-aftersales', '售后服务网点数量'),
    highTechRule('transformer-high-tech', '高新技术企业证书（有/无）'),
    nationalQualityAwardRule('transformer-national-quality-award', '国家级质量奖（有/无）'),
    specializedRule('transformer-specialized', ['国家或地方政府部门认定为专精特新企业（是/否）', '专精特新认定（有/无）']),
    {
      key: 'transformer-research-expense',
      module: '高质量发展评价',
      item: '科研经费占比',
      fields: ['2024年度审计报告-研发费占比（%）', '2023年度审计报告-研发费占比（%）', '2022年度审计报告-研发费占比（%）'],
      algorithm: '三年中任一字段超过 2% 得 16 分；任一字段大于 0 得 14 分；否则 12 分。',
      mode: 'auto',
      score: (helper) => {
        const values = [
          helper.getNumber('2024年度审计报告-研发费占比（%）'),
          helper.getNumber('2023年度审计报告-研发费占比（%）'),
          helper.getNumber('2022年度审计报告-研发费占比（%）')
        ];
        if (values.some((value) => (value ?? 0) > 2)) return { score: 16 };
        if (values.some((value) => (value ?? 0) > 0)) return { score: 14 };
        return { score: 12 };
      }
    },
    {
      key: 'transformer-entity-response',
      module: '高质量发展评价',
      item: '实体清单应对举措',
      fields: ['应对国际贸易壁垒举措', '财政补贴批文', '税收优惠证明', '政府融资支持证明材料'],
      algorithm: '4 列中“有”的项数为 2 得 2 分；为 1 得 1 分；为 0 得 0 分。',
      mode: 'auto',
      score: (helper) => {
        const count = helper.countTruthy(['应对国际贸易壁垒举措', '财政补贴批文', '税收优惠证明', '政府融资支持证明材料']);
        if (count >= 2) return { score: 2 };
        if (count === 1) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'transformer-manual-process',
      module: '资源实力',
      item: '主观项：设备工艺优化改进',
      fields: ['主观项得分'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 3,
      step: 1,
      sourceFieldKey: '主观项得分'
    },
    {
      ...transformerHumanResourceRule()
    },
    {
      ...transformerResearchTeamRule()
    },
    {
      key: 'transformer-manual-quality-control',
      module: '质量控制',
      item: '主观项：产品制造质量控制',
      fields: ['主观项得分#2'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 5,
      step: 1,
      sourceFieldKey: '主观项得分#2'
    },
    {
      key: 'transformer-manual-fulfillment-risk',
      module: '质量控制',
      item: '履约风险',
      fields: ['人工录入'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 2,
      step: 1
    },
    {
      key: 'transformer-manual-performance',
      module: '绩效评价',
      item: '运行绩效/综合绩效/诚信评价合计',
      fields: ['人工录入'],
      algorithm: '人工录入当前可确认分值。',
      mode: 'manual',
      min: -115,
      max: 30,
      step: 0.5
    }
  ]
};

const branchBoxSchema: SchemaDefinition = {
  id: 'branch-box',
  name: '低压/高压电缆分支箱',
  description: '按预审标段区分高压与低压分支箱规则。',
  configFields: [],
  rules: [
    {
      ...performanceRule(1000, '2022年～2024年既有业绩(台)'),
      score: (helper) => performanceRule(getSectionBase(helper.sectionName), '2022年～2024年既有业绩(台)').score!(helper)
    },
    ...standardScoreRules().slice(0, 3),
    {
      key: 'branch-terminal-temp',
      module: '资源实力',
      item: '关键技术参数-端子温升',
      fields: ['用螺栓或螺钉与外部导体连接（用于连接外部绝缘导体）的端子温升'],
      algorithm: '≤40 得 5 分；40-50 得 3 分；50-65 得 1 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => {
        const value = helper.getNumber('端子温升');
        if (value == null) return { score: null, note: '缺少参数值' };
        if (value <= 40) return { score: 5 };
        if (value <= 50) return { score: 3 };
        if (value <= 65) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'branch-handle-temp',
      module: '资源实力',
      item: '关键技术参数-操作手柄温升',
      fields: ['预审标段', '400V分支箱：金属外壳操作手柄温升', '400V分支箱：绝缘材料操作手柄温升'],
      algorithm: '高压电缆分支箱固定 4 分；低压电缆分支箱（塑壳断路器）按两列分别算分后取高分。',
      mode: 'auto',
      score: (helper) => {
        const currentSectionName = helper.getText('预审标段') || helper.sectionName;
        if (isHighVoltageBranchBox(currentSectionName)) return { score: 4 };
        const metal = helper.getNumber('金属外壳操作手柄温升');
        const insulation = helper.getNumber('绝缘材料操作手柄温升');
        const metalScore = metal == null ? 0 : metal <= 10 ? 4 : metal <= 15 ? 1 : 0;
        const insulationScore = insulation == null ? 0 : insulation <= 12 ? 4 : insulation <= 25 ? 1 : 0;
        return { score: Math.max(metalScore, insulationScore) };
      }
    },
    {
      key: 'branch-shell-temp',
      module: '资源实力',
      item: '关键技术参数-外壳温升',
      fields: ['外壳温升'],
      algorithm: '≤12 得 3 分；12-30 得 1 分；否则 0 分。',
      mode: 'auto',
      score: (helper) => {
        const value = helper.getNumber('外壳温升');
        if (value == null) return { score: null, note: '缺少参数值' };
        if (value <= 12) return { score: 3 };
        if (value <= 30) return { score: 1 };
        return { score: 0 };
      }
    },
    {
      key: 'branch-bending',
      module: '资源实力',
      item: '生产试验设备-折弯机',
      fields: ['弯折冲剪切压钻等主要设数量（套）'],
      algorithm: '≥6 得 2 分，否则 1 分。',
      mode: 'auto',
      sourceFieldKey: '弯折冲剪切压钻等主要设数量（套）',
      score: (helper) => ({ score: (helper.getNumber('弯折冲剪切压钻等主要设数量（套）') ?? 0) >= 6 ? 2 : 1 })
    },
    {
      key: 'branch-busbar',
      module: '资源实力',
      item: '生产试验设备-母线加工机',
      fields: ['母线加工机数量（台）'],
      algorithm: '≥2 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('母线加工机数量（台）') ?? 0) >= 2 ? 2 : 1 })
    },
    {
      key: 'branch-weld',
      module: '资源实力',
      item: '生产试验设备-焊机及焊接设备',
      fields: ['焊机及焊接设备数量（台）'],
      algorithm: '≥2 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('焊机及焊接设备数量（台）') ?? 0) >= 2 ? 2 : 1 })
    },
    {
      key: 'branch-transport',
      module: '资源实力',
      item: '生产试验设备-运输起重设备',
      fields: ['运输起重设备（台）'],
      algorithm: '≥3 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('运输起重设备（台）') ?? 0) >= 3 ? 2 : 1 })
    },
    {
      key: 'branch-loop-meter',
      module: '资源实力',
      item: '生产试验设备-回路电阻测试仪',
      fields: ['回路电阻测试仪数量（套）'],
      algorithm: '≥2 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('回路电阻测试仪数量（套）') ?? 0) >= 2 ? 2 : 1 })
    },
    {
      key: 'branch-insulation-meter',
      module: '资源实力',
      item: '生产试验设备-绝缘电阻测试仪',
      fields: ['绝缘电阻测试仪数量（套）'],
      algorithm: '≥2 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('绝缘电阻测试仪数量（套）') ?? 0) >= 2 ? 2 : 1 })
    },
    {
      key: 'branch-composite-car',
      module: '资源实力',
      item: '生产试验设备-高低压综合试验车',
      fields: ['高低压综合试验车数量（套）'],
      algorithm: '≥2 得 2 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('高低压综合试验车数量（套）') ?? 0) >= 2 ? 2 : 1 })
    },
    {
      ...humanResourceRule('branch-human-resource', ['高级及以上职称人员和高级技师人员数量']),
      sourceFieldKey: '高级及以上职称人员和高级技师人员数量'
    },
    {
      ...researchTeamRule('branch-research-team', ['高级及以上职称人员和高级技师人员数量']),
      sourceFieldKey: '高级及以上职称人员和高级技师人员数量#2'
    },
    ...standardScoreRules().slice(3),
    productCarbonRule('branch-product-carbon', '碳足迹证书（有/无）'),
    aftersalesRule('branch-aftersales', '售后服务网点数量'),
    highTechRule('branch-high-tech', '高新技术企业证书（有/无）'),
    nationalQualityAwardRule('branch-national-quality-award', '国家级质量奖（有/无）'),
    specializedRule('branch-specialized', ['专精特新认定（有/无）', '国家或地方政府部门认定为专精特新企业（是/否）']),
    {
      key: 'branch-manual-process',
      module: '资源实力',
      item: '主观项：设备工艺优化改进',
      fields: ['主观项得分'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 3,
      step: 1,
      sourceFieldKey: '主观项得分'
    },
    {
      key: 'branch-manual-quality-control',
      module: '质量控制',
      item: '主观项：产品制造质量控制',
      fields: ['主观项得分#2'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 5,
      step: 1,
      sourceFieldKey: '主观项得分#2'
    },
    {
      key: 'branch-manual-fulfillment-risk',
      module: '质量控制',
      item: '履约风险',
      fields: ['人工录入'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 2,
      step: 1
    },
    {
      key: 'branch-manual-run-performance',
      module: '绩效评价',
      item: '运行绩效',
      fields: ['各省提供'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: 0,
      max: 20,
      step: 0.1,
      sourceFieldKey: '各省提供'
    },
    {
      key: 'branch-manual-composite-performance',
      module: '绩效评价',
      item: '综合绩效',
      fields: ['各省提供#2'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: 0,
      max: 5,
      step: 0.1,
      sourceFieldKey: '各省提供#2'
    },
    {
      key: 'branch-manual-quality-issue',
      module: '质量问题',
      item: '抽检质量问题不合格通报',
      fields: ['各省提供#3'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: -4,
      max: 0,
      step: 0.5,
      sourceFieldKey: '各省提供#3'
    },
    {
      key: 'branch-manual-operation',
      module: '履约能力评价',
      item: '经营状况',
      fields: ['主观项得分#3'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 1,
      max: 3,
      step: 1,
      sourceFieldKey: '主观项得分#3'
    }
  ]
};

const conduitSchema: SchemaDefinition = {
  id: 'conduit',
  name: '电缆保护管 CPVC / MPP',
  description: '按预审标段区分 CPVC 与 MPP 参数规则。',
  configFields: [],
  rules: [
    performanceRule(250000, '2022年～2024年既有业绩(米)'),
    ...standardScoreRules().slice(0, 3),
    {
      key: 'conduit-vicat',
      module: '资源实力',
      item: '关键技术参数-维卡软化温度',
      fields: ['预审标段', '维卡软化温度（摄氏度）'],
      algorithm: 'MPP：>152 得 5 分，150-152 得 2 分，否则 0 分；CPVC：>95 得 5 分，93-95 得 2 分，否则 0 分。',
      mode: 'auto',
      score: (helper) => {
        const value = helper.getNumber('维卡软化温度（摄氏度）');
        if (value == null) return { score: null, note: '缺少参数值' };
        if (helper.sectionName.includes('MPP')) {
          if (value > 152) return { score: 5 };
          if (value >= 150) return { score: 2 };
          return { score: 0 };
        }
        if (value > 95) return { score: 5 };
        if (value >= 93) return { score: 2 };
        return { score: 0 };
      }
    },
    {
      key: 'conduit-impact',
      module: '资源实力',
      item: '关键技术参数-落锤冲击试验',
      fields: ['落锤冲击试验未破坏样品数', '落锤冲击试验样品数'],
      algorithm: '未破坏样品数=10 且样品总数=10 得 3 分，否则 1 分。',
      mode: 'auto',
      score: (helper) => {
        const intact = helper.getNumber('落锤冲击试验未破坏样品数');
        const total = helper.getNumber('落锤冲击试验样品数');
        if (intact == null || total == null) return { score: null, note: '缺少参数值' };
        return { score: intact === 10 && total === 10 ? 3 : 1 };
      }
    },
    {
      key: 'conduit-shrinkage',
      module: '资源实力',
      item: '关键技术参数-纵向回缩率',
      fields: ['预审标段', '纵向回缩率（%）'],
      algorithm: 'MPP 与 CPVC 按预审标段分流。',
      mode: 'auto',
      score: (helper) => {
        const value = helper.getNumber('纵向回缩率（%）');
        if (value == null) return { score: null, note: '缺少参数值' };
        if (helper.sectionName.includes('MPP')) {
          if (value <= 1) return { score: 5 };
          if (value <= 2) return { score: 3 };
          if (value <= 3) return { score: 2 };
          return { score: 0 };
        }
        if (value <= 3) return { score: 5 };
        if (value <= 4) return { score: 3 };
        if (value <= 5) return { score: 2 };
        return { score: 0 };
      }
    },
    {
      key: 'conduit-line',
      module: '资源实力',
      item: '生产试验设备-生产线',
      fields: ['PVC管材生产线（条）', 'MPP/PE生产线（条）'],
      algorithm: '按预审标段选对应字段，≥2 条得 6 分，否则 3 分。',
      mode: 'auto',
      score: (helper) => {
        const value = helper.sectionName.includes('MPP')
          ? helper.getNumber('MPP/PE生产线（条）')
          : helper.getNumber('PVC管材生产线（条）');
        return { score: (value ?? 0) >= 2 ? 6 : 3 };
      }
    },
    {
      key: 'conduit-universal-machine',
      module: '资源实力',
      item: '生产试验设备-微机控制电子万能试验机',
      fields: ['微机控制电子万能试验台（台）'],
      algorithm: '≥2 得 3 分，否则 2 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('微机控制电子万能试验台（台）') ?? 0) >= 2 ? 3 : 2 })
    },
    {
      key: 'conduit-vicat-machine',
      module: '资源实力',
      item: '生产试验设备-维卡软化温度仪',
      fields: ['维卡软化温度仪（台）'],
      algorithm: '≥2 得 3 分，否则 2 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('维卡软化温度仪（台）') ?? 0) >= 2 ? 3 : 2 })
    },
    {
      key: 'conduit-balance',
      module: '资源实力',
      item: '生产试验设备-电子天平或密度测量专用仪器',
      fields: ['电子天平或为密度测量而专门设计的仪器（台）'],
      algorithm: '≥2 得 3 分，否则 2 分。',
      mode: 'auto',
      score: (helper) => ({ score: (helper.getNumber('电子天平或为密度测量而专门设计的仪器（台）') ?? 0) >= 2 ? 3 : 2 })
    },
    {
      ...humanResourceRule('conduit-human-resource', ['高级及以上职称人员和高级技师人员数量']),
      sourceFieldKey: '高级及以上职称人员和高级技师人员数量'
    },
    {
      ...researchTeamRule('conduit-research-team', ['高级及以上职称人员和高级技师人员数量']),
      sourceFieldKey: '高级及以上职称人员和高级技师人员数量#2'
    },
    ...standardScoreRules().slice(3),
    productCarbonRule('conduit-product-carbon', '碳足迹证书（有/无）'),
    aftersalesRule('conduit-aftersales', '售后服务网点数量（省）'),
    highTechRule('conduit-high-tech', '高新技术企业证书（有/无）'),
    nationalQualityAwardRule('conduit-national-quality-award', '国家级质量奖（有/无）'),
    specializedRule('conduit-specialized', ['专精特新认定（有/无）', '国家或地方政府部门认定为专精特新企业（是/否）']),
    {
      key: 'conduit-manual-process',
      module: '资源实力',
      item: '主观项：设备工艺优化改进',
      fields: ['主观项得分'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 3,
      step: 1,
      sourceFieldKey: '主观项得分'
    },
    {
      key: 'conduit-manual-quality-control',
      module: '质量控制',
      item: '主观项：产品制造质量控制',
      fields: ['主观项得分#2'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 5,
      step: 1,
      sourceFieldKey: '主观项得分#2'
    },
    {
      key: 'conduit-manual-fulfillment-risk',
      module: '质量控制',
      item: '履约风险',
      fields: ['人工录入'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 0,
      max: 2,
      step: 1
    },
    {
      key: 'conduit-manual-run-performance',
      module: '绩效评价',
      item: '运行绩效',
      fields: ['各省提供'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: 0,
      max: 20,
      step: 0.1,
      sourceFieldKey: '各省提供'
    },
    {
      key: 'conduit-manual-composite-performance',
      module: '绩效评价',
      item: '综合绩效',
      fields: ['各省提供#2'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: 0,
      max: 5,
      step: 0.1,
      sourceFieldKey: '各省提供#2'
    },
    {
      key: 'conduit-manual-quality-issue',
      module: '质量问题',
      item: '抽检质量问题不合格通报',
      fields: ['各省提供#3'],
      algorithm: '人工录入当前确认分值。',
      mode: 'manual',
      min: -4,
      max: 0,
      step: 0.5,
      sourceFieldKey: '各省提供#3'
    },
    {
      key: 'conduit-manual-operation',
      module: '履约能力评价',
      item: '经营状况',
      fields: ['主观项得分#3'],
      algorithm: '人工录入。',
      mode: 'manual',
      min: 1,
      max: 3,
      step: 1,
      sourceFieldKey: '主观项得分#3'
    }
  ]
};

const schemaMap: Record<SchemaId, SchemaDefinition> = {
  transformer: transformerSchema,
  'branch-box': branchBoxSchema,
  conduit: conduitSchema
};

export function getSchemaDefinition(id: SchemaId): SchemaDefinition {
  return schemaMap[id];
}

export function scoreWorkbookRows(
  workbook: ImportedWorkbook,
  schema: SchemaDefinition,
  configValues: Record<string, string>,
  manualValues: Record<string, Record<string, string>>
): { rows: ScoredRow[]; metrics: PreviewMetrics } {
  const rows: ScoredRow[] = [];
  let pendingAutoCells = 0;
  let filledManualCells = 0;

  for (const row of workbook.rows) {
    const helper = buildRuleHelper(row, workbook, configValues);
    const rowId = String(row.rowNumber);
    const cells: Record<string, ScoredCell> = {};
    let autoTotal = 0;
    let currentTotal = 0;

    for (const rule of schema.rules) {
      if (rule.mode === 'auto') {
        const result = rule.score ? rule.score(helper) : { score: null, note: '未实现' };
        if (result.score == null) pendingAutoCells += 1;
        if (result.score != null) {
          autoTotal += result.score;
          currentTotal += result.score;
        }
        cells[rule.key] = {
          ruleKey: rule.key,
          mode: 'auto',
          score: result.score,
          note: result.note || ''
        };
        continue;
      }

      const stored = manualValues[rowId]?.[rule.key];
      const source = rule.sourceFieldKey ? parseNumber(row.values[rule.sourceFieldKey] || '') : null;
      const score = stored != null && stored !== '' ? parseNumber(stored) : source;
      if (score != null) {
        currentTotal += score;
        filledManualCells += 1;
      }
      cells[rule.key] = {
        ruleKey: rule.key,
        mode: 'manual',
        score,
        note: score == null ? '待人工录入' : '人工分',
        min: rule.min,
        max: rule.max,
        step: rule.step
      };
    }

    rows.push({
      rowId,
      rowNumber: row.rowNumber,
      sectionName: helper.sectionName,
      supplierName: helper.getText('供应商名称'),
      socialCreditCode: helper.getText('统一社会信用代码'),
      cells,
      autoTotal,
      currentTotal
    });
  }

  return {
    rows,
    metrics: {
      rowCount: rows.length,
      autoRuleCount: schema.rules.filter((rule) => rule.mode === 'auto').length,
      manualRuleCount: schema.rules.filter((rule) => rule.mode === 'manual').length,
      pendingAutoCells,
      filledManualCells
    }
  };
}