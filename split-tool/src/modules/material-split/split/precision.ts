/**
 * 精度拆分算法模块
 * 兼容两套口径：
 * 1. 旧逻辑：金额 ×10000、数量 ×1000000 的 number 整数运算
 * 2. 新逻辑：任意小数位的十进制字符串 + BigInt 精确运算
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

/** 标准化十进制字符串，去除无意义前后缀 0 */
export function normalizeDecimalString(value: unknown): string | null {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!raw) return null;
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2].replace(/^0+(?=\d)/, '') || '0';
  const fractionPart = (match[3] ?? '').replace(/0+$/, '');
  if (integerPart === '0' && fractionPart === '') return '0';
  return fractionPart ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;
}

/** 获取十进制字符串的小数位数 */
export function getDecimalScale(value: string): number {
  const normalized = normalizeDecimalString(value) ?? '0';
  const dotIndex = normalized.indexOf('.');
  return dotIndex >= 0 ? normalized.length - dotIndex - 1 : 0;
}

/** 求一组十进制字符串中的最大小数位数 */
export function getMaxDecimalScale(values: string[]): number {
  return values.reduce((maxScale, value) => Math.max(maxScale, getDecimalScale(value)), 0);
}

/** 十进制字符串转指定 scale 的 BigInt 整数 */
export function decimalToBigInt(value: string, scale: number): bigint {
  const normalized = normalizeDecimalString(value);
  if (normalized == null) throw new Error(`无效十进制数值: ${value}`);
  const negative = normalized.startsWith('-');
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [integerPart, fractionPart = ''] = unsigned.split('.');
  if (fractionPart.length > scale) {
    throw new Error(`数值 ${value} 的小数位数超过 scale=${scale}`);
  }
  const digits = `${integerPart}${fractionPart.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '') || '0';
  const intValue = BigInt(digits);
  return negative ? -intValue : intValue;
}

/** BigInt 整数转十进制字符串 */
export function bigIntToDecimalString(value: bigint, scale: number): string {
  const negative = value < 0n;
  const absValue = negative ? -value : value;
  const digits = absValue.toString().padStart(scale + 1, '0');
  const integerPart = scale > 0 ? digits.slice(0, -scale) || '0' : digits;
  const fractionPart = scale > 0 ? digits.slice(-scale).replace(/0+$/, '') : '';
  const result = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  return negative && result !== '0' ? `-${result}` : result;
}

/** 比较两个十进制字符串大小 */
export function compareDecimalStrings(left: string, right: string): number {
  const leftNormalized = normalizeDecimalString(left) ?? '0';
  const rightNormalized = normalizeDecimalString(right) ?? '0';
  const leftNegative = leftNormalized.startsWith('-');
  const rightNegative = rightNormalized.startsWith('-');
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;

  const scale = Math.max(getDecimalScale(leftNormalized), getDecimalScale(rightNormalized));
  const leftInt = decimalToBigInt(leftNormalized, scale);
  const rightInt = decimalToBigInt(rightNormalized, scale);
  if (leftInt === rightInt) return 0;
  return leftInt > rightInt ? 1 : -1;
}

/** 十进制字符串绝对值 */
export function absDecimalString(value: string): string {
  const normalized = normalizeDecimalString(value) ?? '0';
  return normalized.startsWith('-') ? normalized.slice(1) : normalized;
}

/** 判断十进制字符串的绝对值是否小于阈值 */
export function isDecimalAbsLessThan(value: string, threshold: string): boolean {
  return compareDecimalStrings(absDecimalString(value), absDecimalString(threshold)) < 0;
}

/** 判断金额序列是否满足前包金额严格大于后包金额 */
export function isStrictlyDescendingDecimalStrings(values: string[]): boolean {
  for (let index = 0; index < values.length - 1; index++) {
    if (compareDecimalStrings(values[index], values[index + 1]) <= 0) {
      return false;
    }
  }
  return true;
}

/** 十进制字符串加法 */
export function addDecimalStrings(left: string, right: string): string {
  const leftNormalized = normalizeDecimalString(left) ?? '0';
  const rightNormalized = normalizeDecimalString(right) ?? '0';
  const scale = Math.max(getDecimalScale(leftNormalized), getDecimalScale(rightNormalized));
  const sum = decimalToBigInt(leftNormalized, scale) + decimalToBigInt(rightNormalized, scale);
  return bigIntToDecimalString(sum, scale);
}

/** 十进制字符串减法 */
export function subtractDecimalStrings(left: string, right: string): string {
  const rightNormalized = normalizeDecimalString(right) ?? '0';
  return addDecimalStrings(left, rightNormalized === '0' ? '0' : rightNormalized.startsWith('-') ? rightNormalized.slice(1) : `-${rightNormalized}`);
}

/** 十进制字符串求和 */
export function sumDecimalStrings(values: string[]): string {
  return values.reduce((sum, value) => addDecimalStrings(sum, value), '0');
}

/** 按比例拆分 BigInt 总量 */
export function splitBigIntByRatio(total: bigint, ratios: Array<number | bigint>): bigint[] {
  const ratioInts = ratios.map(r => typeof r === 'bigint' ? r : BigInt(Math.round(r)));
  const ratioSum = ratioInts.reduce((sum, value) => sum + value, 0n);
  if (ratioSum === 0n) return ratioInts.map(() => 0n);
  const results = ratioInts.map(ratio => total * ratio / ratioSum);
  let remainder = total - results.reduce((sum, value) => sum + value, 0n);
  for (let index = 0; index < results.length && remainder > 0n; index++) {
    results[index] += 1n;
    remainder -= 1n;
  }
  return results;
}

/** 平均拆分 BigInt 总量 */
export function splitAverageBigInt(total: bigint, n: number): bigint[] {
  const divisor = BigInt(n);
  const base = total / divisor;
  let remainder = total % divisor;
  return Array.from({ length: n }, () => {
    const value = remainder > 0n ? base + 1n : base;
    if (remainder > 0n) remainder -= 1n;
    return value;
  });
}

/** 调整数组最后一项，使 BigInt 总和严格等于目标值 */
export function adjustLastBigIntItem(items: bigint[], target: bigint): void {
  if (items.length === 0) return;
  const sumOfRest = items.slice(0, -1).reduce((sum, value) => sum + value, 0n);
  items[items.length - 1] = target - sumOfRest;
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
