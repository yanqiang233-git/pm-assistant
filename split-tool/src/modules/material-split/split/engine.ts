import {
  ExcelRow, SplitRow, FenbiaoConfig, SplitMethod,
  RatioTemplate, PreviewSummary, PKG_NAME_PATTERN
} from '../types';
import {
  bigIntToDecimalString,
  decimalToBigInt,
  getMaxDecimalScale,
  normalizeDecimalString,
  splitAverageBigInt,
  splitBigIntByRatio,
  sumDecimalStrings
} from './precision';

/** 输出精度：金额保留 2 位小数，数量保留 3 位小数 */
const AMOUNT_OUTPUT_SCALE = 2;
const QTY_OUTPUT_SCALE = 3;

function getNormalizedDecimal(row: ExcelRow, field: string): string {
  return normalizeDecimalString(row[field]) ?? '0';
}

function sumBigInt(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

/**
 * 将 BigInt 值从 srcScale 四舍五入到 dstScale（dstScale ≤ srcScale）
 * 返回在 dstScale 下的 BigInt
 */
function roundBigIntToScale(value: bigint, srcScale: number, dstScale: number): bigint {
  if (dstScale >= srcScale) return value;
  const factor = 10n ** BigInt(srcScale - dstScale);
  const sign = value < 0n ? -1n : 1n;
  const abs = value < 0n ? -value : value;
  return sign * ((abs + factor / 2n) / factor);
}

/**
 * 对一组 BigInt 值执行四舍五入，然后校验加和并补齐差值。
 * 补齐方向：包号小的金额更大（即优先给前面的包加 1 最小单位）。
 * @returns 在 dstScale 下的 BigInt 数组，保证 sum === targetInDstScale
 */
function roundAndReconcile(
  values: bigint[],
  srcScale: number,
  dstScale: number,
  targetInDstScale: bigint
): bigint[] {
  const rounded = values.map(v => roundBigIntToScale(v, srcScale, dstScale));
  let diff = targetInDstScale - sumBigInt(rounded);
  if (diff > 0n) {
    // 需要增加 → 从包号小的开始加（包号小者金额更大）
    for (let i = 0; diff > 0n && i < rounded.length; i++) {
      rounded[i] += 1n;
      diff -= 1n;
    }
  } else if (diff < 0n) {
    // 需要减少 → 从包号大的开始减（包号小者金额更大）
    for (let i = rounded.length - 1; diff < 0n && i >= 0; i--) {
      rounded[i] -= 1n;
      diff += 1n;
    }
  }
  return rounded;
}

function assertRoundedSum(
  values: bigint[],
  target: bigint,
  scale: number,
  fieldLabel: string,
  contextLabel: string
): void {
  const sum = sumBigInt(values);
  if (sum !== target) {
    throw new Error(
      `${contextLabel}${fieldLabel}在保留${scale}位小数后合计不等于原值：拆分合计${bigIntToDecimalString(sum, scale)}，原值${bigIntToDecimalString(target, scale)}`
    );
  }
}

/**
 * 执行全部拆分
 * 全部使用 BigInt 精确运算，拆分后输出固定精度（金额2位/数量3位），
 * 四舍五入后校验加和，差值补齐到包号最小的包。
 * 保证：
 * - 每行拆分后各包金额/数量 sum === 原始行值（十进制精确）
 * - 每分标拆分后所有行 sum === 原始分标总和（十进制精确）
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

    // ── 计算精度参数 ──
    const amountDecimals = fbRows.map(row => getNormalizedDecimal(row, '估算总价（元）'));
    const qtyDecimals = fbRows.map(row => getNormalizedDecimal(row, '数量'));
    // 内部运算精度：取数据实际精度与输出精度的较大值
    const amountScale = Math.max(getMaxDecimalScale(amountDecimals), AMOUNT_OUTPUT_SCALE);
    const qtyScale = Math.max(getMaxDecimalScale(qtyDecimals), QTY_OUTPUT_SCALE);

    // ── 输出预分配行（自动补分包编号）──
    for (const row of preAllocRows) {
      const match = PKG_NAME_PATTERN.exec(String(row['分包名称']).trim())!;
      const pkgNum = parseInt(match[1]);
      const newRow: SplitRow = { ...row };
      newRow['分包编号'] = `JS${pkgNum * 100}`;
      result.push(newRow);
    }

    // 若该分标无待拆行，跳过后续拆分逻辑
    if (toSplitRows.length === 0) continue;

    // ── 计算分标精确总量 ──
    const fbTotalAmount = sumBigInt(amountDecimals.map(value => decimalToBigInt(value, amountScale)));
    const fbTotalQty = sumBigInt(qtyDecimals.map(value => decimalToBigInt(value, qtyScale)));

    const method: SplitMethod = config.splitMethod;
    // 待拆行按“逐行独立拆分”处理：
    // 预分配行仅原样保留并计入总量，不再占用后续待拆行的包级预算。
    const rowAmountsInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale)
    );
    const rowQtysInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '数量'), qtyScale)
    );

    for (let rowIdx = 0; rowIdx < toSplitRows.length; rowIdx++) {
      const row = toSplitRows[rowIdx];
      const rowAmountInt = rowAmountsInt[rowIdx];
      const rowQtyInt = rowQtysInt[rowIdx];

      let priceShares: bigint[];
      let qtyShares: bigint[];

      if (method === 'average') {
        priceShares = splitAverageBigInt(rowAmountInt, n);
        qtyShares = splitAverageBigInt(rowQtyInt, n);
      } else if (method === 'ratio' && config.templateId) {
        const tpl = templateMap.get(config.templateId);
        const ratios = tpl?.ratios ?? Array(n).fill(1);
        priceShares = splitBigIntByRatio(rowAmountInt, ratios);
        qtyShares = splitBigIntByRatio(rowQtyInt, ratios);
      } else if (method === 'fixedAmount' && config.fixedAmounts) {
        const weightScale = Math.max(amountScale, getMaxDecimalScale(config.fixedAmounts));
        const weights = config.fixedAmounts.map(value => decimalToBigInt(value, weightScale));
        if (sumBigInt(weights) === 0n) {
          throw new Error(`分标"${fbName}"的参考金额不能全为 0`);
        }
        priceShares = splitBigIntByRatio(rowAmountInt, weights);
        qtyShares = splitBigIntByRatio(rowQtyInt, weights);
      } else {
        priceShares = splitAverageBigInt(rowAmountInt, n);
        qtyShares = splitAverageBigInt(rowQtyInt, n);
      }

      // 行级是唯一硬约束：每行 round 后必须严格回到原行金额/数量。
      const amtTarget = roundBigIntToScale(rowAmountInt, amountScale, AMOUNT_OUTPUT_SCALE);
      const qtyTarget = roundBigIntToScale(rowQtyInt, qtyScale, QTY_OUTPUT_SCALE);

      const roundedAmts = roundAndReconcile(priceShares, amountScale, AMOUNT_OUTPUT_SCALE, amtTarget);
      const roundedQtys = roundAndReconcile(qtyShares, qtyScale, QTY_OUTPUT_SCALE, qtyTarget);

      // ── 包号降序修复：确保包号小者金额 ≥ 包号大者 ──
      // 四舍五入/补齐可能产生相邻包逆序（差1个最小单位），通过冒泡排序修复
      for (let pass = 0; pass < roundedAmts.length - 1; pass++) {
        let swapped = false;
        for (let i = 0; i < roundedAmts.length - 1 - pass; i++) {
          if (roundedAmts[i] < roundedAmts[i + 1]) {
            [roundedAmts[i], roundedAmts[i + 1]] = [roundedAmts[i + 1], roundedAmts[i]];
            [roundedQtys[i], roundedQtys[i + 1]] = [roundedQtys[i + 1], roundedQtys[i]];
            swapped = true;
          }
        }
        if (!swapped) break;
      }

      assertRoundedSum(
        roundedAmts,
        amtTarget,
        AMOUNT_OUTPUT_SCALE,
        '金额',
        `分标"${fbName}"第${rowIdx + 1}条待拆行：`
      );
      assertRoundedSum(
        roundedQtys,
        qtyTarget,
        QTY_OUTPUT_SCALE,
        '数量',
        `分标"${fbName}"第${rowIdx + 1}条待拆行：`
      );

      for (let i = 0; i < n; i++) {
        const newRow: SplitRow = { ...row };
        newRow['分包名称'] = `包${i + 1}`;
        newRow['分包编号'] = `JS${(i + 1) * 100}`;
        newRow['估算总价（元）'] = bigIntToDecimalString(roundedAmts[i], AMOUNT_OUTPUT_SCALE);
        newRow['数量'] = bigIntToDecimalString(roundedQtys[i], QTY_OUTPUT_SCALE);
        result.push(newRow);
      }
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
    const amounts = origRows.map(r => normalizeDecimalString(r['估算总价（元）']) ?? '0');
    return {
      name: c.name,
      originalRows: origRows.length,
      packageCount: c.packageCount,
      splitRows: splitRowsForFB.length,
      totalAmount: sumDecimalStrings(amounts)
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
