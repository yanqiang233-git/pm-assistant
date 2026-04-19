/**
 * 精度拆分算法模块
 * 所有金额内部以 ×10000 表示（支持4位小数），数量以 ×1000000 表示，避免浮点误差
 * splitByRatio 内部使用 BigInt 防止中间乘法溢出
 */

/** 将元转换为整数（×10000） */
export function yuanToInt(yuan: number): number {
  return Math.round(yuan * 10000);
}

/** 将整数转换为元 */
export function intToYuan(n: number): number {
  return n / 10000;
}

/** 将数量转换为整数（×1000000） */
export function qtyToInt(qty: number): number {
  return Math.round(qty * 1000000);
}

/** 将整数转换回数量 */
export function intToQty(n: number): number {
  return n / 1000000;
}

/**
 * 按比例拆分整数值（使用 BigInt 防止中间乘法溢出）
 * @param total 总量（整数）
 * @param ratios 各包比例（整数，相对大小即可）
 * @returns 各包分配量（整数），总和严格等于 total
 */
export function splitByRatio(total: number, ratios: number[]): number[] {
  const n = ratios.length;
  const ratioSum = ratios.reduce((a, b) => a + b, 0);
  if (ratioSum === 0) return ratios.map(() => 0);
  const totalBig = BigInt(Math.round(total));
  const ratioSumBig = BigInt(Math.round(ratioSum));
  const results = ratios.map(r => Number(totalBig * BigInt(Math.round(r)) / ratioSumBig));
  let remainder = total - results.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n && remainder > 0; i++) {
    results[i]++;
    remainder--;
  }
  return results;
}

/**
 * 平均拆分整数值
 * @param total 总量（整数）
 * @param n 份数
 * @returns 各包分配量，总和严格等于 total
 */
export function splitAverage(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * 按指定金额比例拆分（指定金额模式）
 * @param total 总量（整数）
 * @param amounts 各包指定金额（整数），作为比例权重
 * @returns 各包分配量
 */
export function splitByFixedAmounts(total: number, amounts: number[]): number[] {
  const amountSum = amounts.reduce((a, b) => a + b, 0);
  if (amountSum === 0) return amounts.map(() => 0);
  return splitByRatio(total, amounts);
}

/**
 * 调整数组最后一项，使总和严格等于目标值
 * @param items 数值数组（将被原地修改）
 * @param target 目标总和
 */
export function adjustLastItem(items: number[], target: number): void {
  if (items.length === 0) return;
  const sumOfRest = items.slice(0, -1).reduce((a, b) => a + b, 0);
  items[items.length - 1] = target - sumOfRest;
}
