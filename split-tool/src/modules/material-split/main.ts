import { readAndValidate, readAndValidateBuffer } from './excel/reader';
import { exportToXlsx, exportPackageComparisonToXlsx, downloadConfigTemplate, downloadSourceTemplate, readConfigTemplate, downloadSplitConfigTemplate, readSplitConfigTemplate } from './excel/writer';
import { executeSplit, generatePreviewSummary, SplitExecutionError } from './split/engine';
import {
  loadTemplates, saveTemplates, addTemplate, updateTemplate,
  deleteTemplate, setDefaultTemplate, getDefaultTemplate,
  getTemplatesByCount, generateId
} from './template/manager';
import { parseSingleColumnPaste, parseTwoColumnPaste } from './config/paste';
import { createInitialState, createFenbiaoConfigs, updateGlobalMethod, saveStateSnapshot, cloneFenbiaoConfigs } from './store/state';
import {
  compareDecimalStrings,
  getDecimalScale,
  normalizeDecimalString,
  subtractDecimalStrings,
  sumDecimalStrings,
  toFixedDecimalString
} from './split/precision';
import {
  ensureModuleDirs,
  mirrorImportFile, mirrorTemplate, mirrorUploadedTemplate, mirrorExportResult,
  saveModuleState, loadModuleState, loadLatestImportFile
} from '../../shared/store/project-files';
import type {
  AppState, FenbiaoConfig, SplitMethod, RatioTemplate,
  SplitScope,
  ImportResult, PasteResult, ExcelRow, PurchaseRequestScopeItem, ResolveRowSplitScope
} from './types';
import { PKG_NAME_PATTERN } from './types';

const SPLIT_SCOPE_LABELS: Record<SplitScope, string> = {
  rounded: '取整拆分',
  decimal: '小数拆分'
};

function getSplitScopeLabel(scope: SplitScope): string {
  return SPLIT_SCOPE_LABELS[scope];
}

function getRequestScopeBadgeClass(scope: 'inherit' | SplitScope): string {
  return scope === 'inherit' ? 'inherit' : scope;
}

function getRequestScopeDisplayLabel(scope: 'inherit' | SplitScope): string {
  return scope === 'inherit' ? '继承分标默认' : getSplitScopeLabel(scope);
}

function cloneConfigs(configs: FenbiaoConfig[]): FenbiaoConfig[] {
  return cloneFenbiaoConfigs(configs);
}

function isPendingSplitRow(row: ExcelRow): boolean {
  const pkgName = String(row['分包名称'] ?? '').trim();
  return !pkgName || !PKG_NAME_PATTERN.test(pkgName);
}

function getRequestNo(row: ExcelRow): string {
  return String(row['网省采购申请号'] ?? '').trim();
}

function getMaterialDescription(row: ExcelRow): string {
  return String(row['物资描述'] ?? row['物资名称'] ?? '').trim();
}

function getUnitLabel(row: ExcelRow): string {
  return String(row['计量单位'] ?? '').trim();
}

function getQuantityLabel(row: ExcelRow): string {
  return normalizeDecimalString(row['数量']) ?? String(row['数量'] ?? '');
}

function getFenbiaoConfigByName(name: string): FenbiaoConfig | undefined {
  return state.fenbiaoConfigs.find(config => config.name === name);
}

const resolveEffectiveSplitScope: ResolveRowSplitScope = (row, config) => {
  const targetConfig = config ?? getFenbiaoConfigByName(String(row['分标名称'] ?? '').trim());
  if (!targetConfig) return 'decimal';
  const requestNo = getRequestNo(row);
  return requestNo && targetConfig.requestScopeOverrides?.[requestNo]
    ? targetConfig.requestScopeOverrides[requestNo]
    : targetConfig.splitScope;
};

function getRequestScopeItems(fenbiaoName: string): PurchaseRequestScopeItem[] {
  if (!state.importResult?.success) return [];
  return state.importResult.rows
    .filter(row => String(row['分标名称'] ?? '').trim() === fenbiaoName)
    .filter(isPendingSplitRow)
    .map(row => ({
      fenbiaoName,
      requestNo: getRequestNo(row),
      materialDescription: getMaterialDescription(row),
      unit: getUnitLabel(row),
      quantity: getQuantityLabel(row)
    }))
    .filter(item => item.requestNo)
    .sort((left, right) => left.requestNo.localeCompare(right.requestNo, 'zh-CN'));
}

function getRequestFilterState(fenbiaoName: string): { unit: string; keyword: string } {
  return requestScopeFilters.get(fenbiaoName) ?? { unit: '', keyword: '' };
}

function setRequestFilterState(fenbiaoName: string, patch: Partial<{ unit: string; keyword: string }>): void {
  const current = getRequestFilterState(fenbiaoName);
  requestScopeFilters.set(fenbiaoName, {
    unit: patch.unit ?? current.unit,
    keyword: patch.keyword ?? current.keyword
  });
}

function getFilteredRequestScopeItems(config: FenbiaoConfig): PurchaseRequestScopeItem[] {
  const filterState = getRequestFilterState(config.name);
  const keyword = filterState.keyword.trim().toLowerCase();
  return getRequestScopeItems(config.name).filter(item => {
    const unitMatched = !filterState.unit || item.unit === filterState.unit;
    const keywordMatched = !keyword || item.materialDescription.toLowerCase().includes(keyword);
    return unitMatched && keywordMatched;
  });
}

function getFilteredFenbiaoConfigs(configs: FenbiaoConfig[]): FenbiaoConfig[] {
  const keyword = requestScopeFenbiaoKeyword.trim().toLowerCase();
  if (!keyword) return configs;
  return configs.filter(config => config.name.toLowerCase().includes(keyword));
}

function isRequestFenbiaoExpanded(fenbiaoName: string): boolean {
  return expandedRequestFenbiaos.has(fenbiaoName);
}

function setRequestScopeSectionExpanded(expanded: boolean): void {
  requestScopeSectionExpanded = expanded;
  btnToggleRequestScope.textContent = expanded ? '收起' : '展开';
  requestScopeToolbar.classList.toggle('hidden', !expanded);
  requestScopeContent.classList.toggle('hidden', !expanded);
}

function setFenbiaoSplitScope(configIdx: number, nextScope: SplitScope, promptSyncOverrides: boolean): void {
  const config = state.fenbiaoConfigs[configIdx];
  if (!config || config.splitScope === nextScope) return;

  const overrideKeys = Object.keys(config.requestScopeOverrides ?? {});
  const nextConfig: FenbiaoConfig = {
    ...config,
    splitScope: nextScope,
    requestScopeOverrides: { ...(config.requestScopeOverrides ?? {}) }
  };

  if (promptSyncOverrides && overrideKeys.length > 0) {
    const shouldSync = confirm(
      `分标“${config.name}”下已有 ${overrideKeys.length} 条采购申请级覆盖。\n\n是否将这些已覆盖项同步为“${getSplitScopeLabel(nextScope)}”？\n\n确定：同步已覆盖项\n取消：仅修改分标默认，保留已覆盖项`
    );
    if (shouldSync) {
      nextConfig.requestScopeOverrides = Object.fromEntries(
        overrideKeys.map(requestNo => [requestNo, nextScope])
      );
    }
  }

  state.fenbiaoConfigs[configIdx] = nextConfig;
}

function setRequestScopeOverride(fenbiaoName: string, requestNo: string, nextValue: 'inherit' | SplitScope): void {
  const idx = state.fenbiaoConfigs.findIndex(config => config.name === fenbiaoName);
  if (idx < 0) return;
  const config = state.fenbiaoConfigs[idx];
  const overrides = { ...(config.requestScopeOverrides ?? {}) };
  if (nextValue === 'inherit') {
    delete overrides[requestNo];
  } else {
    overrides[requestNo] = nextValue;
  }
  state.fenbiaoConfigs[idx] = {
    ...config,
    requestScopeOverrides: overrides
  };
}

function applyBatchRequestScope(fenbiaoName: string, nextValue: 'inherit' | SplitScope): void {
  const config = getFenbiaoConfigByName(fenbiaoName);
  if (!config) return;
  const matchedItems = getFilteredRequestScopeItems(config);
  if (matchedItems.length === 0) {
    alert(`分标“${fenbiaoName}”当前筛选条件下没有可批量调整的采购申请。`);
    return;
  }

  matchedItems.forEach(item => {
    setRequestScopeOverride(fenbiaoName, item.requestNo, nextValue);
  });
  renderRequestScopeAdjustments();
  clearPreview();
  persistModuleState();
}

// ============ State ============
let state: AppState = createInitialState();
let initialConfigs: FenbiaoConfig[] = []; // for reset
const requestScopeFilters = new Map<string, { unit: string; keyword: string }>();
const expandedRequestFenbiaos = new Set<string>();
let requestScopeSectionExpanded = false;
let requestScopeFenbiaoKeyword = '';

// ============ DOM refs ============
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('fileInput');
const btnImport = $('btnImport');
const btnDownloadSourceTpl = $('btnDownloadSourceTpl');
const importStatus = $('importStatus');
const importInfo = $('importInfo');
const importErrors = $('importErrors');

const sectionPkgConfig = $('section-pkg-config');
const pkgConfigStatus = $('pkgConfigStatus');
const totalFenbiaoEl = $('totalFenbiao');
const configuredCountEl = $('configuredCount');
const totalPackagesEl = $('totalPackages');
const errorCountEl = $('errorCount');
const pkgTableBody = $('pkgTableBody');
const pasteResultEl = $('pasteResult');
const btnPasteSingle = $('btnPasteSingle');
const btnPasteTwoCol = $('btnPasteTwoCol');
const btnDownloadTpl = $('btnDownloadTpl');
const btnImportTpl = $('btnImportTpl');
const tplFileInput = $<HTMLInputElement>('tplFileInput');
const btnResetPkg = $('btnResetPkg');

const sectionSplitMethod = $('section-split-method');
const splitMethodStatus = $('splitMethodStatus');
const globalMethodSelect = $<HTMLSelectElement>('globalMethodSelect');
const splitTableBody = $('splitTableBody');
const btnDownloadSplitTpl = $('btnDownloadSplitTpl');
const btnImportSplitTpl = $('btnImportSplitTpl');
const splitTplFileInput = $<HTMLInputElement>('splitTplFileInput');
const splitImportResult = $('splitImportResult');

const sectionRequestScope = $('section-request-scope');
const btnToggleRequestScope = $('btnToggleRequestScope');
const requestScopeStatus = $('requestScopeStatus');
const requestScopeToolbar = $('requestScopeToolbar');
const requestScopeContent = $('requestScopeContent');
const requestScopeFenbiaoFilter = $<HTMLInputElement>('requestScopeFenbiaoFilter');
const btnExpandRequestPanels = $('btnExpandRequestPanels');
const btnCollapseRequestPanels = $('btnCollapseRequestPanels');
const requestScopeSummary = $('requestScopeSummary');
const requestScopeEmpty = $('requestScopeEmpty');
const requestScopePanels = $('requestScopePanels');

const sectionTemplate = $('section-template');
const templateGroups = $('templateGroups');
const btnAddTemplate = $('btnAddTemplate');

const sectionPreview = $('section-preview');
const previewStatus = $('previewStatus');
const btnExecuteSplit = $('btnExecuteSplit');
const previewErrors = $('previewErrors');
const previewSummary = $('previewSummary');
const previewTableHead = $('previewTableHead');
const previewTableBody = $('previewTableBody');
const previewPagination = $('previewPagination');

const sectionExport = $('section-export');
const exportStatus = $('exportStatus');
const exportSummaryEl = $('exportSummary');
const btnExportComparison = $('btnExportComparison');
const btnExport = $('btnExport');

// Paste modal
const pasteModal = $('pasteModal');
const pasteModalTitle = $('pasteModalTitle');
const pasteModalHint = $('pasteModalHint');
const pasteTextarea = $<HTMLTextAreaElement>('pasteTextarea');
const pasteModalOk = $('pasteModalOk');
const pasteModalCancel = $('pasteModalCancel');
const pasteModalClose = $('pasteModalClose');

// Template modal
const templateModal = $('templateModal');
const tplModalTitle = $('tplModalTitle');
const tplPkgCount = $<HTMLInputElement>('tplPkgCount');
const tplName = $<HTMLInputElement>('tplName');
const tplIsDefault = $<HTMLInputElement>('tplIsDefault');
const tplRatioInputs = $('tplRatioInputs');
const tplRatioSum = $('tplRatioSum');
const tplModalOk = $('tplModalOk');
const tplModalCancel = $('tplModalCancel');
const tplModalClose = $('tplModalClose');

// Fixed amount modal
const fixedAmountModal = $('fixedAmountModal');
const fixedAmountTitle = $('fixedAmountTitle');
const fixedAmountHint = $('fixedAmountHint');
const fixedAmountInputs = $('fixedAmountInputs');
const fixedAmountSum = $('fixedAmountSum');
const fixedAmountTarget = $('fixedAmountTarget');

function showPreviewError(reasons: string | string[], title = '无法执行拆分并预览'): void {
  const normalizedReasons = Array.isArray(reasons) ? reasons : [reasons];
  previewErrors.innerHTML = `<h4>${esc(title)}</h4><ul>${normalizedReasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>`;
  previewErrors.classList.remove('hidden');
  previewStatus.textContent = '执行失败';
  previewStatus.className = 'status-badge error';
  exportStatus.textContent = '待预览';
  exportStatus.className = 'status-badge';
}

function clearPreviewError(): void {
  previewErrors.innerHTML = '';
  previewErrors.classList.add('hidden');
}
const fixedAmountDiff = $('fixedAmountDiff');
const fixedAmountOk = $('fixedAmountOk');
const fixedAmountCancel = $('fixedAmountCancel');
const fixedAmountClose = $('fixedAmountClose');

btnToggleRequestScope.addEventListener('click', () => {
  setRequestScopeSectionExpanded(!requestScopeSectionExpanded);
});

requestScopeFenbiaoFilter.addEventListener('input', () => {
  requestScopeFenbiaoKeyword = requestScopeFenbiaoFilter.value;
  renderRequestScopeAdjustments();
});

btnExpandRequestPanels.addEventListener('click', () => {
  getFilteredFenbiaoConfigs(state.fenbiaoConfigs.filter(config => config.packageCount >= 1)).forEach(config => {
    expandedRequestFenbiaos.add(config.name);
  });
  renderRequestScopeAdjustments();
});

btnCollapseRequestPanels.addEventListener('click', () => {
  expandedRequestFenbiaos.clear();
  renderRequestScopeAdjustments();
});

setRequestScopeSectionExpanded(false);

// ============ Import ============
btnImport.addEventListener('click', () => fileInput.click());
btnDownloadSourceTpl.addEventListener('click', async () => {
  await downloadSourceTemplate();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  importStatus.textContent = '读取中...';
  importStatus.className = 'status-badge warning';
  const result = await readAndValidate(file);
  state.importResult = result;
  renderImportResult(result);
  if (result.success) {
    mirrorImportFile(file);
    persistModuleState();
  }
  fileInput.value = '';
});

function renderImportResult(r: ImportResult) {
  if (r.success) {
    importStatus.textContent = '校验通过';
    importStatus.className = 'status-badge success';
    importInfo.innerHTML = `
      <strong>文件：</strong>${esc(r.fileName)} &nbsp;|&nbsp;
      <strong>数据行数：</strong>${r.totalRows} &nbsp;|&nbsp;
      <strong>唯一分标数：</strong>${r.fenbiaoNames.length}${r.preAllocatedCount > 0 ? ` &nbsp;|&nbsp; <strong>预分配行数：</strong>${r.preAllocatedCount}` : ''}
    `;
    importInfo.classList.remove('hidden');
    importErrors.classList.add('hidden');
    // 初始化分标配置
    state.fenbiaoConfigs = createFenbiaoConfigs(r.fenbiaoNames, state.globalSplitMethod, r.exactFenbiaoQtyTotals);
    initialConfigs = cloneConfigs(state.fenbiaoConfigs);
    enableModule(sectionPkgConfig);
    enableModule(sectionSplitMethod);
    enableModule(sectionRequestScope);
    enableModule(sectionPreview);
    enableModule(sectionExport);
    renderPkgConfig();
    renderSplitMethod();
    renderRequestScopeAdjustments();
    updatePkgSummary();
  } else {
    importStatus.textContent = '校验失败';
    importStatus.className = 'status-badge error';
    importInfo.classList.add('hidden');
    let html = '';
    for (const e of r.errors) {
      html += `<h4>${esc(e.message)}</h4>`;
      if (e.details?.length) {
        html += '<ul>' + e.details.map(d => `<li>${esc(d)}</li>`).join('') + '</ul>';
      }
    }
    importErrors.innerHTML = html;
    importErrors.classList.remove('hidden');
    disableModule(sectionPkgConfig);
    disableModule(sectionSplitMethod);
    disableModule(sectionRequestScope);
    disableModule(sectionPreview);
    disableModule(sectionExport);
  }
}

// ============ Package Config ============
function renderPkgConfig() {
  const configs = state.fenbiaoConfigs;
  let html = '';
  configs.forEach((c, i) => {
    const errClass = c.packageCount < 1 ? 'row-error' : '';
    const statusText = c.packageCount >= 1 ? '✓' : '未填';
    const splitScopeOptions = Object.entries(SPLIT_SCOPE_LABELS).map(([value, label]) =>
      `<option value="${value}" ${c.splitScope === value ? 'selected' : ''}>${label}</option>`
    ).join('');
    html += `<tr class="${errClass}">
      <td class="col-idx" style="text-align:center">${i + 1}</td>
      <td class="col-name">${esc(c.name)}</td>
      <td class="col-count"><input type="number" min="1" value="${c.packageCount || ''}" data-idx="${i}" class="pkg-count-input" /></td>
      <td class="col-method"><select data-idx="${i}" class="pkg-scope-select">${splitScopeOptions}</select></td>
      <td class="col-status">${statusText}</td>
    </tr>`;
  });
  pkgTableBody.innerHTML = html;

  // bind input events
  pkgTableBody.querySelectorAll('.pkg-count-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement;
      const idx = parseInt(el.dataset.idx!);
      const val = parseInt(el.value, 10);
      if (!isNaN(val) && val >= 1) {
        state.fenbiaoConfigs[idx].packageCount = val;
        el.closest('tr')!.classList.remove('row-error');
        el.closest('tr')!.querySelector('.col-status')!.textContent = '✓';
      } else {
        state.fenbiaoConfigs[idx].packageCount = 0;
        el.closest('tr')!.classList.add('row-error');
        el.closest('tr')!.querySelector('.col-status')!.textContent = '未填';
      }
      updatePkgSummary();
      renderSplitMethod();
      renderRequestScopeAdjustments();
      clearPreview();
      persistModuleState();
    });
  });
  pkgTableBody.querySelectorAll('.pkg-scope-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      const idx = parseInt(el.dataset.idx!);
      setFenbiaoSplitScope(idx, el.value as SplitScope, true);
      renderSplitMethod();
      renderRequestScopeAdjustments();
      clearPreview();
      persistModuleState();
    });
  });
}

function updatePkgSummary() {
  const configs = state.fenbiaoConfigs;
  const total = configs.length;
  const configured = configs.filter(c => c.packageCount >= 1).length;
  const totalPkg = configs.reduce((s, c) => s + (c.packageCount >= 1 ? c.packageCount : 0), 0);
  const errors = total - configured;
  totalFenbiaoEl.textContent = String(total);
  configuredCountEl.textContent = String(configured);
  totalPackagesEl.textContent = String(totalPkg);
  errorCountEl.textContent = String(errors);
  pkgConfigStatus.textContent = configured === total ? '已完成' : `${configured}/${total}`;
  pkgConfigStatus.className = 'status-badge ' + (configured === total ? 'success' : 'warning');
}

// ============ Paste handlers ============
let pasteMode: 'single' | 'two' = 'single';
btnPasteSingle.addEventListener('click', () => openPasteModal('single'));
btnPasteTwoCol.addEventListener('click', () => openPasteModal('two'));

function openPasteModal(mode: 'single' | 'two') {
  pasteMode = mode;
  pasteTextarea.value = '';
  if (mode === 'single') {
    pasteModalTitle.textContent = '粘贴单列分包数量';
    pasteModalHint.textContent = `请从 Excel 复制单列分包数量数据粘贴到下方。将按当前升序排列的 ${state.fenbiaoConfigs.length} 个分标依次填充。`;
  } else {
    pasteModalTitle.textContent = '粘贴两列匹配（分标名称 + 分包数量）';
    pasteModalHint.textContent = '请从 Excel 复制两列数据（分标名称 \\t 分包数量）粘贴到下方。系统将按分标名称严格匹配。';
  }
  pasteModal.classList.remove('hidden');
  pasteTextarea.focus();
}

function closePasteModal() { pasteModal.classList.add('hidden'); }
pasteModalCancel.addEventListener('click', closePasteModal);
pasteModalClose.addEventListener('click', closePasteModal);

pasteModalOk.addEventListener('click', () => {
  const text = pasteTextarea.value;
  if (!text.trim()) { closePasteModal(); return; }
  let result: PasteResult;
  if (pasteMode === 'single') {
    const parsed = parseSingleColumnPaste(text, state.fenbiaoConfigs);
    state.fenbiaoConfigs = parsed.configs;
    result = parsed.result;
  } else {
    const parsed = parseTwoColumnPaste(text, state.fenbiaoConfigs);
    state.fenbiaoConfigs = parsed.configs;
    result = parsed.result;
  }
  closePasteModal();
  showPasteResult(result);
  renderPkgConfig();
  updatePkgSummary();
  renderSplitMethod();
  renderRequestScopeAdjustments();
  clearPreview();
  persistModuleState();
});

function showPasteResult(r: PasteResult) {
  let cls = 'ok';
  let lines: string[] = [`识别 ${r.totalParsed} 行，成功填充 ${r.successCount} 行`];
  if (r.failCount > 0) {
    cls = 'warn';
    lines.push(`失败 ${r.failCount} 行`);
  }
  if (r.rowDiff != null && r.rowDiff !== 0) {
    cls = 'warn';
    lines.push(r.rowDiff > 0 ? `多出 ${r.rowDiff} 行被忽略` : `缺少 ${Math.abs(r.rowDiff)} 行未填充`);
  }
  if (r.unmatchedNames?.length) {
    cls = 'err';
    lines.push(`未匹配分标: ${r.unmatchedNames.join(', ')}`);
  }
  if (r.duplicateNames?.length) {
    cls = 'err';
    lines.push(`重复分标: ${r.duplicateNames.join(', ')}`);
  }
  if (r.invalidValues?.length) {
    lines.push(`非法值: ${r.invalidValues.map(v => `第${v.line}行"${v.value}"`).join(', ')}`);
  }
  pasteResultEl.className = `paste-result ${cls}`;
  pasteResultEl.innerHTML = lines.map(l => `<div>${esc(l)}</div>`).join('');
  pasteResultEl.classList.remove('hidden');
}

// ============ Template download/import ============
btnDownloadTpl.addEventListener('click', async () => {
  if (!state.importResult) return;
  const buf = await downloadConfigTemplate(state.fenbiaoConfigs);
  mirrorTemplate(buf, 'pkg');
});

btnImportTpl.addEventListener('click', () => tplFileInput.click());
tplFileInput.addEventListener('change', async () => {
  const file = tplFileInput.files?.[0];
  if (!file) return;
  try {
    const data = await readConfigTemplate(file);
    const parsed = parseTwoColumnPaste(
      data.map(d => `${d.name}\t${d.count ?? ''}`).join('\n'),
      state.fenbiaoConfigs
    );
    const scopeMap = new Map(data.map(item => [item.name, item.splitScope]));
    state.fenbiaoConfigs = parsed.configs.map(config => {
      const splitScope = scopeMap.get(config.name);
      return splitScope
        ? { ...config, splitScope, requestScopeOverrides: config.requestScopeOverrides ?? {} }
        : { ...config, requestScopeOverrides: config.requestScopeOverrides ?? {} };
    });
    const roundedErrors = collectRoundedScopeErrors(state.importResult!, state.fenbiaoConfigs, resolveEffectiveSplitScope);
    if (roundedErrors.length > 0) {
      showPasteResult({
        totalParsed: data.length,
        successCount: 0,
        failCount: roundedErrors.length,
        unmatchedNames: [],
        invalidValues: roundedErrors.slice(0, 20).map((message, index) => ({ line: index + 1, value: message }))
      });
      state.fenbiaoConfigs = cloneConfigs(initialConfigs);
      renderPkgConfig();
      updatePkgSummary();
      renderSplitMethod();
      renderRequestScopeAdjustments();
      clearPreview();
      tplFileInput.value = '';
      return;
    }
    showPasteResult(parsed.result);
    renderPkgConfig();
    updatePkgSummary();
    renderSplitMethod();
    renderRequestScopeAdjustments();
    clearPreview();
    mirrorUploadedTemplate(file, 'pkg');
    persistModuleState();
  } catch (err) {
    showPasteResult({
      totalParsed: 0, successCount: 0, failCount: 0,
      unmatchedNames: [], invalidValues: [{ line: 0, value: String(err) }]
    });
  }
  tplFileInput.value = '';
});

btnResetPkg.addEventListener('click', () => {
  state.fenbiaoConfigs = cloneConfigs(initialConfigs);
  renderPkgConfig();
  updatePkgSummary();
  renderSplitMethod();
  renderRequestScopeAdjustments();
  clearPreview();
  pasteResultEl.classList.add('hidden');
});

// ============ Split Method ============
globalMethodSelect.addEventListener('change', () => {
  const method = globalMethodSelect.value as SplitMethod;
  state.globalSplitMethod = method;
  state.fenbiaoConfigs = updateGlobalMethod(state.fenbiaoConfigs, method);
  renderSplitMethod();
  renderRequestScopeAdjustments();
  clearPreview();
  persistModuleState();
});

function renderSplitMethod() {
  const configs = state.fenbiaoConfigs;
  const templates = loadTemplates();
  let html = '';
  configs.forEach((c, i) => {
    if (c.packageCount < 1) return;
    const overClass = c.overridden ? 'row-overridden' : '';
    const methodOptions = ['average', 'ratio', 'fixedAmount'].map(m => {
      const label = m === 'average' ? '平均分' : m === 'ratio' ? '比例模板' : '参考金额';
      return `<option value="${m}" ${c.splitMethod === m ? 'selected' : ''}>${label}</option>`;
    }).join('');

    let tplInfo = '-';
    if (c.splitMethod === 'ratio') {
      const defaultTpl = c.templateId
        ? templates.find(t => t.id === c.templateId)
        : getDefaultTemplate(c.packageCount);
      if (defaultTpl) {
        tplInfo = `${esc(defaultTpl.name)} (${defaultTpl.ratios.map(r => (r / 100).toFixed(1) + '%').join(':')})`;
        if (!c.templateId) {
          state.fenbiaoConfigs[i].templateId = defaultTpl.id;
        }
      } else {
        tplInfo = '<span style="color:var(--color-danger)">未配置默认模板</span>';
      }
    } else if (c.splitMethod === 'fixedAmount') {
      if (c.fixedAmounts?.length) {
        tplInfo = c.fixedAmounts.join(' + ');
      } else {
        tplInfo = '<span style="color:var(--color-warning)">待配置</span>';
      }
    }

    html += `<tr class="${overClass}">
      <td style="text-align:center">${i + 1}</td>
      <td>${esc(c.name)}</td>
      <td style="text-align:center">${c.packageCount}</td>
      <td style="text-align:center">${getSplitScopeLabel(c.splitScope)}</td>
      <td><select class="method-select" data-idx="${i}">${methodOptions}</select></td>
      <td>${tplInfo}</td>
      <td style="text-align:center">${c.overridden ? '⚡' : ''}</td>
      <td>
        ${c.splitMethod === 'ratio' ? `<button class="btn btn-sm choose-tpl-btn" data-idx="${i}">选模板</button>` : ''}
        ${c.splitMethod === 'fixedAmount' ? `<button class="btn btn-sm set-amount-btn" data-idx="${i}">设金额</button>` : ''}
        ${c.overridden ? `<button class="btn btn-sm btn-danger reset-override-btn" data-idx="${i}" title="恢复全局">↺</button>` : ''}
      </td>
    </tr>`;
  });
  splitTableBody.innerHTML = html;

  // Check all configs ready
  const allReady = configs.every(c => {
    if (c.packageCount < 1) return false;
    if (c.splitMethod === 'ratio' && !c.templateId) return false;
    if (c.splitMethod === 'fixedAmount' && !c.fixedAmounts?.length) return false;
    return true;
  });
  splitMethodStatus.textContent = allReady ? '已就绪' : '待配置';
  splitMethodStatus.className = 'status-badge ' + (allReady ? 'success' : 'warning');

  // Bind events
  splitTableBody.querySelectorAll('.method-select').forEach(el => {
    el.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      const idx = parseInt(select.dataset.idx!);
      const method = select.value as SplitMethod;
      state.fenbiaoConfigs[idx].splitMethod = method;
      state.fenbiaoConfigs[idx].overridden = true;
      state.fenbiaoConfigs[idx].templateId = undefined;
      state.fenbiaoConfigs[idx].fixedAmounts = undefined;
      if (method === 'ratio') {
        const dt = getDefaultTemplate(state.fenbiaoConfigs[idx].packageCount);
        if (dt) state.fenbiaoConfigs[idx].templateId = dt.id;
      }
      renderSplitMethod();
      clearPreview();
      persistModuleState();
    });
  });
  splitTableBody.querySelectorAll('.reset-override-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx!);
      state.fenbiaoConfigs[idx].overridden = false;
      state.fenbiaoConfigs[idx].splitMethod = state.globalSplitMethod;
      state.fenbiaoConfigs[idx].templateId = undefined;
      state.fenbiaoConfigs[idx].fixedAmounts = undefined;
      if (state.globalSplitMethod === 'ratio') {
        const dt = getDefaultTemplate(state.fenbiaoConfigs[idx].packageCount);
        if (dt) state.fenbiaoConfigs[idx].templateId = dt.id;
      }
      renderSplitMethod();
      clearPreview();
      persistModuleState();
    });
  });
  splitTableBody.querySelectorAll('.choose-tpl-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx!);
      openTemplateChooser(idx);
    });
  });
  splitTableBody.querySelectorAll('.set-amount-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const idx = parseInt((e.target as HTMLElement).dataset.idx!);
      openFixedAmountModal(idx);
    });
  });
}

function renderRequestScopeAdjustments(): void {
  const configs = state.fenbiaoConfigs.filter(config => config.packageCount >= 1);
  const filteredConfigs = getFilteredFenbiaoConfigs(configs);
  const totalRequests = configs.reduce((sum, config) => sum + getRequestScopeItems(config.name).length, 0);
  const totalOverrides = configs.reduce((sum, config) => sum + Object.keys(config.requestScopeOverrides ?? {}).length, 0);

  if (!state.importResult?.success) {
    requestScopeStatus.textContent = '待导入';
    requestScopeStatus.className = 'status-badge';
    requestScopeFenbiaoFilter.value = requestScopeFenbiaoKeyword;
    requestScopeSummary.classList.add('hidden');
    requestScopeEmpty.classList.add('hidden');
    requestScopePanels.innerHTML = '';
    return;
  }

  if (configs.length === 0) {
    requestScopeStatus.textContent = '待配置';
    requestScopeStatus.className = 'status-badge warning';
    requestScopeFenbiaoFilter.value = requestScopeFenbiaoKeyword;
    requestScopeSummary.classList.add('hidden');
    requestScopeEmpty.textContent = '请先完成分包数量配置，再按分标默认口径查看和调整采购申请级拆分方式。';
    requestScopeEmpty.classList.remove('hidden');
    requestScopePanels.innerHTML = '';
    return;
  }

  requestScopeStatus.textContent = totalOverrides > 0 ? `已覆盖 ${totalOverrides}` : '可调整';
  requestScopeStatus.className = 'status-badge ' + (totalOverrides > 0 ? 'success' : 'warning');
  requestScopeSummary.innerHTML = `
    <span>已配置分标: <strong>${configs.length}</strong></span>
    <span>待拆采购申请: <strong>${totalRequests}</strong></span>
    <span>已覆盖采购申请: <strong>${totalOverrides}</strong></span>
  `;
  requestScopeFenbiaoFilter.value = requestScopeFenbiaoKeyword;
  requestScopeSummary.classList.remove('hidden');
  requestScopeEmpty.classList.toggle('hidden', filteredConfigs.length > 0);

  if (filteredConfigs.length === 0) {
    requestScopeEmpty.textContent = requestScopeFenbiaoKeyword.trim()
      ? `未找到匹配“${requestScopeFenbiaoKeyword.trim()}”的分标。`
      : '当前没有可调整的分标。';
    requestScopePanels.innerHTML = '';
    return;
  }

  let html = '';
  filteredConfigs.forEach(config => {
    const items = getRequestScopeItems(config.name);
    const filterState = getRequestFilterState(config.name);
    const filteredItems = getFilteredRequestScopeItems(config);
    const units = [...new Set(items.map(item => item.unit).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
    const overrideCount = Object.keys(config.requestScopeOverrides ?? {}).length;
    const panelExpanded = isRequestFenbiaoExpanded(config.name);
    const rowsHtml = filteredItems.length > 0
      ? filteredItems.map(item => {
          const overrideValue = config.requestScopeOverrides?.[item.requestNo];
          const effectiveScope = overrideValue ?? config.splitScope;
          return `<tr>
            <td class="request-mono">${esc(item.requestNo)}</td>
            <td>${esc(item.materialDescription || '-')}</td>
            <td>${esc(item.unit || '-')}</td>
            <td>${esc(item.quantity || '-')}</td>
            <td><span class="request-scope-badge ${getRequestScopeBadgeClass(overrideValue ? overrideValue : 'inherit')}">${esc(getRequestScopeDisplayLabel(overrideValue ? overrideValue : 'inherit'))}</span></td>
            <td><span class="request-scope-badge ${getRequestScopeBadgeClass(effectiveScope)}">${esc(getSplitScopeLabel(effectiveScope))}</span></td>
            <td>
              <select class="request-scope-select" data-fenbiao="${esc(config.name)}" data-request-no="${esc(item.requestNo)}">
                <option value="inherit" ${overrideValue ? '' : 'selected'}>继承分标默认</option>
                <option value="rounded" ${overrideValue === 'rounded' ? 'selected' : ''}>取整拆分</option>
                <option value="decimal" ${overrideValue === 'decimal' ? 'selected' : ''}>小数拆分</option>
              </select>
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="7" style="text-align:center;color:var(--color-text-secondary)">当前筛选条件下无匹配采购申请</td></tr>';

    html += `<div class="request-scope-panel ${panelExpanded ? '' : 'is-collapsed'}">
      <div class="request-scope-panel-header">
        <div class="request-scope-panel-title">
          <button class="btn btn-sm request-scope-panel-toggle" data-toggle-fenbiao="${esc(config.name)}">${panelExpanded ? '收起' : '展开'}</button>
          <strong>${esc(config.name)}</strong>
          <span class="request-scope-badge ${getRequestScopeBadgeClass(config.splitScope)}">默认：${esc(getSplitScopeLabel(config.splitScope))}</span>
        </div>
        <div class="request-scope-panel-meta">
          <span>采购申请数：${items.length}</span>
          <span>已覆盖：${overrideCount}</span>
          <span>筛选命中：${filteredItems.length}</span>
        </div>
      </div>
      <div class="request-scope-panel-body">
      <div class="request-filter-bar">
        <div class="request-filter-control">
          <label>单位筛选</label>
          <select class="request-unit-filter" data-fenbiao="${esc(config.name)}">
            <option value="">全部单位</option>
            ${units.map(unit => `<option value="${esc(unit)}" ${filterState.unit === unit ? 'selected' : ''}>${esc(unit)}</option>`).join('')}
          </select>
        </div>
        <div class="request-filter-control">
          <label>物料描述筛选</label>
          <input type="text" class="request-keyword-filter" data-fenbiao="${esc(config.name)}" value="${esc(filterState.keyword)}" placeholder="输入物料描述关键字后筛选并批量调整" />
        </div>
        <div class="request-batch-actions">
          <button class="btn btn-sm" data-batch-scope="rounded" data-fenbiao="${esc(config.name)}">筛选结果批量设为取整</button>
          <button class="btn btn-sm" data-batch-scope="decimal" data-fenbiao="${esc(config.name)}">筛选结果批量设为小数</button>
          <button class="btn btn-sm btn-danger" data-batch-scope="inherit" data-fenbiao="${esc(config.name)}">筛选结果恢复继承</button>
        </div>
      </div>
      <div class="config-table-wrap request-table-wrap">
        <table class="config-table request-scope-table">
          <thead>
            <tr>
              <th>网省采购申请号</th>
              <th>物料描述</th>
              <th>单位</th>
              <th>数量</th>
              <th>覆盖状态</th>
              <th>当前生效口径</th>
              <th>调整方式</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
      </div>
    </div>`;
  });

  requestScopePanels.innerHTML = html;

  requestScopePanels.querySelectorAll('.request-unit-filter').forEach(element => {
    element.addEventListener('change', event => {
      const select = event.target as HTMLSelectElement;
      setRequestFilterState(select.dataset.fenbiao!, { unit: select.value });
      renderRequestScopeAdjustments();
    });
  });

  requestScopePanels.querySelectorAll('.request-keyword-filter').forEach(element => {
    element.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      setRequestFilterState(input.dataset.fenbiao!, { keyword: input.value });
      renderRequestScopeAdjustments();
    });
  });

  requestScopePanels.querySelectorAll('[data-batch-scope]').forEach(element => {
    element.addEventListener('click', event => {
      const button = event.target as HTMLButtonElement;
      applyBatchRequestScope(button.dataset.fenbiao!, button.dataset.batchScope as 'inherit' | SplitScope);
    });
  });

  requestScopePanels.querySelectorAll('.request-scope-select').forEach(element => {
    element.addEventListener('change', event => {
      const select = event.target as HTMLSelectElement;
      setRequestScopeOverride(select.dataset.fenbiao!, select.dataset.requestNo!, select.value as 'inherit' | SplitScope);
      renderRequestScopeAdjustments();
      clearPreview();
      persistModuleState();
    });
  });

  requestScopePanels.querySelectorAll('[data-toggle-fenbiao]').forEach(element => {
    element.addEventListener('click', event => {
      const button = event.target as HTMLButtonElement;
      const fenbiaoName = button.dataset.toggleFenbiao!;
      if (expandedRequestFenbiaos.has(fenbiaoName)) {
        expandedRequestFenbiaos.delete(fenbiaoName);
      } else {
        expandedRequestFenbiaos.add(fenbiaoName);
      }
      renderRequestScopeAdjustments();
    });
  });
}

// ============ Split Config Template download/import ============

btnDownloadSplitTpl.addEventListener('click', async () => {
  if (!state.importResult) return;
  const validConfigs = state.fenbiaoConfigs.filter(c => c.packageCount >= 1);
  if (validConfigs.length === 0) {
    alert('请先配置分包数量');
    return;
  }
  const templates = loadTemplates();
  const buf = await downloadSplitConfigTemplate(
    validConfigs,
    state.globalSplitMethod,
    templates,
    state.importResult.exactFenbiaoAmountTotals
  );
  mirrorTemplate(buf, 'split');
});

btnImportSplitTpl.addEventListener('click', () => splitTplFileInput.click());
splitTplFileInput.addEventListener('change', async () => {
  const file = splitTplFileInput.files?.[0];
  if (!file) return;
  const importResult = state.importResult;
  if (!importResult) {
    splitTplFileInput.value = '';
    return;
  }
  const fenbiaoNames = state.fenbiaoConfigs.filter(c => c.packageCount >= 1).map(c => c.name);
  if (fenbiaoNames.length === 0) {
    alert('请先配置分包数量');
    splitTplFileInput.value = '';
    return;
  }
  const result = await readSplitConfigTemplate(
    file,
    fenbiaoNames,
    importResult.exactFenbiaoAmountTotals,
    state.fenbiaoConfigs
  );

  if (!result.success) {
    splitTplFileInput.value = '';
    splitImportResult.className = 'paste-result err';
    splitImportResult.innerHTML = `<div><strong>导入失败，共 ${result.errors.length} 项错误：</strong></div>` +
      result.errors.map(e => `<div>• ${esc(e)}</div>`).join('');
    splitImportResult.classList.remove('hidden');
    return;
  }

  // 校验全部通过，应用配置
  for (const r of result.rows) {
    const idx = state.fenbiaoConfigs.findIndex(c => c.name === r.name);
    if (idx < 0) continue;
    setFenbiaoSplitScope(idx, r.splitScope, false);
    state.fenbiaoConfigs[idx].requestScopeOverrides = state.fenbiaoConfigs[idx].requestScopeOverrides ?? {};
    state.fenbiaoConfigs[idx].splitMethod = r.method;
    state.fenbiaoConfigs[idx].overridden = true;
    state.fenbiaoConfigs[idx].templateId = undefined;
    state.fenbiaoConfigs[idx].fixedAmounts = undefined;

    if (r.method === 'ratio') {
      // 创建或查找匹配的模板
      const existing = loadTemplates().find(t =>
        t.packageCount === r.packageCount &&
        t.ratios.length === (r.ratioValues?.length ?? 0) &&
        t.ratios.every((v, i) => Math.abs(v - (r.ratioValues?.[i] ?? 0)) <= 1)
      );
      if (existing) {
        state.fenbiaoConfigs[idx].templateId = existing.id;
      } else {
        const newTpl = {
          id: generateId(),
          name: `导入-${r.name}`,
          packageCount: r.packageCount,
          ratios: r.ratioValues ?? [],
          isDefault: false
        };
        addTemplate(newTpl);
        state.fenbiaoConfigs[idx].templateId = newTpl.id;
      }
    } else if (r.method === 'fixedAmount') {
      state.fenbiaoConfigs[idx].fixedAmounts = r.amountValues;
    }
    // average 不需要额外数据
  }

  splitImportResult.className = 'paste-result ok';
  splitImportResult.innerHTML = `<div>导入成功！已读取 ${result.rows.length} 个标段的拆分配置</div>` +
    result.notices.map(message => `<div>• ${esc(message)}</div>`).join('');
  splitImportResult.classList.remove('hidden');
  mirrorUploadedTemplate(file, 'split');
  persistModuleState();
  splitTplFileInput.value = '';
  renderSplitMethod();
  renderRequestScopeAdjustments();
  renderTemplateManagement();
  clearPreview();
});

// ============ Template chooser (inline) ============
function openTemplateChooser(configIdx: number) {
  const config = state.fenbiaoConfigs[configIdx];
  const tpls = getTemplatesByCount(config.packageCount);
  if (tpls.length === 0) {
    alert(`尚未为 ${config.packageCount} 包配置比例模板，请先在"比例模板管理"模块中新增。`);
    return;
  }
  const names = tpls.map((t, i) =>
    `${i + 1}. ${t.name} (${t.ratios.map(r => (r / 100).toFixed(1) + '%').join(':')})${t.isDefault ? ' [默认]' : ''}`
  ).join('\n');
  const choice = prompt(`选择模板序号（1-${tpls.length}）：\n\n${names}`);
  if (choice) {
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < tpls.length) {
      state.fenbiaoConfigs[configIdx].templateId = tpls[idx].id;
      renderSplitMethod();
      clearPreview();
      persistModuleState();
    }
  }
}

// ============ Fixed Amount Modal ============
let fixedAmountConfigIdx = -1;

function openFixedAmountModal(configIdx: number) {
  fixedAmountConfigIdx = configIdx;
  const config = state.fenbiaoConfigs[configIdx];
  const totalExact = state.importResult?.exactFenbiaoAmountTotals[config.name] ?? '0';

  fixedAmountTitle.textContent = `${config.name} - 设置每包参考金额`;
  fixedAmountHint.textContent = `请为 ${config.packageCount} 个包分别设置参考金额；取整拆分时系统会折算为目标包金额并尽量贴近，原分标总额 ${totalExact} 元仅供参考`;
  fixedAmountTarget.textContent = totalExact;

  let html = '';
  for (let i = 0; i < config.packageCount; i++) {
    const existing = config.fixedAmounts?.[i] ?? '';
    html += `<div class="fa-row"><label>包${i + 1}：</label><input type="text" inputmode="decimal" class="fa-input" value="${existing}" /> 元</div>`;
  }
  fixedAmountInputs.innerHTML = html;
  updateFixedAmountSum();
  fixedAmountInputs.querySelectorAll('.fa-input').forEach(el => {
    el.addEventListener('input', updateFixedAmountSum);
  });
  fixedAmountModal.classList.remove('hidden');
}

function updateFixedAmountSum() {
  const inputs = fixedAmountInputs.querySelectorAll('.fa-input') as NodeListOf<HTMLInputElement>;
  const values = Array.from(inputs, inp => normalizeDecimalString(inp.value) ?? '0');
  const sum = sumDecimalStrings(values);
  const target = fixedAmountTarget.textContent || '0';
  const diff = subtractDecimalStrings(sum, target);
  fixedAmountSum.textContent = sum;
  fixedAmountDiff.textContent = diff;
  fixedAmountDiff.style.color = compareDecimalStrings(diff, '0') === 0 ? 'var(--color-success)' : 'var(--color-warning)';
}

function closeFixedAmountModal() { fixedAmountModal.classList.add('hidden'); }
fixedAmountCancel.addEventListener('click', closeFixedAmountModal);
fixedAmountClose.addEventListener('click', closeFixedAmountModal);
fixedAmountOk.addEventListener('click', () => {
  const inputs = fixedAmountInputs.querySelectorAll('.fa-input') as NodeListOf<HTMLInputElement>;
  const target = fixedAmountTarget.textContent || '0';
  const amounts: string[] = [];
  for (const input of Array.from(inputs)) {
    const normalized = normalizeDecimalString(input.value);
    if (normalized == null || normalized.startsWith('-')) {
      alert(`金额输入无效：${input.value || '(空)'}`);
      return;
    }
    amounts.push(normalized);
  }
  const sum = sumDecimalStrings(amounts);
  const diff = subtractDecimalStrings(sum, target);
  if (compareDecimalStrings(diff, '0') !== 0) {
    console.info(`参考金额总和 ${sum} 与分标总额 ${target} 存在差额 ${diff} 元，系统将按比例折算为目标包金额后尽量贴近`);
  }
  state.fenbiaoConfigs[fixedAmountConfigIdx].fixedAmounts = amounts;
  closeFixedAmountModal();
  renderSplitMethod();
  clearPreview();
  persistModuleState();
});

// ============ Template Management ============
let editingTemplateId: string | null = null;

function renderTemplateManagement() {
  const templates = loadTemplates();
  if (templates.length === 0) {
    templateGroups.innerHTML = '<div class="no-templates">暂无模板，请新增</div>';
    return;
  }
  // Group by packageCount
  const groups = new Map<number, RatioTemplate[]>();
  templates.forEach(t => {
    if (!groups.has(t.packageCount)) groups.set(t.packageCount, []);
    groups.get(t.packageCount)!.push(t);
  });
  const sortedKeys = [...groups.keys()].sort((a, b) => a - b);
  let html = '';
  for (const count of sortedKeys) {
    const tpls = groups.get(count)!;
    html += `<div class="tpl-group">
      <div class="tpl-group-header"><span>${count} 包模板</span><span>${tpls.length} 套</span></div>
      <div class="tpl-list">`;
    for (const t of tpls) {
      const ratioStr = t.ratios.map(r => (r / 100).toFixed(1) + '%').join(' : ');
      html += `<div class="tpl-item">
        <span class="tpl-name">${esc(t.name)}</span>
        <span class="tpl-ratios">${ratioStr}</span>
        ${t.isDefault ? '<span class="tpl-default-badge">默认</span>' : ''}
        <span class="tpl-actions">
          ${!t.isDefault ? `<button class="btn btn-sm set-default-btn" data-id="${t.id}">设为默认</button>` : ''}
          <button class="btn btn-sm edit-tpl-btn" data-id="${t.id}">编辑</button>
          <button class="btn btn-sm btn-danger del-tpl-btn" data-id="${t.id}">删除</button>
        </span>
      </div>`;
    }
    html += '</div></div>';
  }
  templateGroups.innerHTML = html;

  // Bind
  templateGroups.querySelectorAll('.set-default-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      setDefaultTemplate((e.target as HTMLElement).dataset.id!);
      renderTemplateManagement();
      renderSplitMethod();
    });
  });
  templateGroups.querySelectorAll('.edit-tpl-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).dataset.id!;
      const tpl = loadTemplates().find(t => t.id === id);
      if (tpl) openTemplateModal(tpl);
    });
  });
  templateGroups.querySelectorAll('.del-tpl-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).dataset.id!;
      if (confirm('确定删除此模板？')) {
        deleteTemplate(id);
        renderTemplateManagement();
        renderSplitMethod();
      }
    });
  });
}

btnAddTemplate.addEventListener('click', () => openTemplateModal(null));

function openTemplateModal(tpl: RatioTemplate | null) {
  editingTemplateId = tpl?.id ?? null;
  tplModalTitle.textContent = tpl ? '编辑比例模板' : '新增比例模板';
  tplPkgCount.value = String(tpl?.packageCount ?? 2);
  tplName.value = tpl?.name ?? '';
  tplIsDefault.checked = tpl?.isDefault ?? false;
  if (!tpl) {
    tplPkgCount.disabled = false;
  } else {
    tplPkgCount.disabled = true;
  }
  renderRatioInputs(tpl?.packageCount ?? 2, tpl?.ratios);
  templateModal.classList.remove('hidden');
}

function closeTemplateModal() { templateModal.classList.add('hidden'); }
tplModalCancel.addEventListener('click', closeTemplateModal);
tplModalClose.addEventListener('click', closeTemplateModal);

tplPkgCount.addEventListener('change', () => {
  renderRatioInputs(parseInt(tplPkgCount.value) || 2);
});

function renderRatioInputs(count: number, ratios?: number[]) {
  let html = '';
  for (let i = 0; i < count; i++) {
    const val = ratios?.[i] != null ? (ratios[i] / 100).toFixed(1) : '';
    html += `<div class="ratio-input-group">包${i + 1}: <input type="number" step="0.1" class="ratio-val" value="${val}" /> %</div>`;
  }
  tplRatioInputs.innerHTML = html;
  tplRatioInputs.querySelectorAll('.ratio-val').forEach(el => {
    el.addEventListener('input', updateRatioSum);
  });
  updateRatioSum();
}

function updateRatioSum() {
  const inputs = tplRatioInputs.querySelectorAll('.ratio-val') as NodeListOf<HTMLInputElement>;
  let sum = 0;
  inputs.forEach(inp => { sum += Number(inp.value) || 0; });
  const rounded = Math.round(sum * 10) / 10;
  tplRatioSum.textContent = String(rounded);
  tplRatioSum.className = Math.abs(rounded - 100) < 0.05 ? 'ok' : 'err';
}

tplModalOk.addEventListener('click', () => {
  const count = parseInt(tplPkgCount.value);
  const name = tplName.value.trim();
  if (!name) { alert('请填写模板名称'); return; }
  if (count < 1) { alert('分包数量至少为 1'); return; }

  const inputs = tplRatioInputs.querySelectorAll('.ratio-val') as NodeListOf<HTMLInputElement>;
  const ratios: number[] = [];
  let sum = 0;
  inputs.forEach(inp => {
    const v = Math.round((Number(inp.value) || 0) * 100);
    ratios.push(v);
    sum += v;
  });
  if (sum !== 10000) {
    alert(`比例总和为 ${(sum / 100).toFixed(1)}%，需要等于 100%`);
    return;
  }

  const isDefault = tplIsDefault.checked;
  if (editingTemplateId) {
    updateTemplate({ id: editingTemplateId, name, packageCount: count, ratios, isDefault });
  } else {
    addTemplate({ id: generateId(), name, packageCount: count, ratios, isDefault });
  }
  closeTemplateModal();
  renderTemplateManagement();
  renderSplitMethod();
});

// ============ Preview ============
const PREVIEW_PAGE_SIZE = 100;
let previewPage = 0;

btnExecuteSplit.addEventListener('click', () => {
  clearPreview();

  // Validate all configs ready
  const notReady = state.fenbiaoConfigs.filter(c => {
    if (c.packageCount < 1) return true;
    if (c.splitMethod === 'ratio' && !c.templateId) return true;
    if (c.splitMethod === 'fixedAmount' && !c.fixedAmounts?.length) return true;
    return false;
  });
  if (notReady.length > 0) {
    const reason = `以下标段配置未完成：${notReady.map(c => c.name).join('、')}`;
    showPreviewError(reason, '配置不完整');
    alert(reason);
    return;
  }

  const roundedErrors = collectRoundedScopeErrors(state.importResult!, state.fenbiaoConfigs, resolveEffectiveSplitScope);
  if (roundedErrors.length > 0) {
    const reason = `以下采购申请已配置为取整拆分，但数量存在小数：${roundedErrors.slice(0, 20).join('、')}`;
    showPreviewError(reason, '数量口径不匹配');
    alert(reason);
    return;
  }

  try {
    const templates = loadTemplates();
    const executionResult = executeSplit(state.importResult!.rows, state.fenbiaoConfigs, templates, resolveEffectiveSplitScope);
    state.splitResult = executionResult.rows;
    state.splitWarnings = executionResult.warnings;
    state.previewSummary = generatePreviewSummary(
      state.importResult!.rows, state.splitResult, state.fenbiaoConfigs
    );
    clearPreviewError();
    previewPage = 0;
    renderPreview();
    saveStateSnapshot(state);
  } catch (err) {
    clearPreview();
    const reasons = err instanceof SplitExecutionError
      ? err.reasons
      : [err instanceof Error ? err.message : String(err)];
    showPreviewError(reasons);
    alert(`拆分失败:\n${reasons.join('\n')}`);
  }
});

function renderPreview() {
  if (!state.splitResult || !state.previewSummary) return;
  const summary = state.previewSummary;
  const warningHtml = state.splitWarnings.length > 0
    ? `<div class="split-warning-block">${state.splitWarnings.map(message => `<div>• ${esc(message)}</div>`).join('')}</div>`
    : '';

  // Summary
  previewSummary.innerHTML = `${warningHtml}<div class="summary-grid">
    <div>原始行数: <strong>${summary.originalRows}</strong></div>
    <div>拆分后行数: <strong>${summary.splitRows}</strong></div>
    <div>总标段数: <strong>${summary.totalFenbiao}</strong></div>
    <div>总分包数: <strong>${summary.totalPackages}</strong></div>
  </div>`;
  previewSummary.classList.remove('hidden');
  previewStatus.textContent = '已生成';
  previewStatus.className = 'status-badge success';

  // Table header
  const previewCols = ['分标名称', '分包名称', '分包编号', '物资名称', '数量', '估算单价（元）', '估算总价（元）'];
  previewTableHead.innerHTML = '<tr>' + previewCols.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';

  // Table body (paginated)
  const totalPages = Math.ceil(state.splitResult.length / PREVIEW_PAGE_SIZE);
  const start = previewPage * PREVIEW_PAGE_SIZE;
  const pageRows = state.splitResult.slice(start, start + PREVIEW_PAGE_SIZE);
  previewTableBody.innerHTML = pageRows.map(row =>
    '<tr>' + previewCols.map(c => `<td>${esc(formatPreviewCellValue(row, c))}</td>`).join('') + '</tr>'
  ).join('');

  // Pagination
  previewPagination.innerHTML = totalPages > 1
    ? `<button class="btn btn-sm" id="prevPage" ${previewPage === 0 ? 'disabled' : ''}>上一页</button>
       <span>${previewPage + 1} / ${totalPages}</span>
       <button class="btn btn-sm" id="nextPage" ${previewPage >= totalPages - 1 ? 'disabled' : ''}>下一页</button>`
    : '';
  document.getElementById('prevPage')?.addEventListener('click', () => { previewPage--; renderPreview(); });
  document.getElementById('nextPage')?.addEventListener('click', () => { previewPage++; renderPreview(); });

  // Enable export
  renderExportSummary();
}

function formatPreviewCellValue(row: ExcelRow, field: string): string {
  const value = row[field];
  if (field === '数量') {
    const fenbiaoName = String(row['分标名称'] ?? '').trim();
    const splitScope = resolveEffectiveSplitScope(row, getFenbiaoConfigByName(fenbiaoName));
    return toFixedDecimalString(value, splitScope === 'rounded' ? 0 : 3) ?? String(value ?? '');
  }
  if (field === '估算单价（元）' || field === '估算总价（元）') {
    return toFixedDecimalString(value, 2) ?? String(value ?? '');
  }
  return String(value ?? '');
}

function clearPreview() {
  state.splitResult = null;
  state.splitWarnings = [];
  state.previewSummary = null;
  clearPreviewError();
  previewSummary.classList.add('hidden');
  previewTableHead.innerHTML = '';
  previewTableBody.innerHTML = '';
  previewPagination.innerHTML = '';
  previewStatus.textContent = '待拆分';
  previewStatus.className = 'status-badge';
  exportSummaryEl.classList.add('hidden');
  exportStatus.textContent = '待预览';
  exportStatus.className = 'status-badge';
}

// ============ Export ============
function renderExportSummary() {
  if (!state.previewSummary || !state.importResult) return;
  const s = state.previewSummary;
  const outName = state.importResult.fileName.replace(/\.xlsx$/i, '') + '_拆分结果.xlsx';
  const warningHtml = state.splitWarnings.length > 0
    ? `<p><strong>微调提示：</strong>${state.splitWarnings.map(message => esc(message)).join('<br />')}</p>`
    : '';
  exportSummaryEl.innerHTML = `
    <p><strong>源文件：</strong>${esc(state.importResult.fileName)}</p>
    <p><strong>原始行数：</strong>${s.originalRows} → <strong>拆分后行数：</strong>${s.splitRows}</p>
    <p><strong>总标段数：</strong>${s.totalFenbiao} | <strong>总分包数：</strong>${s.totalPackages}</p>
    <p><strong>导出显示规则：</strong>取整拆分数量显示整数，小数拆分数量显示 3 位小数，金额固定 2 位小数</p>
    <p><strong>金额校验规则：</strong>每条待拆行在保留 2 位小数后，各包金额合计严格等于拆分前金额</p>
    <p><strong>参考金额规则：</strong>取整拆分 + 参考金额时，系统会按参考金额折算目标包金额，并尽量降低各包目标偏差</p>
    ${warningHtml}
    <p><strong>输出文件名：</strong>${esc(outName)}</p>
  `;
  exportSummaryEl.classList.remove('hidden');
  exportStatus.textContent = '可导出';
  exportStatus.className = 'status-badge success';
}

btnExport.addEventListener('click', async () => {
  if (!state.splitResult || !state.importResult) {
    alert('请先执行拆分并预览');
    return;
  }
  try {
    const outName = state.importResult.fileName.replace(/\.xlsx$/i, '') + '_拆分结果.xlsx';
    const buf = await exportToXlsx(state.splitResult, state.importResult.headerOrder, outName, state.fenbiaoConfigs, resolveEffectiveSplitScope);
    mirrorExportResult(buf);
    exportStatus.textContent = '已导出';
    exportStatus.className = 'status-badge success';
  } catch (err) {
    alert(`导出失败: ${err}`);
  }
});

btnExportComparison.addEventListener('click', async () => {
  if (!state.splitResult || !state.importResult) {
    alert('请先执行拆分并预览');
    return;
  }
  try {
    const templates = loadTemplates();
    const outName = state.importResult.fileName.replace(/\.xlsx$/i, '') + '_包金额差异对比表.xlsx';
    await exportPackageComparisonToXlsx(
      state.splitResult,
      outName,
      state.fenbiaoConfigs,
      state.importResult.exactFenbiaoAmountTotals,
      templates
    );
    exportStatus.textContent = '已导出';
    exportStatus.className = 'status-badge success';
  } catch (err) {
    alert(`导出差异对比表失败: ${err}`);
  }
});

// ============ Helpers ============
function enableModule(section: HTMLElement) { section.classList.add('enabled'); }
function disableModule(section: HTMLElement) { section.classList.remove('enabled'); }

function esc(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/** 将当前模块状态持久化到项目目录 */
function persistModuleState(): void {
  if (!state.importResult?.success) return;
  saveModuleState({
    sourceFileName: state.importResult.fileName,
    fenbiaoConfigs: state.fenbiaoConfigs,
    globalSplitMethod: state.globalSplitMethod,
    updatedAt: new Date().toISOString()
  });
}

function collectRoundedScopeErrors(importResult: ImportResult, configs: FenbiaoConfig[], resolveRowScope: ResolveRowSplitScope): string[] {
  const configMap = new Map(configs.map(config => [config.name, config]));
  const errors: string[] = [];

  importResult.rows.forEach((row, index) => {
    if (!isPendingSplitRow(row)) return;
    const fenbiaoName = String(row['分标名称'] ?? '').trim();
    const config = configMap.get(fenbiaoName);
    if (!config || resolveRowScope(row, config) !== 'rounded') return;
    const qty = normalizeDecimalString(row['数量']) ?? '';
    if (!qty || getDecimalScale(qty) > 0) {
      const requestNo = getRequestNo(row) || '(空)';
      errors.push(`${fenbiaoName}：网省采购申请号 ${requestNo}，第${index + 2}行数量 ${String(row['数量'] ?? '')}`);
    }
  });

  return [...new Set(errors)];
}

// ============ Init ============
async function initModule(): Promise<void> {
  await ensureModuleDirs();
  renderTemplateManagement();

  // 尝试从项目目录恢复之前的工作状态
  const saved = await loadModuleState();
  if (!saved) return;

  const fileData = await loadLatestImportFile();
  if (!fileData) return;

  // 用磁盘上的源文件重新校验
  const result = readAndValidateBuffer(fileData.data, saved.sourceFileName);
  if (!result.success) return;

  // 恢复导入结果
  state.importResult = result;
  renderImportResult(result);

  // 恢复分标配置（需要名称对齐）
  const savedConfigs = saved.fenbiaoConfigs as FenbiaoConfig[];
  if (savedConfigs.length === result.fenbiaoNames.length) {
    const namesMatch = result.fenbiaoNames.every(
      (n, i) => savedConfigs[i]?.name === n
    );
    if (namesMatch) {
      state.fenbiaoConfigs = savedConfigs.map(config => ({
        ...config,
        splitScope: config.splitScope ?? (getDecimalScale(result.exactFenbiaoQtyTotals[config.name] ?? '0') === 0 ? 'rounded' : 'decimal'),
        requestScopeOverrides: config.requestScopeOverrides ?? {}
      }));
      state.globalSplitMethod = saved.globalSplitMethod as SplitMethod;
      globalMethodSelect.value = state.globalSplitMethod;
    }
  }
  initialConfigs = cloneConfigs(state.fenbiaoConfigs);

  renderPkgConfig();
  updatePkgSummary();
  renderSplitMethod();
  renderRequestScopeAdjustments();
}
initModule();
