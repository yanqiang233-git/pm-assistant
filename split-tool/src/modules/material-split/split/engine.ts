import {
  ExcelRow, SplitRow, FenbiaoConfig, SplitExecutionResult, SplitMethod,
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

function isStrictlyDescendingBigInt(values: bigint[], indices?: number[]): boolean {
  const orderedIndices = indices ?? Array.from({ length: values.length }, (_, index) => index);
  for (let index = 0; index < orderedIndices.length - 1; index++) {
    if (values[orderedIndices[index]] <= values[orderedIndices[index + 1]]) {
      return false;
    }
  }
  return true;
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
  const increaseOrder = Array.from({ length: rounded.length }, (_, index) => index);
  const decreaseOrder = Array.from({ length: rounded.length }, (_, index) => rounded.length - 1 - index);
  return reconcileIntegerValues(rounded, targetInDstScale, increaseOrder, decreaseOrder);
}

function reconcileIntegerValues(
  values: bigint[],
  target: bigint,
  increaseOrder: number[],
  decreaseOrder: number[],
  minimumValue = 0n
): bigint[] {
  const adjusted = values.slice();
  let diff = target - sumBigInt(adjusted);
  while (diff !== 0n) {
    const increase = diff > 0n;
    const order = increase ? increaseOrder : decreaseOrder;
    let moved = false;

    for (const index of order) {
      const nextValue = adjusted[index] + (increase ? 1n : -1n);
      if (!increase && nextValue < minimumValue) continue;
      adjusted[index] = nextValue;
      diff += increase ? -1n : 1n;
      moved = true;
      if (diff === 0n) break;
    }

    if (!moved) {
      throw new Error('无法在当前约束下完成整数回补');
    }
  }

  return adjusted;
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

function calculateTotalDeviation(values: bigint[], targets: bigint[]): bigint {
  return values.reduce((sum, value, index) => sum + absBigInt(value - targets[index]), 0n);
}

function reconcileAmountsByTargetDeviation(
  values: bigint[],
  target: bigint,
  allocated: bigint[],
  packageTargets: bigint[],
  minimumValue = 0n
): bigint[] {
  const adjusted = values.slice();
  let diff = target - sumBigInt(adjusted);

  while (diff !== 0n) {
    const step = diff > 0n ? 1n : -1n;
    let bestIndex = -1;
    let bestScore: bigint | null = null;
    let bestNextDeviation: bigint | null = null;

    for (let index = 0; index < adjusted.length; index++) {
      const nextValue = adjusted[index] + step;
      if (step < 0n && nextValue < minimumValue) continue;

      const currentDeviation = absBigInt(allocated[index] + adjusted[index] - packageTargets[index]);
      const nextDeviation = absBigInt(allocated[index] + nextValue - packageTargets[index]);
      const score = currentDeviation - nextDeviation;

      if (
        bestIndex === -1
        || score > bestScore!
        || (score === bestScore && nextDeviation < bestNextDeviation!)
        || (score === bestScore && nextDeviation === bestNextDeviation && index < bestIndex)
      ) {
        bestIndex = index;
        bestScore = score;
        bestNextDeviation = nextDeviation;
      }
    }

    if (bestIndex === -1) {
      throw new Error('无法在保持非零金额约束下完成目标金额回补');
    }

    adjusted[bestIndex] += step;
    diff -= step;
  }

  return adjusted;
}

function buildRoundedAmountsFromQtyShares(
  qtyShares: bigint[],
  qtyScale: number,
  unitPriceInt: bigint,
  unitPriceScale: number,
  amtTarget: bigint,
  allocated: bigint[],
  packageTargets: bigint[]
): bigint[] {
  const amountCandidates = qtyShares.map(value => multiplyToScale(
    value,
    qtyScale,
    unitPriceInt,
    unitPriceScale,
    AMOUNT_OUTPUT_SCALE
  ));

  return reconcileAmountsByTargetDeviation(
    amountCandidates,
    amtTarget,
    allocated,
    packageTargets,
    1n
  );
}

function optimizeRoundedQtySharesForTargetDeviation(
  initialQtyShares: bigint[],
  qtyScale: number,
  unitPriceInt: bigint,
  unitPriceScale: number,
  amtTarget: bigint,
  allocated: bigint[],
  packageTargets: bigint[]
): { qtyShares: bigint[]; amountShares: bigint[] } {
  let bestQtyShares = initialQtyShares.slice();
  let bestAmountShares = buildRoundedAmountsFromQtyShares(
    bestQtyShares,
    qtyScale,
    unitPriceInt,
    unitPriceScale,
    amtTarget,
    allocated,
    packageTargets
  );
  let bestDeviation = calculateTotalDeviation(
    allocated.map((value, index) => value + bestAmountShares[index]),
    packageTargets
  );

  let improved = true;
  let iterations = 0;
  const maxIterations = Math.max(20, initialQtyShares.length * 20);

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations += 1;

    for (let sourceIndex = 0; sourceIndex < bestQtyShares.length; sourceIndex++) {
      if (bestQtyShares[sourceIndex] <= 1n) continue;

      for (let targetIndex = 0; targetIndex < bestQtyShares.length; targetIndex++) {
        if (sourceIndex === targetIndex) continue;

        const testQtyShares = bestQtyShares.slice();
        testQtyShares[sourceIndex] -= 1n;
        testQtyShares[targetIndex] += 1n;

        const testAmountShares = buildRoundedAmountsFromQtyShares(
          testQtyShares,
          qtyScale,
          unitPriceInt,
          unitPriceScale,
          amtTarget,
          allocated,
          packageTargets
        );
        const testDeviation = calculateTotalDeviation(
          allocated.map((value, index) => value + testAmountShares[index]),
          packageTargets
        );

        if (testDeviation < bestDeviation) {
          bestQtyShares = testQtyShares;
          bestAmountShares = testAmountShares;
          bestDeviation = testDeviation;
          improved = true;
          break;
        }
      }

      if (improved) break;
    }
  }

  return { qtyShares: bestQtyShares, amountShares: bestAmountShares };
}

interface FixedAmountRoundedRowInput {
  row: ExcelRow;
  contextLabel: string;
  amtTarget: bigint;
  qtyTarget: bigint;
  unitPriceInt: bigint;
  unitPriceScale: number;
}

interface FixedAmountRoundedRowPlan extends FixedAmountRoundedRowInput {
  qtyShares: bigint[];
  amountShares: bigint[];
}

interface GeneratedRowPlan {
  row: ExcelRow;
  contextLabel: string;
  amtTarget: bigint;
  qtyTarget: bigint;
  unitPriceInt: bigint;
  unitPriceScale: number;
  qtyShares: bigint[];
  amountShares: bigint[];
}

function materializeGeneratedRowPlans(
  rowPlans: GeneratedRowPlan[],
  qtyOutputScale: number
): SplitRow[] {
  const splitRows: SplitRow[] = [];

  for (const rowPlan of rowPlans) {
    for (let index = 0; index < rowPlan.qtyShares.length; index++) {
      const newRow: SplitRow = { ...rowPlan.row };
      newRow['分包名称'] = `包${index + 1}`;
      newRow['分包编号'] = `JS${(index + 1) * 100}`;
      newRow['估算总价（元）'] = bigIntToDecimalString(rowPlan.amountShares[index], AMOUNT_OUTPUT_SCALE);
      newRow['数量'] = bigIntToDecimalString(rowPlan.qtyShares[index], qtyOutputScale);
      splitRows.push(newRow);
    }
  }

  return splitRows;
}

function buildEqualRatioPackageGroups(
  config: FenbiaoConfig,
  templateMap: Map<string, RatioTemplate>
): number[][] {
  if (config.packageCount <= 1) return [];

  if (config.splitMethod === 'average') {
    return [Array.from({ length: config.packageCount }, (_, index) => index)];
  }

  if (config.splitMethod !== 'ratio' || !config.templateId) return [];

  const template = templateMap.get(config.templateId);
  if (!template) return [];

  const sortedRatios = [...template.ratios].sort((left, right) => right - left);
  const groups: number[][] = [];
  let currentGroup: number[] = [0];

  for (let index = 1; index < Math.min(sortedRatios.length, config.packageCount); index++) {
    if (sortedRatios[index] === sortedRatios[index - 1]) {
      currentGroup.push(index);
      continue;
    }
    if (currentGroup.length > 1) groups.push(currentGroup);
    currentGroup = [index];
  }

  if (currentGroup.length > 1) groups.push(currentGroup);
  return groups;
}

function getMicroAdjustmentSteps(qtyOutputScale: number, maxTransfer: bigint): bigint[] {
  if (maxTransfer <= 0n) return [];
  if (qtyOutputScale === 0) return [1n];

  const upperBound = maxTransfer > 5000n ? 5000n : maxTransfer;
  const steps: bigint[] = [];

  for (let delta = 1n; delta <= upperBound; delta += 1n) {
    if (delta <= 100n) {
      steps.push(delta);
      continue;
    }
    if (delta <= 1000n) {
      if (delta % 10n === 0n) steps.push(delta);
      continue;
    }
    if (delta % 50n === 0n) steps.push(delta);
  }

  if (steps[steps.length - 1] !== upperBound) {
    steps.push(upperBound);
  }

  return steps;
}

function buildAdjustmentPriorityOrder(length: number, primary: number, secondary: number, reverse = false): number[] {
  const ordered: number[] = [primary, secondary].filter((value, index, array) => array.indexOf(value) === index);
  const rest = Array.from({ length }, (_, index) => index).filter(index => !ordered.includes(index));
  if (reverse) rest.reverse();
  return [...ordered, ...rest];
}

function rebuildAmountSharesFromQtyShares(
  rowPlan: GeneratedRowPlan,
  qtyShares: bigint[],
  qtyOutputScale: number,
  favoredIndex: number,
  constrainedIndex: number
): bigint[] {
  const amountCandidates = qtyShares.map(value => multiplyToScale(
    value,
    qtyOutputScale,
    rowPlan.unitPriceInt,
    rowPlan.unitPriceScale,
    AMOUNT_OUTPUT_SCALE
  ));

  return reconcileIntegerValues(
    amountCandidates,
    rowPlan.amtTarget,
    buildAdjustmentPriorityOrder(amountCandidates.length, favoredIndex, constrainedIndex),
    buildAdjustmentPriorityOrder(amountCandidates.length, constrainedIndex, favoredIndex, true)
  );
}

function tryMicroAdjustPair(
  rowPlans: GeneratedRowPlan[],
  packageAmounts: bigint[],
  leftIndex: number,
  rightIndex: number,
  qtyOutputScale: number
): boolean {
  let bestCandidate: {
    rowPlan: GeneratedRowPlan;
    delta: bigint;
    nextQtyShares: bigint[];
    nextAmountShares: bigint[];
    nextGap: bigint;
    gapGain: bigint;
  } | null = null;

  for (const rowPlan of rowPlans) {
    const maxTransfer = rowPlan.qtyShares[rightIndex] - 1n;
    if (maxTransfer <= 0n) continue;

    const deltas = getMicroAdjustmentSteps(qtyOutputScale, maxTransfer);
    for (const delta of deltas) {
      if (rowPlan.qtyShares[rightIndex] <= delta) continue;

      const nextQtyShares = rowPlan.qtyShares.slice();
      nextQtyShares[leftIndex] += delta;
      nextQtyShares[rightIndex] -= delta;

      if (nextQtyShares[leftIndex] <= 0n || nextQtyShares[rightIndex] <= 0n) continue;

      const nextAmountShares = rebuildAmountSharesFromQtyShares(
        rowPlan,
        nextQtyShares,
        qtyOutputScale,
        leftIndex,
        rightIndex
      );

      const leftDelta = nextAmountShares[leftIndex] - rowPlan.amountShares[leftIndex];
      const rightDelta = nextAmountShares[rightIndex] - rowPlan.amountShares[rightIndex];
      const currentGap = packageAmounts[leftIndex] - packageAmounts[rightIndex];
      const nextGap = (packageAmounts[leftIndex] + leftDelta) - (packageAmounts[rightIndex] + rightDelta);
      if (nextGap <= currentGap) continue;

      const gapGain = nextGap - currentGap;
      if (
        !bestCandidate
        || delta < bestCandidate.delta
        || (delta === bestCandidate.delta && gapGain > bestCandidate.gapGain)
        || (delta === bestCandidate.delta && gapGain === bestCandidate.gapGain && nextGap > bestCandidate.nextGap)
      ) {
        bestCandidate = {
          rowPlan,
          delta,
          nextQtyShares,
          nextAmountShares,
          nextGap,
          gapGain
        };
      }

      break;
    }
  }

  if (!bestCandidate) return false;

  const previousAmountShares = bestCandidate.rowPlan.amountShares.slice();
  bestCandidate.rowPlan.qtyShares = bestCandidate.nextQtyShares;
  bestCandidate.rowPlan.amountShares = bestCandidate.nextAmountShares;
  packageAmounts[leftIndex] = packageAmounts[leftIndex]
    - previousAmountShares[leftIndex]
    + bestCandidate.nextAmountShares[leftIndex];
  packageAmounts[rightIndex] = packageAmounts[rightIndex]
    - previousAmountShares[rightIndex]
    + bestCandidate.nextAmountShares[rightIndex];

  for (let index = 0; index < packageAmounts.length; index++) {
    if (index === leftIndex || index === rightIndex) continue;
    packageAmounts[index] = packageAmounts[index]
      - previousAmountShares[index]
      + bestCandidate.nextAmountShares[index];
  }

  return true;
}

function applyFenbiaoGroupMicroAdjustments(
  fbName: string,
  rowPlans: GeneratedRowPlan[],
  packageAmounts: bigint[],
  packageGroups: number[][],
  qtyOutputScale: number
): string[] {
  const warnings: string[] = [];

  for (const group of packageGroups) {
    let guard = 0;
    let groupAdjustable = true;

    while (!isStrictlyDescendingBigInt(packageAmounts, group) && guard < 2000) {
      guard += 1;
      let adjusted = false;

      for (let index = 0; index < group.length - 1; index++) {
        const leftIndex = group[index];
        const rightIndex = group[index + 1];
        if (packageAmounts[leftIndex] > packageAmounts[rightIndex]) continue;
        if (!tryMicroAdjustPair(rowPlans, packageAmounts, leftIndex, rightIndex, qtyOutputScale)) {
          groupAdjustable = false;
          break;
        }
        adjusted = true;
        break;
      }

      if (!groupAdjustable) break;
      if (!adjusted) break;
    }

    if (!groupAdjustable || !isStrictlyDescendingBigInt(packageAmounts, group)) {
      warnings.push(
        `分标"${fbName}"中相同比例包组（${group.map(index => `包${index + 1}`).join('、')}）无法在保持各拆分数量大于0的前提下严格微调为小号包金额大于大号包，已保留当前拆分结果。`
      );
    }
  }

  return warnings;
}

function getPackagePriorityIndices(
  packageAmounts: bigint[],
  packageTargets: bigint[],
  mode: 'over' | 'under' | 'all'
): number[] {
  const indices = Array.from({ length: packageTargets.length }, (_, index) => index);
  return indices
    .filter(index => {
      const diff = packageAmounts[index] - packageTargets[index];
      if (mode === 'over') return diff > 0n;
      if (mode === 'under') return diff < 0n;
      return true;
    })
    .sort((left, right) => {
      const leftDiff = packageAmounts[left] - packageTargets[left];
      const rightDiff = packageAmounts[right] - packageTargets[right];

      if (mode === 'over') {
        if (rightDiff !== leftDiff) return Number(rightDiff - leftDiff);
      } else if (mode === 'under') {
        if (leftDiff !== rightDiff) return Number(leftDiff - rightDiff);
      } else {
        const leftAbs = absBigInt(leftDiff);
        const rightAbs = absBigInt(rightDiff);
        if (rightAbs !== leftAbs) return Number(rightAbs - leftAbs);
      }

      return left - right;
    });
}

function seedFixedAmountRoundedRowPlan(
  input: FixedAmountRoundedRowInput,
  packageTargets: bigint[],
  packageAllocated: bigint[],
  qtyOutputScale: number,
  isLastRow: boolean
): FixedAmountRoundedRowPlan {
  const amountWeightBasis = buildDynamicFixedAmountRowTargets(
    input.amtTarget,
    packageTargets,
    packageAllocated,
    isLastRow
  );
  const initialRoundedAmts = buildPositiveIntegerShares(
    input.amtTarget,
    amountWeightBasis,
    1n,
    '金额',
    input.contextLabel
  );
  const qtyWeightBasis = initialRoundedAmts.map(value => value > 0n ? value : 0n);
  const seededQtyShares = buildPositiveIntegerShares(
    input.qtyTarget,
    sumBigInt(qtyWeightBasis) > 0n ? qtyWeightBasis : packageTargets,
    1n,
    '数量',
    input.contextLabel
  );
  const optimized = optimizeRoundedQtySharesForTargetDeviation(
    seededQtyShares,
    qtyOutputScale,
    input.unitPriceInt,
    input.unitPriceScale,
    input.amtTarget,
    packageAllocated,
    packageTargets
  );

  return {
    ...input,
    qtyShares: optimized.qtyShares,
    amountShares: optimized.amountShares
  };
}

function improveFenbiaoFixedAmountRoundedPlans(
  rowPlans: FixedAmountRoundedRowPlan[],
  packageTargets: bigint[],
  packageAmounts: bigint[],
  qtyOutputScale: number
): void {
  let bestDeviation = calculateTotalDeviation(packageAmounts, packageTargets);
  let improved = true;
  let iterations = 0;
  const maxIterations = Math.max(50, rowPlans.length * packageTargets.length * 20);

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations += 1;

    const sourcePriority = getPackagePriorityIndices(packageAmounts, packageTargets, 'over');
    const targetPriority = getPackagePriorityIndices(packageAmounts, packageTargets, 'under');
    const fallbackPriority = getPackagePriorityIndices(packageAmounts, packageTargets, 'all');
    const sourceIndices = sourcePriority.length > 0 ? sourcePriority : fallbackPriority;
    const targetIndices = targetPriority.length > 0 ? targetPriority : fallbackPriority;

    for (const rowPlan of rowPlans) {
      const baseAllocated = packageAmounts.map((value, index) => value - rowPlan.amountShares[index]);

      for (const sourceIndex of sourceIndices) {
        if (rowPlan.qtyShares[sourceIndex] <= 1n) continue;

        for (const targetIndex of targetIndices) {
          if (sourceIndex === targetIndex) continue;

          const testQtyShares = rowPlan.qtyShares.slice();
          testQtyShares[sourceIndex] -= 1n;
          testQtyShares[targetIndex] += 1n;

          let testAmountShares: bigint[];
          try {
            testAmountShares = buildRoundedAmountsFromQtyShares(
              testQtyShares,
              qtyOutputScale,
              rowPlan.unitPriceInt,
              rowPlan.unitPriceScale,
              rowPlan.amtTarget,
              baseAllocated,
              packageTargets
            );
          } catch {
            continue;
          }

          const testPackageAmounts = baseAllocated.map(
            (value, index) => value + testAmountShares[index]
          );
          const testDeviation = calculateTotalDeviation(testPackageAmounts, packageTargets);

          if (testDeviation < bestDeviation) {
            rowPlan.qtyShares = testQtyShares;
            rowPlan.amountShares = testAmountShares;
            for (let index = 0; index < packageAmounts.length; index++) {
              packageAmounts[index] = testPackageAmounts[index];
            }
            bestDeviation = testDeviation;
            improved = true;
            break;
          }
        }

        if (improved) break;
      }

      if (improved) break;
    }
  }
}

function materializeFixedAmountRoundedRowPlans(
  rowPlans: FixedAmountRoundedRowPlan[],
  qtyOutputScale: number
): SplitRow[] {
  const splitRows: SplitRow[] = [];

  for (const rowPlan of rowPlans) {
    assertRoundedSum(
      rowPlan.amountShares,
      rowPlan.amtTarget,
      AMOUNT_OUTPUT_SCALE,
      '金额',
      rowPlan.contextLabel
    );
    assertRoundedSum(
      rowPlan.qtyShares,
      rowPlan.qtyTarget,
      qtyOutputScale,
      '数量',
      rowPlan.contextLabel
    );

    if (rowPlan.amountShares.some(value => value <= 0n)) {
      throw new Error(`${rowPlan.contextLabel}取整拆分后的金额存在 0 或负数，无法与非零数量保持一致`);
    }
    if (rowPlan.qtyShares.some(value => value <= 0n)) {
      throw new Error(`${rowPlan.contextLabel}取整拆分后的数量存在 0 或负数，请减少分包数量或调整原始数据`);
    }

    for (let index = 0; index < rowPlan.qtyShares.length; index++) {
      const newRow: SplitRow = { ...rowPlan.row };
      newRow['分包名称'] = `包${index + 1}`;
      newRow['分包编号'] = `JS${(index + 1) * 100}`;
      newRow['估算总价（元）'] = bigIntToDecimalString(rowPlan.amountShares[index], AMOUNT_OUTPUT_SCALE);
      newRow['数量'] = bigIntToDecimalString(rowPlan.qtyShares[index], qtyOutputScale);
      splitRows.push(newRow);
    }
  }

  return splitRows;

  return splitRows;
}

export class SplitExecutionError extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(`共发现 ${reasons.length} 个无法执行拆分的原因`);
    this.name = 'SplitExecutionError';
    this.reasons = reasons;
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
): SplitExecutionResult {
  const configMap = new Map(configs.map(c => [c.name, c]));
  const templateMap = new Map(templates.map(t => [t.id, t]));
  const result: SplitRow[] = [];
  const executionErrors: string[] = [];
  const executionWarnings: string[] = [];

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
    let hasFenbiaoLevelError = false;
    for (const row of preAllocRows) {
      const match = PKG_NAME_PATTERN.exec(String(row['分包名称']).trim())!;
      const pkgNum = parseInt(match[1]);
      if (pkgNum < 1 || pkgNum > n) {
        executionErrors.push(
          `分标"${fbName}"中预分配行的包号"包${pkgNum}"超出范围（最大包${n}）`
        );
        hasFenbiaoLevelError = true;
      }
    }
    if (hasFenbiaoLevelError) {
      continue;
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
    // 待拆行按“逐行独立拆分”处理。
    // 对 fixedAmount + rounded，预分配行金额会先计入各包已分配金额，再参与剩余预算计算。
    const preAllocatedByPackage = Array.from({ length: n }, () => 0n);
    for (const row of preAllocRows) {
      const match = PKG_NAME_PATTERN.exec(String(row['分包名称']).trim())!;
      const pkgNum = parseInt(match[1]);
      const preAllocatedAmountInt = decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale);
      preAllocatedByPackage[pkgNum - 1] += roundBigIntToScale(preAllocatedAmountInt, amountScale, AMOUNT_OUTPUT_SCALE);
    }
    const rowAmountsInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '估算总价（元）'), amountScale)
    );
    const rowQtysInt = toSplitRows.map(
      row => decimalToBigInt(getNormalizedDecimal(row, '数量'), qtyScale)
    );
    const totalRoundedAmount = sumBigInt(preAllocatedByPackage) + rowAmountsInt.reduce(
      (sum, value) => sum + roundBigIntToScale(value, amountScale, AMOUNT_OUTPUT_SCALE),
      0n
    );
    let fixedAmountRoundedTargets: bigint[] | null = null;
    try {
      fixedAmountRoundedTargets = method === 'fixedAmount' && config.fixedAmounts && config.splitScope === 'rounded'
        ? buildFixedAmountTargets(
            totalRoundedAmount,
            config.fixedAmounts
          )
        : null;
    } catch (error) {
      executionErrors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (fixedAmountRoundedTargets) {
      const rowInputs: FixedAmountRoundedRowInput[] = [];
      const fenbiaoErrors: string[] = [];

      for (let rowIdx = 0; rowIdx < toSplitRows.length; rowIdx++) {
        const row = toSplitRows[rowIdx];
        const contextLabel = `分标"${fbName}"第${rowIdx + 1}条待拆行：`;

        try {
          if (getDecimalScale(getNormalizedDecimal(row, '数量')) > 0) {
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

          const amtTarget = roundBigIntToScale(rowAmountInt, amountScale, AMOUNT_OUTPUT_SCALE);
          const qtyTarget = roundBigIntToScale(rowQtyInt, qtyScale, qtyOutputScale);
          if (amtTarget > 0n && qtyTarget === 0n) {
            throw new Error(`${contextLabel}金额大于 0 但数量为 0，无法满足数量与金额一致性`);
          }

          rowInputs.push({
            row,
            contextLabel,
            amtTarget,
            qtyTarget,
            unitPriceInt,
            unitPriceScale
          });
        } catch (error) {
          fenbiaoErrors.push(error instanceof Error ? error.message : String(error));
        }
      }

      if (fenbiaoErrors.length > 0) {
        executionErrors.push(...fenbiaoErrors);
        continue;
      }

      try {
        const packageAmounts = preAllocatedByPackage.slice();
        const rowPlans = rowInputs.map((input, rowIdx) => {
          const plan = seedFixedAmountRoundedRowPlan(
            input,
            fixedAmountRoundedTargets!,
            packageAmounts,
            qtyOutputScale,
            rowIdx === rowInputs.length - 1
          );
          for (let index = 0; index < packageAmounts.length; index++) {
            packageAmounts[index] += plan.amountShares[index];
          }
          return plan;
        });

        improveFenbiaoFixedAmountRoundedPlans(
          rowPlans,
          fixedAmountRoundedTargets,
          packageAmounts,
          qtyOutputScale
        );

        result.push(...materializeFixedAmountRoundedRowPlans(rowPlans, qtyOutputScale));
      } catch (error) {
        executionErrors.push(error instanceof Error ? error.message : String(error));
      }

      continue;
    }
    const fixedAmountRoundedAllocated = fixedAmountRoundedTargets
      ? preAllocatedByPackage.slice()
      : null;
    const generatedRowPlans: GeneratedRowPlan[] = [];

    for (let rowIdx = 0; rowIdx < toSplitRows.length; rowIdx++) {
      try {
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
        let roundedQtys: bigint[];
        let roundedAmts: bigint[];

        if (useFixedAmountRoundedOptimization) {
          const seededQtyShares = buildPositiveIntegerShares(
            qtyTarget,
            sumBigInt(qtyWeightBasis) > 0n ? qtyWeightBasis : fixedAmountRoundedTargets!,
            1n,
            '数量',
            contextLabel
          );
          const optimized = optimizeRoundedQtySharesForTargetDeviation(
            seededQtyShares,
            qtyOutputScale,
            unitPriceInt,
            unitPriceScale,
            amtTarget,
            fixedAmountRoundedAllocated!,
            fixedAmountRoundedTargets!
          );
          roundedQtys = optimized.qtyShares;
          roundedAmts = optimized.amountShares;
        } else {
          roundedQtys = config.splitScope === 'rounded'
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
          roundedAmts = config.splitScope === 'rounded'
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
        }

        if (useFixedAmountRoundedOptimization) {
          for (let index = 0; index < fixedAmountRoundedAllocated!.length; index++) {
            fixedAmountRoundedAllocated![index] += roundedAmts[index];
          }
        }

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

        generatedRowPlans.push({
          row,
          contextLabel,
          amtTarget,
          qtyTarget,
          unitPriceInt,
          unitPriceScale,
          qtyShares: roundedQtys,
          amountShares: roundedAmts
        });
      } catch (error) {
        executionErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (generatedRowPlans.length > 0) {
      if (method === 'average' || method === 'ratio') {
        const packageAmounts = preAllocatedByPackage.slice();
        generatedRowPlans.forEach((rowPlan) => {
          rowPlan.amountShares.forEach((value, index) => {
            packageAmounts[index] += value;
          });
        });
        const packageGroups = buildEqualRatioPackageGroups(config, templateMap);
        executionWarnings.push(
          ...applyFenbiaoGroupMicroAdjustments(
            fbName,
            generatedRowPlans,
            packageAmounts,
            packageGroups,
            qtyOutputScale
          )
        );
      }

      result.push(...materializeGeneratedRowPlans(generatedRowPlans, qtyOutputScale));
    }
  }

  if (executionErrors.length > 0) {
    throw new SplitExecutionError(executionErrors);
  }

  return { rows: result, warnings: executionWarnings };
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
