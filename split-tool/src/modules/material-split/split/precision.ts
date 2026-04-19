/**
 * 精度拆分算法模块
 * 所有金额内部以"分"（×100）表示，数量以 ×1000000 表示，避免浮点误差
 */

/** 将元转换为分（整数） */
export function yuanToFen(yuan: number): number {
  return Math.round(yuan * 100);
}

/** 将分转换为元（2位小数） */
export function fenToYuan(fen: number): number {
  return fen / 100;
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
 * 按比例拆分整数值
 * @param total 总量（整数）
 * @param ratios 各包比例（万分比，总和应为 10000）
 * @returns 各包分配量（整数），总和严格等于 total
 */
export function splitByRatio(total: number, ratios: number[]): number[] {
  const n = ratios.length;
  const ratioSum = ratios.reduce((a, b) => a + b, 0);
  const results = ratios.map(r => Math.floor(total * r / ratioSum));
  let remainder = total - results.reduce((a, b) => a + b, 0);
  // 余数按序号从小到大逐个补 1
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
 * @param amounts 各包指定金额（整数），已知总和等于分标总金额
 * @param amountSum 各包金额总和（整数）
 * @returns 各包分配量
 */
export function splitByFixedAmounts(total: number, amounts: number[], amountSum: number): number[] {
  if (amountSum === 0) return amounts.map(() => 0);
  // 将指定金额转换为万分比
  const ratios = amounts.map(a => Math.round(a * 10000 / amountSum));
  return splitByRatio(total, ratios);
}
