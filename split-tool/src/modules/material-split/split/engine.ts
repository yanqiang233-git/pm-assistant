import {
  ExcelRow, SplitRow, FenbiaoConfig, SplitMethod,
  RatioTemplate, PreviewSummary
} from '../types';
import {
  yuanToFen, fenToYuan, qtyToInt, intToQty,
  splitByRatio, splitAverage, splitByFixedAmounts
} from './precision';

/**
 * 执行全部拆分
 */
export function executeSplit(
  rows: ExcelRow[],
  configs: FenbiaoConfig[],
  templates: RatioTemplate[]
): SplitRow[] {
  const configMap = new Map(configs.map(c => [c.name, c]));
  const templateMap = new Map(templates.map(t => [t.id, t]));
  const result: SplitRow[] = [];

  // 预计算指定金额模式下每个分标的总金额
  const fenbiaoTotals = new Map<string, number>();
  for (const row of rows) {
    const fbName = String(row['分标名称'] ?? '').trim();
    const price = yuanToFen(Number(row['估算总价（元）'] ?? 0));
    fenbiaoTotals.set(fbName, (fenbiaoTotals.get(fbName) || 0) + price);
  }

  for (const row of rows) {
    const fbName = String(row['分标名称'] ?? '').trim();
    const config = configMap.get(fbName);
    if (!config || config.packageCount <= 0) {
      result.push({ ...row });
      continue;
    }

    const n = config.packageCount;
    const totalPriceFen = yuanToFen(Number(row['估算总价（元）'] ?? 0));
    const totalQtyInt = qtyToInt(Number(row['数量'] ?? 0));

    let priceShares: number[];
    let qtyShares: number[];

    const method: SplitMethod = config.splitMethod;
    if (method === 'average') {
      priceShares = splitAverage(totalPriceFen, n);
      qtyShares = splitAverage(totalQtyInt, n);
    } else if (method === 'ratio' && config.templateId) {
      const tpl = templateMap.get(config.templateId);
      if (!tpl) {
        priceShares = splitAverage(totalPriceFen, n);
        qtyShares = splitAverage(totalQtyInt, n);
      } else {
        priceShares = splitByRatio(totalPriceFen, tpl.ratios);
        qtyShares = splitByRatio(totalQtyInt, tpl.ratios);
      }
    } else if (method === 'fixedAmount' && config.fixedAmounts) {
      const amountSum = fenbiaoTotals.get(fbName) || 0;
      priceShares = splitByFixedAmounts(totalPriceFen, config.fixedAmounts, amountSum);
      qtyShares = splitByFixedAmounts(totalQtyInt, config.fixedAmounts, amountSum);
    } else {
      priceShares = splitAverage(totalPriceFen, n);
      qtyShares = splitAverage(totalQtyInt, n);
    }

    for (let i = 0; i < n; i++) {
      const newRow: SplitRow = { ...row };
      newRow['分包名称'] = `包${i + 1}`;
      newRow['分包编号'] = `JS${(i + 1) * 100}`;
      newRow['估算总价（元）'] = fenToYuan(priceShares[i]);
      newRow['数量'] = intToQty(qtyShares[i]);
      // 估算单价保持原值不变
      result.push(newRow);
    }
  }

  return result;
}

/** 生成预览摘要 */
export function generatePreviewSummary(
  originalRows: ExcelRow[],
  splitRows: SplitRow[],
  configs: FenbiaoConfig[]
): PreviewSummary {
  const fenbiaoDetails = configs.map(c => {
    const origRows = originalRows.filter(
      r => String(r['分标名称'] ?? '').trim() === c.name
    );
    const totalAmount = origRows.reduce(
      (s, r) => s + Number(r['估算总价（元）'] ?? 0), 0
    );
    return {
      name: c.name,
      originalRows: origRows.length,
      packageCount: c.packageCount,
      splitRows: origRows.length * c.packageCount,
      totalAmount: Math.round(totalAmount * 100) / 100
    };
  });

  return {
    originalRows: originalRows.length,
    splitRows: splitRows.length,
    totalFenbiao: configs.length,
    totalPackages: configs.reduce((s, c) => s + c.packageCount, 0),
    fenbiaoDetails
  };
}
