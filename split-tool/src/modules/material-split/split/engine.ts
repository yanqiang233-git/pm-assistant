import {
  ExcelRow, SplitRow, FenbiaoConfig, SplitMethod,
  RatioTemplate, PreviewSummary, PKG_NAME_PATTERN
} from '../types';
import {
  adjustLastBigIntItem,
  bigIntToDecimalString,
  decimalToBigInt,
  getMaxDecimalScale,
  normalizeDecimalString,
  splitAverageBigInt,
  splitBigIntByRatio,
  sumDecimalStrings
} from './precision';

function getNormalizedDecimal(row: ExcelRow, field: string): string {
  return normalizeDecimalString(row[field]) ?? '0';
}

function sumBigInt(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

/**
 * 执行全部拆分
 * 三层兜底保证拆分后总和严格等于拆分前：
 * ① 转换层：最后一行吸收 round 累积误差
 * ② 行内拆分：splitByRatio / splitAverage 的 floor+余数保证
 * ③ 包级：最后一个待拆行用减法兜底
 */
export function executeSplit(
  rows: ExcelRow[],
  configs: FenbiaoConfig[],
  templates: RatioTemplate[]
): SplitRow[] {
  const configMap = new Map(configs.map(c => [c.name, c]));
  const templateMap = new Map(templates.map(t => [t.id, t]));
  const result: SplitRow[] = [];

  // 按分标名称分组，保留出现顺序
  const fenbiaoOrder: string[] = [];
  const fenbiaoGroups = new Map<string, ExcelRow[]>();
  for (const row of rows) {
    const fbName = String(row['分标名称'] ?? '').trim();
    if (!fenbiaoGroups.has(fbName)) {
      fenbiaoOrder.push(fbName);
      fenbiaoGroups.set(fbName, []);
    }
    fenbiaoGroups.get(fbName)!.push(row);
  }

  for (const fbName of fenbiaoOrder) {
    const fbRows = fenbiaoGroups.get(fbName)!;
    const config = configMap.get(fbName);
    if (!config || config.packageCount <= 0) {
      result.push(...fbRows.map(r => ({ ...r })));
      continue;
    }

    const n = config.packageCount;

    const fbResultStart = result.length;

    // ── 分离预分配行与待拆行 ──
    const preAllocRows: ExcelRow[] = [];
    const toSplitRows: ExcelRow[] = [];
    for (const row of fbRows) {
      const pkgName = String(row['分包名称'] ?? '').trim();
      if (PKG_NAME_PATTERN.test(pkgName)) {
        preAllocRows.push(row);
      } else {
        toSplitRows.push(row);
      }
    }

    // 校验预分配行的包号范围
    for (const row of preAllocRows) {
      const match = PKG_NAME_PATTERN.exec(String(row['分包名称']).trim())!;
      const pkgNum = parseInt(match[1]);
      if (pkgNum < 1 || pkgNum > n) {
        throw new Error(
          `分标"${fbName}"中预分配行的包号"包${pkgNum}"超出范围（最大包${n}）`
        );
      }
    }

    // ── 输出预分配行（自动补分包编号）──
    const amountDecimals = fbRows.map(row => getNormalizedDecimal(row, '估算总价（元）'));
    const qtyDecimals = fbRows.map(row => getNormalizedDecimal(row, '数量'));
    const amountScale = getMaxDecimalScale([...amountDecimals, ...(config.fixedAmounts ?? [])]);
    const qtyScale = getMaxDecimalScale(qtyDecimals);

    const preAllocAmountPerPkg = new Array<bigint>(n).fill(0n);
    const preAllocQtyPerPkg = new Array<bigint>(n).fill(0n);
    for (const row of preAllocRows) {
      const match = PKG_NAME_PATTERN.exec(String(row['分包名称']).trim())!;
      const pkgNum = parseInt(match[1]);
      const pkgIdx = pkgNum - 1;
      const newRow: SplitRow = { ...row };
      newRow['分包编号'] = `JS${pkgNum * 100}`;
      result.push(newRow);
      preAllocAmountPerPkg[pkgIdx] += decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale);
      preAllocQtyPerPkg[pkgIdx] += decimalToBigInt(getNormalizedDecimal(row, '数量'), qtyScale);
    }

    // 若该分标无待拆行，跳过后续拆分逻辑
    if (toSplitRows.length === 0) continue;

    // ── 计算分标精确总量 ──
    const fbTotalAmount = sumBigInt(amountDecimals.map(value => decimalToBigInt(value, amountScale)));
    const fbTotalQty = sumBigInt(qtyDecimals.map(value => decimalToBigInt(value, qtyScale)));

    // ── 计算每包目标金额/数量 ──
    let packageTargetAmounts: bigint[];
    let packageTargetQtys: bigint[];
    const method: SplitMethod = config.splitMethod;

    if (method === 'average') {
      packageTargetAmounts = splitAverageBigInt(fbTotalAmount, n);
      packageTargetQtys = splitAverageBigInt(fbTotalQty, n);
    } else if (method === 'ratio' && config.templateId) {
      const tpl = templateMap.get(config.templateId);
      const ratios = tpl?.ratios ?? Array(n).fill(1);
      packageTargetAmounts = splitBigIntByRatio(fbTotalAmount, ratios);
      packageTargetQtys = splitBigIntByRatio(fbTotalQty, ratios);
    } else if (method === 'fixedAmount' && config.fixedAmounts) {
      packageTargetAmounts = config.fixedAmounts.map(value => decimalToBigInt(value, amountScale));
      if (sumBigInt(packageTargetAmounts) !== fbTotalAmount) {
        throw new Error(`分标"${fbName}"的指定金额总和与原始总额不一致`);
      }
      packageTargetQtys = splitBigIntByRatio(fbTotalQty, packageTargetAmounts);
    } else {
      packageTargetAmounts = splitAverageBigInt(fbTotalAmount, n);
      packageTargetQtys = splitAverageBigInt(fbTotalQty, n);
    }

    // ── 计算每包剩余预算 ──
    const remainBudgetAmount = packageTargetAmounts.map(
      (t, i) => t - preAllocAmountPerPkg[i]
    );
    const remainBudgetQty = packageTargetQtys.map(
      (t, i) => t - preAllocQtyPerPkg[i]
    );

    // 检查预占是否超标
    for (let i = 0; i < n; i++) {
      if (remainBudgetAmount[i] < 0n) {
        throw new Error(
          `分标"${fbName}"包${i + 1}的预分配金额(${bigIntToDecimalString(preAllocAmountPerPkg[i], amountScale)})` +
          `超过目标金额(${bigIntToDecimalString(packageTargetAmounts[i], amountScale)})`
        );
      }
    }

    // ── 层级①：转换层兜底 ──
    // 各行独立 round 后累加可能 ≠ 总和 round，调整最后一行吸收差值
    const rowAmountsInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale)
    );
    const rowQtysInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '数量'), qtyScale)
    );
    const toSplitTotalAmount = sumBigInt(remainBudgetAmount);
    const toSplitTotalQty = sumBigInt(remainBudgetQty);
    adjustLastBigIntItem(rowAmountsInt, toSplitTotalAmount);
    adjustLastBigIntItem(rowQtysInt, toSplitTotalQty);

    // ── 拆分待拆行 ──
    const accumulatedPerPkg = new Array<bigint>(n).fill(0n);
    const accumulatedQtyPerPkg = new Array<bigint>(n).fill(0n);

    for (let rowIdx = 0; rowIdx < toSplitRows.length; rowIdx++) {
      const row = toSplitRows[rowIdx];
      const isLastRow = rowIdx === toSplitRows.length - 1;
      const rowAmountInt = rowAmountsInt[rowIdx];
      const rowQtyInt = rowQtysInt[rowIdx];

      let priceShares: bigint[];
      let qtyShares: bigint[];

      if (isLastRow) {
        // 层级③：尾行用减法兜底 → 确保每包总和严格等于目标
        priceShares = remainBudgetAmount.map(
          (budget, i) => budget - accumulatedPerPkg[i]
        );
        qtyShares = remainBudgetQty.map(
          (budget, i) => budget - accumulatedQtyPerPkg[i]
        );
      } else {
        // 层级②：行内拆分（splitByRatio/splitAverage 保证 sum = total）
        if (method === 'average') {
          priceShares = splitAverageBigInt(rowAmountInt, n);
          qtyShares = splitAverageBigInt(rowQtyInt, n);
        } else if (method === 'ratio' && config.templateId) {
          const tpl = templateMap.get(config.templateId);
          const ratios = tpl?.ratios ?? Array(n).fill(1);
          priceShares = splitBigIntByRatio(rowAmountInt, ratios);
          qtyShares = splitBigIntByRatio(rowQtyInt, ratios);
        } else if (method === 'fixedAmount' && config.fixedAmounts) {
          const weights = config.fixedAmounts.map(value => decimalToBigInt(value, amountScale));
          priceShares = splitBigIntByRatio(rowAmountInt, weights);
          qtyShares = splitBigIntByRatio(rowQtyInt, weights);
        } else {
          priceShares = splitAverageBigInt(rowAmountInt, n);
          qtyShares = splitAverageBigInt(rowQtyInt, n);
        }
      }

      for (let i = 0; i < n; i++) {
        const newRow: SplitRow = { ...row };
        newRow['分包名称'] = `包${i + 1}`;
        newRow['分包编号'] = `JS${(i + 1) * 100}`;
        newRow['估算总价（元）'] = Number(bigIntToDecimalString(priceShares[i], amountScale));
        newRow['数量'] = Number(bigIntToDecimalString(qtyShares[i], qtyScale));
        result.push(newRow);
        accumulatedPerPkg[i] += priceShares[i];
        accumulatedQtyPerPkg[i] += qtyShares[i];
      }
    }

    // ── 全局断言：验证拆分后金额总和 ──
    const outputAmountTotal =
      sumBigInt(preAllocAmountPerPkg) + sumBigInt(accumulatedPerPkg);
    if (outputAmountTotal !== fbTotalAmount) {
      throw new Error(
        `内部错误：分标"${fbName}"拆分后金额总和(${bigIntToDecimalString(outputAmountTotal, amountScale)})≠原始总和(${bigIntToDecimalString(fbTotalAmount, amountScale)})`
      );
    }

    const outputQtyTotal =
      sumBigInt(preAllocQtyPerPkg) + sumBigInt(accumulatedQtyPerPkg);
    if (outputQtyTotal !== fbTotalQty) {
      throw new Error(
        `内部错误：分标"${fbName}"拆分后数量总和(${bigIntToDecimalString(outputQtyTotal, qtyScale)})≠原始总和(${bigIntToDecimalString(fbTotalQty, qtyScale)})`
      );
    }

    // ── 浮点层兜底：确保 Number 求和与原始行完全一致 ──
    const fbOutputRows = result.slice(fbResultStart);
    const origAmtFloat = fbRows.reduce((s, r) => s + Number(r['估算总价（元）'] ?? 0), 0);
    const origQtyFloat = fbRows.reduce((s, r) => s + Number(r['数量'] ?? 0), 0);
    const outAmtFloat = fbOutputRows.reduce((s, r) => s + Number(r['估算总价（元）'] ?? 0), 0);
    const outQtyFloat = fbOutputRows.reduce((s, r) => s + Number(r['数量'] ?? 0), 0);
    const amtDiff = origAmtFloat - outAmtFloat;
    const qtyDiff = origQtyFloat - outQtyFloat;
    if (amtDiff !== 0 && fbOutputRows.length > 0) {
      const last = fbOutputRows[fbOutputRows.length - 1];
      last['估算总价（元）'] = Number(last['估算总价（元）']) + amtDiff;
    }
    if (qtyDiff !== 0 && fbOutputRows.length > 0) {
      const last = fbOutputRows[fbOutputRows.length - 1];
      last['数量'] = Number(last['数量']) + qtyDiff;
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
    const splitRowsForFB = splitRows.filter(
      r => String(r['分标名称'] ?? '').trim() === c.name
    );
    const totalAmount = origRows.reduce(
      (s, r) => s + Number(r['估算总价（元）'] ?? 0), 0
    );
    const amounts = origRows.map(r => normalizeDecimalString(r['估算总价（元）']) ?? '0');
    const exactTotal = sumDecimalStrings(amounts);
    return {
      name: c.name,
      originalRows: origRows.length,
      packageCount: c.packageCount,
      splitRows: splitRowsForFB.length,
      totalAmount: Number(exactTotal)
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
