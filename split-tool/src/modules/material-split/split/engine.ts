import {
  ExcelRow, SplitRow, FenbiaoConfig, SplitMethod,
  RatioTemplate, PreviewSummary, PKG_NAME_PATTERN
} from '../types';
import {
  bigIntToDecimalString,
  decimalToBigInt,
  getMaxDecimalScale,
  getDecimalScale,
  normalizeDecimalString,
  splitAverageBigInt,
  splitBigIntByRatio,
  sumDecimalStrings
} from './precision';

/** 输出精度：金额保留 2 位小数，数量保留 3 位小数 */
const AMOUNT_OUTPUT_SCALE = 2;
const QTY_OUTPUT_SCALE = 3;
const ROUNDED_QTY_OUTPUT_SCALE = 0;
const AMOUNT_TOLERANCE = 1n;

function getNormalizedDecimal(row: ExcelRow, field: string): string {
  return normalizeDecimalString(row[field]) ?? '0';
}

function sumBigInt(values: bigint[]): bigint {
  return values.reduce((sum, value) => sum + value, 0n);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
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

function multiplyToScale(
  left: bigint,
  leftScale: number,
  right: bigint,
  rightScale: number,
  dstScale: number
): bigint {
  const product = left * right;
  const productScale = leftScale + rightScale;
  if (dstScale >= productScale) {
    return product * (10n ** BigInt(dstScale - productScale));
  }
  return roundBigIntToScale(product, productScale, dstScale);
}

function getValidatedUnitPrice(
  row: ExcelRow,
  contextLabel: string
): { normalized: string; value: bigint; scale: number } {
  const normalized = normalizeDecimalString(row['估算单价（元）']);
  if (normalized == null) {
    throw new Error(`${contextLabel}估算单价为空或格式无效，无法执行拆分`);
  }

  const scale = getDecimalScale(normalized);
  const value = decimalToBigInt(normalized, scale);
  if (value <= 0n) {
    throw new Error(`${contextLabel}估算单价必须大于 0，无法执行拆分`);
  }

  return { normalized, value, scale };
}

function assertSourceRowConsistent(
  rowAmountInt: bigint,
  amountScale: number,
  rowQtyInt: bigint,
  qtyScale: number,
  unitPriceInt: bigint,
  unitPriceScale: number,
  contextLabel: string
): void {
  const actualAmount = roundBigIntToScale(rowAmountInt, amountScale, AMOUNT_OUTPUT_SCALE);
  const expectedAmount = multiplyToScale(
    rowQtyInt,
    qtyScale,
    unitPriceInt,
    unitPriceScale,
    AMOUNT_OUTPUT_SCALE
  );

  if (absBigInt(actualAmount - expectedAmount) > AMOUNT_TOLERANCE) {
    throw new Error(
      `${contextLabel}原始行数量、估算单价、估算总价不一致，超出允许的四舍五入误差`
    );
  }
}

function buildPositiveIntegerShares(
  total: bigint,
  weights: bigint[],
  minimum: bigint,
  fieldLabel: string,
  contextLabel: string
): bigint[] {
  if (total < 0n) {
    throw new Error(`${contextLabel}${fieldLabel}不能为负数`);
  }
  if (total === 0n) {
    return Array.from({ length: weights.length }, () => 0n);
  }

  const requiredMinimum = minimum * BigInt(weights.length);
  if (requiredMinimum > total) {
    throw new Error(
      `${contextLabel}${fieldLabel}不足以拆分为 ${weights.length} 个非零结果，请减少分包数量或调整原始数据`
    );
  }

  const normalizedWeights = weights.map(value => value > 0n ? value : 0n);
  const ratioBasis = sumBigInt(normalizedWeights) > 0n
    ? normalizedWeights
    : Array.from({ length: weights.length }, () => 1n);
  const remainder = total - requiredMinimum;
  const extraShares = remainder > 0n
    ? splitBigIntByRatio(remainder, ratioBasis)
    : Array.from({ length: weights.length }, () => 0n);
  return extraShares.map(value => value + minimum);
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

function buildFixedAmountTargets(total: bigint, fixedAmounts: string[]): bigint[] {
  const weightScale = getMaxDecimalScale(fixedAmounts);
  const weights = fixedAmounts.map(value => decimalToBigInt(value, weightScale));
  if (sumBigInt(weights) === 0n) {
    throw new Error('参考金额不能全为 0');
  }
  return splitBigIntByRatio(total, weights);
}

function buildDynamicFixedAmountRowTargets(
  rowTotal: bigint,
  packageTargets: bigint[],
  allocated: bigint[],
  isLastRow: boolean
): bigint[] {
  const remaining = packageTargets.map((target, index) => target - allocated[index]);
  if (isLastRow) {
    return remaining;
  }
  const positiveRemaining = remaining.map(value => value > 0n ? value : 0n);
  const weights = sumBigInt(positiveRemaining) > 0n ? positiveRemaining : packageTargets;
  return splitBigIntByRatio(rowTotal, weights);
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
    const qtyOutputScale = config.splitScope === 'rounded' ? ROUNDED_QTY_OUTPUT_SCALE : QTY_OUTPUT_SCALE;
    const qtyScale = Math.max(getMaxDecimalScale(qtyDecimals), qtyOutputScale);

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

    const method: SplitMethod = config.splitMethod;
    // 待拆行按“逐行独立拆分”处理：
    // 预分配行仅原样保留并计入总量，不再占用后续待拆行的包级预算。
    const rowAmountsInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale)
    );
    const rowQtysInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '数量'), qtyScale)
    );
    const fixedAmountRoundedTargets = method === 'fixedAmount' && config.fixedAmounts && config.splitScope === 'rounded'
      ? buildFixedAmountTargets(
          rowAmountsInt.reduce(
            (sum, value) => sum + roundBigIntToScale(value, amountScale, AMOUNT_OUTPUT_SCALE),
            0n
          ),
          config.fixedAmounts
        )
      : null;
    const fixedAmountRoundedAllocated = fixedAmountRoundedTargets
      ? Array.from({ length: n }, () => 0n)
      : null;

    for (let rowIdx = 0; rowIdx < toSplitRows.length; rowIdx++) {
      const row = toSplitRows[rowIdx];
      const isLastRow = rowIdx === toSplitRows.length - 1;
      const contextLabel = `分标"${fbName}"第${rowIdx + 1}条待拆行：`;
      if (config.splitScope === 'rounded' && getDecimalScale(getNormalizedDecimal(row, '数量')) > 0) {
        throw new Error(`分标"${fbName}"存在小数数量，不能按取整拆分执行`);
      }
      const rowAmountInt = rowAmountsInt[rowIdx];
      const rowQtyInt = rowQtysInt[rowIdx];
      const { value: unitPriceInt, scale: unitPriceScale } = getValidatedUnitPrice(row, contextLabel);
      assertSourceRowConsistent(
        rowAmountInt,
        amountScale,
        rowQtyInt,
        qtyScale,
        unitPriceInt,
        unitPriceScale,
        contextLabel
      );

      let priceShares: bigint[];

      if (method === 'average') {
        priceShares = splitAverageBigInt(rowAmountInt, n);
      } else if (method === 'ratio' && config.templateId) {
        const tpl = templateMap.get(config.templateId);
        const ratios = tpl?.ratios ?? Array(n).fill(1);
        priceShares = splitBigIntByRatio(rowAmountInt, ratios);
      } else if (method === 'fixedAmount' && config.fixedAmounts) {
        const weightScale = Math.max(amountScale, getMaxDecimalScale(config.fixedAmounts));
        const weights = config.fixedAmounts.map(value => decimalToBigInt(value, weightScale));
        if (sumBigInt(weights) === 0n) {
          throw new Error(`分标"${fbName}"的参考金额不能全为 0`);
        }
        priceShares = splitBigIntByRatio(rowAmountInt, weights);
      } else {
        priceShares = splitAverageBigInt(rowAmountInt, n);
      }

      // 行级是唯一硬约束：每行 round 后必须严格回到原行金额/数量。
      const amtTarget = roundBigIntToScale(rowAmountInt, amountScale, AMOUNT_OUTPUT_SCALE);
      const qtyTarget = roundBigIntToScale(rowQtyInt, qtyScale, qtyOutputScale);

      if (amtTarget > 0n && qtyTarget === 0n) {
        throw new Error(`${contextLabel}金额大于 0 但数量为 0，无法满足数量与金额一致性`);
      }

      const useFixedAmountRoundedOptimization = Boolean(fixedAmountRoundedTargets && fixedAmountRoundedAllocated);
      const amountWeightBasis = useFixedAmountRoundedOptimization
        ? buildDynamicFixedAmountRowTargets(
            amtTarget,
            fixedAmountRoundedTargets!,
            fixedAmountRoundedAllocated!,
            isLastRow
          )
        : priceShares;
      const initialRoundedAmts = config.splitScope === 'rounded'
        ? buildPositiveIntegerShares(amtTarget, amountWeightBasis, 1n, '金额', contextLabel)
        : useFixedAmountRoundedOptimization
          ? amountWeightBasis
          : roundAndReconcile(priceShares, amountScale, AMOUNT_OUTPUT_SCALE, amtTarget);
      const qtyWeightBasis = initialRoundedAmts.map(value => value > 0n ? value : 0n);
      const roundedQtys = config.splitScope === 'rounded'
        ? buildPositiveIntegerShares(qtyTarget, qtyWeightBasis, 1n, '数量', contextLabel)
        : roundAndReconcile(
            splitBigIntByRatio(
              rowQtyInt,
              sumBigInt(qtyWeightBasis) > 0n
                ? qtyWeightBasis
                : Array.from({ length: n }, () => 1n)
            ),
            qtyScale,
            qtyOutputScale,
            qtyTarget
          );
      const roundedAmts = config.splitScope === 'rounded'
        ? roundAndReconcile(
            roundedQtys.map(value => multiplyToScale(
              value,
              qtyOutputScale,
              unitPriceInt,
              unitPriceScale,
              AMOUNT_OUTPUT_SCALE
            )),
            AMOUNT_OUTPUT_SCALE,
            AMOUNT_OUTPUT_SCALE,
            amtTarget
          )
        : initialRoundedAmts;

      if (useFixedAmountRoundedOptimization) {
        for (let index = 0; index < fixedAmountRoundedAllocated!.length; index++) {
          fixedAmountRoundedAllocated![index] += roundedAmts[index];
        }
      }

      // ── 包号降序修复：确保包号小者金额 ≥ 包号大者 ──
      // 四舍五入/补齐可能产生相邻包逆序（差1个最小单位），通过冒泡排序修复
      if (!useFixedAmountRoundedOptimization) {
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
      }

      assertRoundedSum(
        roundedAmts,
        amtTarget,
        AMOUNT_OUTPUT_SCALE,
        '金额',
        contextLabel
      );
      assertRoundedSum(
        roundedQtys,
        qtyTarget,
        qtyOutputScale,
        '数量',
        contextLabel
      );

      if (config.splitScope === 'rounded' && roundedAmts.some(value => value <= 0n)) {
        throw new Error(`${contextLabel}取整拆分后的金额存在 0 或负数，无法与非零数量保持一致`);
      }
      if (config.splitScope === 'rounded' && roundedQtys.some(value => value <= 0n)) {
        throw new Error(`${contextLabel}取整拆分后的数量存在 0 或负数，请减少分包数量或调整原始数据`);
      }

      for (let i = 0; i < n; i++) {
        const newRow: SplitRow = { ...row };
        newRow['分包名称'] = `包${i + 1}`;
        newRow['分包编号'] = `JS${(i + 1) * 100}`;
        newRow['估算总价（元）'] = bigIntToDecimalString(roundedAmts[i], AMOUNT_OUTPUT_SCALE);
        newRow['数量'] = bigIntToDecimalString(roundedQtys[i], qtyOutputScale);
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
