import { AppState, FenbiaoConfig, SplitMethod } from '../types';
import { isIntegerDecimalString } from '../split/precision';

const STATE_KEY = 'split_tool_app_state';

/** 初始状态 */
export function createInitialState(): AppState {
  return {
    importResult: null,
    fenbiaoConfigs: [],
    globalSplitMethod: 'average',
    splitResult: null,
    splitWarnings: [],
    previewSummary: null
  };
}

/** 保存状态快照到 sessionStorage */
export function saveStateSnapshot(state: AppState): void {
  try {
    // 只保存配置，不保存大数据
    const snapshot = {
      fenbiaoConfigs: state.fenbiaoConfigs,
      globalSplitMethod: state.globalSplitMethod
    };
    sessionStorage.setItem(STATE_KEY, JSON.stringify(snapshot));
  } catch { /* ignore quota errors */ }
}

/** 恢复状态快照 */
export function restoreStateSnapshot(): Partial<AppState> | null {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 根据分标名称列表创建初始配置 */
export function createFenbiaoConfigs(
  names: string[],
  globalMethod: SplitMethod,
  exactFenbiaoQtyTotals: Record<string, string> = {}
): FenbiaoConfig[] {
  return names.map(name => ({
    name,
    packageCount: 0,
    splitScope: isIntegerDecimalString(exactFenbiaoQtyTotals[name] ?? '0') ? 'rounded' : 'decimal',
    splitMethod: globalMethod,
    overridden: false,
    requestScopeOverrides: {}
  }));
}

export function cloneFenbiaoConfig(config: FenbiaoConfig): FenbiaoConfig {
  return {
    ...config,
    fixedAmounts: config.fixedAmounts ? [...config.fixedAmounts] : undefined,
    requestScopeOverrides: config.requestScopeOverrides ? { ...config.requestScopeOverrides } : {}
  };
}

export function cloneFenbiaoConfigs(configs: FenbiaoConfig[]): FenbiaoConfig[] {
  return configs.map(cloneFenbiaoConfig);
}

/** 更新全局拆分方式，同步未覆盖的标段 */
export function updateGlobalMethod(
  configs: FenbiaoConfig[],
  method: SplitMethod
): FenbiaoConfig[] {
  return configs.map(c => c.overridden ? c : { ...c, splitMethod: method });
}
