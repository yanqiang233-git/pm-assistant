import { readAndValidate, readAndValidateBuffer } from './excel/reader';
import { exportToXlsx, downloadConfigTemplate, readConfigTemplate, downloadSplitConfigTemplate, readSplitConfigTemplate } from './excel/writer';
import { executeSplit, generatePreviewSummary } from './split/engine';
import {
  loadTemplates, saveTemplates, addTemplate, updateTemplate,
  deleteTemplate, setDefaultTemplate, getDefaultTemplate,
  getTemplatesByCount, generateId
} from './template/manager';
import { parseSingleColumnPaste, parseTwoColumnPaste } from './config/paste';
import { createInitialState, createFenbiaoConfigs, updateGlobalMethod, saveStateSnapshot } from './store/state';
import {
  compareDecimalStrings,
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
  ImportResult, PasteResult, ExcelRow
} from './types';

// ============ State ============
let state: AppState = createInitialState();
let initialConfigs: FenbiaoConfig[] = []; // for reset

// ============ DOM refs ============
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>('fileInput');
const btnImport = $('btnImport');
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

const sectionTemplate = $('section-template');
const templateGroups = $('templateGroups');
const btnAddTemplate = $('btnAddTemplate');

const sectionPreview = $('section-preview');
const previewStatus = $('previewStatus');
const btnExecuteSplit = $('btnExecuteSplit');
const previewSummary = $('previewSummary');
const previewTableHead = $('previewTableHead');
const previewTableBody = $('previewTableBody');
const previewPagination = $('previewPagination');

const sectionExport = $('section-export');
const exportStatus = $('exportStatus');
const exportSummaryEl = $('exportSummary');
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
const fixedAmountDiff = $('fixedAmountDiff');
const fixedAmountOk = $('fixedAmountOk');
const fixedAmountCancel = $('fixedAmountCancel');
const fixedAmountClose = $('fixedAmountClose');

// ============ Import ============
btnImport.addEventListener('click', () => fileInput.click());
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
    state.fenbiaoConfigs = createFenbiaoConfigs(r.fenbiaoNames, state.globalSplitMethod);
    initialConfigs = state.fenbiaoConfigs.map(c => ({ ...c }));
    enableModule(sectionPkgConfig);
    enableModule(sectionSplitMethod);
    enableModule(sectionPreview);
    enableModule(sectionExport);
    renderPkgConfig();
    renderSplitMethod();
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
    html += `<tr class="${errClass}">
      <td class="col-idx" style="text-align:center">${i + 1}</td>
      <td class="col-name">${esc(c.name)}</td>
      <td class="col-count"><input type="number" min="1" value="${c.packageCount || ''}" data-idx="${i}" class="pkg-count-input" /></td>
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
  const buf = await downloadConfigTemplate(state.importResult.fenbiaoNames);
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
    state.fenbiaoConfigs = parsed.configs;
    showPasteResult(parsed.result);
    renderPkgConfig();
    updatePkgSummary();
    renderSplitMethod();
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
  state.fenbiaoConfigs = initialConfigs.map(c => ({ ...c }));
  renderPkgConfig();
  updatePkgSummary();
  renderSplitMethod();
  clearPreview();
  pasteResultEl.classList.add('hidden');
});

// ============ Split Method ============
globalMethodSelect.addEventListener('change', () => {
  const method = globalMethodSelect.value as SplitMethod;
  state.globalSplitMethod = method;
  state.fenbiaoConfigs = updateGlobalMethod(state.fenbiaoConfigs, method);
  renderSplitMethod();
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
  fixedAmountHint.textContent = `请为 ${config.packageCount} 个包分别设置参考金额，仅作为拆分权重；原分标总额 ${totalExact} 元仅供参考`;
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
    console.info(`参考金额总和 ${sum} 与分标总额 ${target} 存在差额 ${diff} 元，将仅作为拆分权重使用`);
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
  // Validate all configs ready
  const notReady = state.fenbiaoConfigs.filter(c => {
    if (c.packageCount < 1) return true;
    if (c.splitMethod === 'ratio' && !c.templateId) return true;
    if (c.splitMethod === 'fixedAmount' && !c.fixedAmounts?.length) return true;
    return false;
  });
  if (notReady.length > 0) {
    alert(`以下标段配置未完成：\n${notReady.map(c => c.name).join('\n')}`);
    return;
  }

  try {
    const templates = loadTemplates();
    state.splitResult = executeSplit(state.importResult!.rows, state.fenbiaoConfigs, templates);
    state.previewSummary = generatePreviewSummary(
      state.importResult!.rows, state.splitResult, state.fenbiaoConfigs
    );
    previewPage = 0;
    renderPreview();
    saveStateSnapshot(state);
  } catch (err) {
    clearPreview();
    alert(`拆分失败: ${err instanceof Error ? err.message : String(err)}`);
  }
});

function renderPreview() {
  if (!state.splitResult || !state.previewSummary) return;
  const summary = state.previewSummary;

  // Summary
  previewSummary.innerHTML = `<div class="summary-grid">
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
    return toFixedDecimalString(value, 3) ?? String(value ?? '');
  }
  if (field === '估算单价（元）' || field === '估算总价（元）') {
    return toFixedDecimalString(value, 2) ?? String(value ?? '');
  }
  return String(value ?? '');
}

function clearPreview() {
  state.splitResult = null;
  state.previewSummary = null;
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
  exportSummaryEl.innerHTML = `
    <p><strong>源文件：</strong>${esc(state.importResult.fileName)}</p>
    <p><strong>原始行数：</strong>${s.originalRows} → <strong>拆分后行数：</strong>${s.splitRows}</p>
    <p><strong>总标段数：</strong>${s.totalFenbiao} | <strong>总分包数：</strong>${s.totalPackages}</p>
    <p><strong>导出显示规则：</strong>数量固定 3 位小数，金额固定 2 位小数</p>
    <p><strong>金额校验规则：</strong>每条待拆行在保留 2 位小数后，各包金额合计严格等于拆分前金额</p>
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
    const buf = await exportToXlsx(state.splitResult, state.importResult.headerOrder, outName);
    mirrorExportResult(buf);
    exportStatus.textContent = '已导出';
    exportStatus.className = 'status-badge success';
  } catch (err) {
    alert(`导出失败: ${err}`);
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
      state.fenbiaoConfigs = savedConfigs;
      state.globalSplitMethod = saved.globalSplitMethod as SplitMethod;
      globalMethodSelect.value = state.globalSplitMethod;
    }
  }
  initialConfigs = state.fenbiaoConfigs.map(c => ({ ...c }));

  renderPkgConfig();
  updatePkgSummary();
  renderSplitMethod();
}
initModule();
