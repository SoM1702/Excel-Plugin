/*
 * Excel task-pane client for Logistic Regression (Scratch Engine).
 *
 * Implements linked Train%/Test% controls, request revision tracking,
 * pure scratch diagnostics, bounded training-loss curve rendering,
 * and robust export reporting to new Excel worksheets.
 */

const DEFAULT_BACKEND = "https://localhost:8000";
const REQUEST_TIMEOUT_MS = 30000;

let BACKEND_URL = localStorage.getItem("lr_backend_url") || DEFAULT_BACKEND;
let LAST_RESULT = null;
let LAST_NEW_PREDICTION = null;
let CURRENT_REQUEST_ID = 0;
let TRAIN_REVISION = 0;
let WHATIF_REVISION = 0;
let NEW_PRED_REVISION = 0;
let SELECTION_REVISIONS = {};
let EXPORT_OP_COUNTER = 0;
let PARAMS_CURRENT_PAGE = 1;
let PARAMS_SEARCH_QUERY = "";
const PARAMS_PAGE_SIZE = 50;
const EXCEL_CELL_MAX_CHARS = 32767;
const BATCH_MAX_ROWS = 250;
const BATCH_MAX_CELLS = 10000;
const BATCH_MAX_BYTES = 1024 * 1024; // 1 MiB estimated serialized content budget
let TOTAL_USABLE_ROWS = 400; // Updated when reading training data
let CURRENT_MODE = "table";
let TABLE_PROFILE_DATA = null;
let TABLE_DESCRIPTOR = null;
let TABLE_HEADERS = null;
let TABLE_ROWS = null;
let TABLE_PROFILE_REVISION = 0;
let TABLE_FINGERPRINT = "";

function invalidateTableProfile() {
  TABLE_PROFILE_REVISION++;
  TABLE_PROFILE_DATA = null;
  TABLE_DESCRIPTOR = null;
  TABLE_HEADERS = null;
  TABLE_ROWS = null;
  TABLE_FINGERPRINT = "";
  const card = document.getElementById("table-profile-card");
  if (card) card.classList.add("hidden");
  const colList = document.getElementById("table-columns-list");
  if (colList) colList.innerHTML = "";
  const ySelect = document.getElementById("table-y-select");
  if (ySelect) ySelect.innerHTML = "";
  const projEl = document.getElementById("table-projected-summary");
  if (projEl) projEl.textContent = "";
  const countEl = document.getElementById("table-selected-count");
  if (countEl) countEl.textContent = "0 features selected";
  TOTAL_USABLE_ROWS = 0;
}

function estimateUtf8Bytes(str) {
  if (typeof str !== "string") return 0;
  let bytes = 0;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function estimateCellBytes(cell, hasNumberFormat = false, numFormatLen = 8) {
  let b = 4;
  if (typeof cell === "string") {
    b += estimateUtf8Bytes(cell) + 2;
  } else if (typeof cell === "number") {
    b += 16;
  } else if (typeof cell === "boolean") {
    b += 5;
  }
  if (hasNumberFormat) {
    b += numFormatLen + 4;
  }
  return b;
}

function escapeLiteralText(val) {
  if (typeof val !== "string") return val;
  if (/^[=+\-@]/.test(val)) {
    return "'" + val;
  }
  return val;
}

function escapeExcelFormulaString(val) {
  if (typeof val !== "string") return String(val ?? "");
  return val.replace(/"/g, '""');
}

function prepareIdentityText(text) {
  if (text === null || text === undefined) return "";
  const s = String(text);
  const escaped = escapeLiteralText(s);
  if (escaped.length > EXCEL_CELL_MAX_CHARS) {
    throw new Error(`Identity text exceeds Excel cell limit of ${EXCEL_CELL_MAX_CHARS} characters (${s.length} chars).`);
  }
  return escaped;
}

function prepareDescription(text, maxLen = 32000) {
  if (text === null || text === undefined) return "";
  const s = String(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 30) + `... [truncated (${s.length} chars)]`;
}

function prepareFormula(formula) {
  if (formula === null || formula === undefined) return "";
  const s = String(formula);
  if (s.length > EXCEL_CELL_MAX_CHARS) {
    throw new Error(`Formula exceeds Excel limit of ${EXCEL_CELL_MAX_CHARS} characters.`);
  }
  return s;
}

function truncateForExcelCell(val, maxLen = 32000) {
  return prepareDescription(val, maxLen);
}

function invalidateNewPredictionInputs() {
  NEW_PRED_REVISION++;
  clearNewPrediction();
}

function createExportToken(type, result, prediction = null) {
  return {
    id: ++EXPORT_OP_COUNTER,
    type,
    modelId: result ? result.model_id : null,
    trainRevision: TRAIN_REVISION,
    requestId: CURRENT_REQUEST_ID,
    newPredRevision: prediction ? prediction.revision : NEW_PRED_REVISION,
    backendUrl: BACKEND_URL,
    threshold: result ? result._activeThreshold : null,
    targetResult: result,
    targetPrediction: prediction,
  };
}

function isExportTokenValid(token) {
  if (!token) return false;
  if (token.type === "new_pred") {
    if (!LAST_RESULT || LAST_RESULT._stale || LAST_RESULT.model_id !== token.modelId) return false;
    if (TRAIN_REVISION !== token.trainRevision) return false;
    if (!LAST_NEW_PREDICTION || LAST_NEW_PREDICTION !== token.targetPrediction) return false;
    if (LAST_NEW_PREDICTION.revision !== token.newPredRevision) return false;
    if (BACKEND_URL !== token.backendUrl) return false;
    if (Math.abs((token.targetPrediction.threshold ?? 0) - (LAST_RESULT._activeThreshold ?? 0)) > 1e-6) return false;
    return true;
  }
  if (!LAST_RESULT || LAST_RESULT._stale || LAST_RESULT !== token.targetResult) return false;
  if (LAST_RESULT.model_id !== token.modelId) return false;
  if (TRAIN_REVISION !== token.trainRevision) return false;
  if (CURRENT_REQUEST_ID !== token.requestId) return false;
  if (BACKEND_URL !== token.backendUrl) return false;
  if (token.threshold !== null && Math.abs(LAST_RESULT._activeThreshold - token.threshold) > 1e-6) return false;
  return true;
}

async function writeWideRowSegments(context, sheet, rowCoord, startCol, row, options = {}) {
  const token = options.token;
  const maxCells = options.maxCells || BATCH_MAX_CELLS;
  const maxBytes = options.maxBytes || BATCH_MAX_BYTES;
  const numFormatStr = typeof options.numberFormat === "string" ? options.numberFormat : "0.000000";
  const hasNumFormat = Boolean(options.numberFormat);

  let cIdx = 0;
  while (cIdx < row.length) {
    if (token && !isExportTokenValid(token)) {
      throw new Error("Export cancelled because model, settings, or threshold changed during export.");
    }

    let segmentColCount = 0;
    let segmentBytes = 20;

    while (cIdx + segmentColCount < row.length) {
      const cell = row[cIdx + segmentColCount];
      const cellBytes = estimateCellBytes(cell, hasNumFormat, numFormatStr.length);

      if (segmentColCount > 0) {
        if (segmentColCount >= maxCells) break;
        if (segmentBytes + cellBytes > maxBytes) break;
      }

      segmentColCount++;
      segmentBytes += cellBytes;

      if (segmentBytes > maxBytes && segmentColCount === 1) {
        break;
      }
    }

    const segment = row.slice(cIdx, cIdx + segmentColCount);
    sheet.getRangeByIndexes(rowCoord, startCol + cIdx, 1, segment.length).values = [segment];

    if (options.isHeaderRow) {
      sheet.getRangeByIndexes(rowCoord, startCol + cIdx, 1, segment.length).format.font.bold = true;
    }

    if (options.numberFormat && !options.isHeaderRow) {
      const formatOffset = options.formatColOffset || 0;
      const formatCount = options.formatColCount || (row.length - formatOffset);
      const overlapStart = Math.max(cIdx, formatOffset);
      const overlapEnd = Math.min(cIdx + segmentColCount, formatOffset + formatCount);
      if (overlapEnd > overlapStart) {
        const segNumRange = sheet.getRangeByIndexes(rowCoord, startCol + overlapStart, 1, overlapEnd - overlapStart);
        if (typeof options.numberFormat === "string") {
          segNumRange.numberFormat = [Array(overlapEnd - overlapStart).fill(options.numberFormat)];
        }
      }
    }

    await context.sync();

    if (token && !isExportTokenValid(token)) {
      throw new Error("Export cancelled because model, settings, or threshold changed during export.");
    }

    cIdx += segmentColCount;
  }
}

async function writeTableChunks(context, sheet, startRow, startCol, rows, options = {}) {
  if (!rows || rows.length === 0) return;
  const token = options.token;
  const maxRowsPerBatch = options.maxRows || options.chunkSize || BATCH_MAX_ROWS;
  const maxCellsPerBatch = options.maxCells || BATCH_MAX_CELLS;
  const maxBytesPerBatch = options.maxBytes || BATCH_MAX_BYTES;
  const numFormatStr = typeof options.numberFormat === "string" ? options.numberFormat : "0.000000";
  const hasNumFormat = Boolean(options.numberFormat);

  // Validate all cells against Excel's limit of 32,767 chars
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === "string" && cell.length > EXCEL_CELL_MAX_CHARS) {
        throw new Error(`Cell content exceeds Excel's ${EXCEL_CELL_MAX_CHARS} character limit (${cell.length} characters).`);
      }
    }
  }

  let rIdx = 0;
  while (rIdx < rows.length) {
    if (token && !isExportTokenValid(token)) {
      throw new Error("Export cancelled because model, settings, or threshold changed during export.");
    }

    const firstRowCols = rows[rIdx].length;

    if (firstRowCols <= maxCellsPerBatch) {
      let chunkRowCount = 0;
      let chunkCells = 0;
      let chunkBytes = 0;

      while (rIdx + chunkRowCount < rows.length) {
        const nextRow = rows[rIdx + chunkRowCount];
        const nextCols = nextRow.length;
        let nextRowBytes = 20;
        for (let c = 0; c < nextCols; c++) {
          nextRowBytes += estimateCellBytes(nextRow[c], hasNumFormat, numFormatStr.length);
        }

        if (chunkRowCount > 0) {
          if (chunkRowCount >= maxRowsPerBatch) break;
          if (chunkCells + nextCols > maxCellsPerBatch) break;
          if (chunkBytes + nextRowBytes > maxBytesPerBatch) break;
        }

        chunkRowCount++;
        chunkCells += nextCols;
        chunkBytes += nextRowBytes;

        if (chunkBytes > maxBytesPerBatch && chunkRowCount === 1) {
          break;
        }
      }

      if (chunkRowCount === 1 && chunkBytes > maxBytesPerBatch && firstRowCols > 1) {
        await writeWideRowSegments(context, sheet, startRow + rIdx, startCol, rows[rIdx], {
          token,
          maxCells: maxCellsPerBatch,
          maxBytes: maxBytesPerBatch,
          isHeaderRow: (rIdx === 0 && options.formatHeaders),
          numberFormat: options.numberFormat,
          formatColOffset: options.formatColOffset,
          formatColCount: options.formatColCount,
        });
        rIdx++;
        if (options.onChunkWritten) {
          options.onChunkWritten(rIdx, rows.length);
        }
        continue;
      }

      const chunk = rows.slice(rIdx, rIdx + chunkRowCount);
      sheet.getRangeByIndexes(startRow + rIdx, startCol, chunk.length, chunk[0].length).values = chunk;

      if (options.formatHeaders && rIdx === 0) {
        sheet.getRangeByIndexes(startRow, startCol, 1, chunk[0].length).format.font.bold = true;
      }
      if (options.formatFirstColBold) {
        sheet.getRangeByIndexes(startRow + rIdx, startCol, chunk.length, 1).format.font.bold = true;
      }

      if (options.numberFormat) {
        const dataStart = (rIdx === 0 && options.formatHeaders) ? 1 : 0;
        const dataCount = chunk.length - dataStart;
        if (dataCount > 0) {
          const formatOffset = options.formatColOffset || 0;
          const formatCount = options.formatColCount || (chunk[0].length - formatOffset);
          const numRange = sheet.getRangeByIndexes(startRow + rIdx + dataStart, startCol + formatOffset, dataCount, formatCount);
          if (typeof options.numberFormat === "string") {
            numRange.numberFormat = Array.from({ length: dataCount }, () => Array(formatCount).fill(options.numberFormat));
          } else if (Array.isArray(options.numberFormat)) {
            numRange.numberFormat = Array.from({ length: dataCount }, () => options.numberFormat);
          }
        }
      }

      await context.sync();

      if (token && !isExportTokenValid(token)) {
        throw new Error("Export cancelled because model, settings, or threshold changed during export.");
      }

      rIdx += chunkRowCount;
      if (options.onChunkWritten) {
        options.onChunkWritten(rIdx, rows.length);
      }
    } else {
      await writeWideRowSegments(context, sheet, startRow + rIdx, startCol, rows[rIdx], {
        token,
        maxCells: maxCellsPerBatch,
        maxBytes: maxBytesPerBatch,
        isHeaderRow: (rIdx === 0 && options.formatHeaders),
        numberFormat: options.numberFormat,
        formatColOffset: options.formatColOffset,
        formatColCount: options.formatColCount,
      });
      rIdx++;
      if (options.onChunkWritten) {
        options.onChunkWritten(rIdx, rows.length);
      }
    }
  }
}


let rocChart = null;
let coefChart = null;
let lossChart = null;

Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) return;

  document.querySelectorAll("button[data-target]").forEach((button) => {
    button.addEventListener("click", () => useSelection(button.dataset.target));
  });
  document.getElementById("run-btn").addEventListener("click", runModel);
  const exportWeightsBtn = document.getElementById("export-weights-btn");
  if (exportWeightsBtn) {
    exportWeightsBtn.addEventListener("click", exportModelWeights);
  }
  document.getElementById("writeback-btn").addEventListener("click", writePredictions);
  document.getElementById("whatif-btn").addEventListener("click", runWhatIf);
  document.getElementById("score-new-btn").addEventListener("click", scoreNewRows);
  document.getElementById("export-new-btn").addEventListener("click", exportNewPredictions);

  // Parameter table navigation & search controls
  const paramsSearch = document.getElementById("params-search");
  if (paramsSearch) {
    paramsSearch.addEventListener("input", (e) => {
      PARAMS_SEARCH_QUERY = e.target.value;
      PARAMS_CURRENT_PAGE = 1;
      if (LAST_RESULT && !LAST_RESULT._stale) {
        renderParametersTable(LAST_RESULT);
      }
    });
  }
  const paramsPrevBtn = document.getElementById("params-prev-btn");
  if (paramsPrevBtn) {
    paramsPrevBtn.addEventListener("click", () => {
      if (PARAMS_CURRENT_PAGE > 1) {
        PARAMS_CURRENT_PAGE--;
        if (LAST_RESULT && !LAST_RESULT._stale) {
          renderParametersTable(LAST_RESULT);
        }
      }
    });
  }
  const paramsNextBtn = document.getElementById("params-next-btn");
  if (paramsNextBtn) {
    paramsNextBtn.addEventListener("click", () => {
      PARAMS_CURRENT_PAGE++;
      if (LAST_RESULT && !LAST_RESULT._stale) {
        renderParametersTable(LAST_RESULT);
      }
    });
  }

  // Linked Train % and Test % controls
  setupLinkedSplitControls();

  // Threshold slider
  document.getElementById("threshold").addEventListener("input", (event) => {
    const threshold = Number(event.target.value);
    document.getElementById("threshold-out").textContent = threshold.toFixed(2);
    if (LAST_RESULT && !LAST_RESULT._stale) {
      LAST_RESULT._activeThreshold = threshold;
      updateConfusion(threshold);
      refreshWhatIfResultIfActive();
      refreshNewPredictionThreshold(threshold);
    }
  });

  // Backend URL settings
  const urlInput = document.getElementById("backend-url");
  urlInput.value = BACKEND_URL;
  document.getElementById("save-url").addEventListener("click", () => {
    const value = urlInput.value.trim().replace(/\/+$/, "");
    if (value && !value.startsWith("https://")) {
      showError("Use an HTTPS backend URL, for example https://localhost:8000.");
      return;
    }
    BACKEND_URL = value || DEFAULT_BACKEND;
    localStorage.setItem("lr_backend_url", BACKEND_URL);
    TRAIN_REVISION++;
    WHATIF_REVISION++;
    NEW_PRED_REVISION++;
    CURRENT_REQUEST_ID++;
    clearActiveModel("Backend changed. Train a model on the selected backend.");
    checkBackend();
  });

  // Mode Switcher (Table Mode vs Numeric Mode)
  const modeTableBtn = document.getElementById("mode-table-btn");
  const modeNumericBtn = document.getElementById("mode-numeric-btn");
  const tableModeContainer = document.getElementById("table-mode-container");
  const numericModeContainer = document.getElementById("numeric-mode-container");

  if (modeTableBtn && modeNumericBtn) {
    modeTableBtn.addEventListener("click", () => {
      CURRENT_MODE = "table";
      modeTableBtn.classList.add("active");
      modeNumericBtn.classList.remove("active");
      if (tableModeContainer) tableModeContainer.classList.remove("hidden");
      if (numericModeContainer) numericModeContainer.classList.add("hidden");
      markRunStale();
    });
    modeNumericBtn.addEventListener("click", () => {
      CURRENT_MODE = "numeric";
      modeNumericBtn.classList.add("active");
      modeTableBtn.classList.remove("active");
      if (numericModeContainer) numericModeContainer.classList.remove("hidden");
      if (tableModeContainer) tableModeContainer.classList.add("hidden");
      markRunStale();
    });
  }

  // Table Mode buttons and controls
  const profileTableBtn = document.getElementById("profile-table-btn");
  if (profileTableBtn) {
    profileTableBtn.addEventListener("click", profileTable);
  }
  const selAllBtn = document.getElementById("table-select-all-suggested");
  if (selAllBtn) {
    selAllBtn.addEventListener("click", selectAllSuggestedTableColumns);
  }
  const clearColsBtn = document.getElementById("table-select-clear");
  if (clearColsBtn) {
    clearColsBtn.addEventListener("click", clearAllTableColumns);
  }
  const tableYSelect = document.getElementById("table-y-select");
  if (tableYSelect) {
    tableYSelect.addEventListener("change", onTableYSelectChange);
  }
  const tableMissingPolicy = document.getElementById("table-missing-policy");
  if (tableMissingPolicy) {
    tableMissingPolicy.addEventListener("change", onTableMissingPolicyChange);
  }

  // Controls that mark model stale when edited
  const staleInputs = [
    "table-range", "table-missing-policy",
    "y-range", "x-range", "has-header", "standardize", "train-pct", "test-pct",
    "learning-rate", "max-iter", "tolerance", "l2-lambda", "balance", "cv",
  ];
  staleInputs.forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    const handleStale = () => {
      SELECTION_REVISIONS[id] = (SELECTION_REVISIONS[id] || 0) + 1;
      if (id === "table-range") {
        invalidateTableProfile();
      }
      markRunStale();
    };
    element.addEventListener("change", handleStale);
    if (element.tagName === "INPUT" && element.type !== "checkbox") {
      element.addEventListener("input", handleStale);
    }
  });

  ["new-x-range", "new-has-header"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const handleNewPred = () => {
      SELECTION_REVISIONS["new-x-range"] = (SELECTION_REVISIONS["new-x-range"] || 0) + 1;
      invalidateNewPredictionInputs();
    };
    el.addEventListener("change", handleNewPred);
    if (el.tagName === "INPUT" && el.type !== "checkbox") {
      el.addEventListener("input", handleNewPred);
    }
  });

  if (typeof checkNamedRangeRequirementSupport === "function" && !checkNamedRangeRequirementSupport()) {
    console.warn("ExcelApi 1.4 is not supported on this Excel host. Defined names may have limited functionality.");
  }
  setModelActionsEnabled(false);
  checkBackend();
});

function setupLinkedSplitControls() {
  const slider = document.getElementById("test-size");
  const testInput = document.getElementById("test-pct");
  const trainInput = document.getElementById("train-pct");

  function applySplit(testVal, trainVal, updateInputs = true) {
    if (updateInputs) {
      testInput.value = testVal;
      trainInput.value = trainVal;
    }
    slider.value = (testVal / 100).toFixed(2);
    updateSplitSummary(trainVal, testVal);
    markRunStale();
  }

  function commitTest() {
    let testVal = Math.round(Number(testInput.value));
    if (isNaN(testVal) || testVal < 5) testVal = 5;
    if (testVal > 80) testVal = 80;
    const trainVal = 100 - testVal;
    applySplit(testVal, trainVal, true);
  }

  function commitTrain() {
    let trainVal = Math.round(Number(trainInput.value));
    if (isNaN(trainVal) || trainVal < 20) trainVal = 20;
    if (trainVal > 95) trainVal = 95;
    const testVal = 100 - trainVal;
    applySplit(testVal, trainVal, true);
  }

  slider.addEventListener("input", () => {
    const testVal = Math.round(Number(slider.value) * 100);
    const trainVal = 100 - testVal;
    applySplit(testVal, trainVal, true);
  });

  testInput.addEventListener("input", () => {
    const raw = Number(testInput.value);
    if (!isNaN(raw) && raw >= 5 && raw <= 80 && Math.floor(raw) === raw) {
      const trainVal = 100 - raw;
      trainInput.value = trainVal;
      slider.value = (raw / 100).toFixed(2);
      updateSplitSummary(trainVal, raw);
      markRunStale();
    }
  });

  testInput.addEventListener("change", commitTest);
  testInput.addEventListener("blur", commitTest);

  trainInput.addEventListener("input", () => {
    const raw = Number(trainInput.value);
    if (!isNaN(raw) && raw >= 20 && raw <= 95 && Math.floor(raw) === raw) {
      const testVal = 100 - raw;
      testInput.value = testVal;
      slider.value = (testVal / 100).toFixed(2);
      updateSplitSummary(raw, testVal);
      markRunStale();
    }
  });

  trainInput.addEventListener("change", commitTrain);
  trainInput.addEventListener("blur", commitTrain);

  const initialTest = Number(testInput.value) || 30;
  applySplit(initialTest, 100 - initialTest, true);
}

function updateSplitSummary(trainPct, testPct) {
  const badge = document.getElementById("split-summary-badge");
  if (badge) badge.textContent = `${trainPct}% / ${testPct}%`;

  const countsEl = document.getElementById("allocation-counts");
  if (countsEl) {
    if (TOTAL_USABLE_ROWS === null) {
      countsEl.textContent = `Split ratio: Train ${trainPct}%, Test ${testPct}% (select worksheet data to view row counts).`;
    } else {
      const N = TOTAL_USABLE_ROWS;
      const nTest = Math.ceil(N * (testPct / 100));
      const nTrain = N - nTest;
      countsEl.textContent =
        `Row allocations (N=${N}): Train ${nTrain} rows (${((nTrain / N) * 100).toFixed(1)}%), ` +
        `Test ${nTest} rows (${((nTest / N) * 100).toFixed(1)}%). Rule: n_test = ceil(N * test_size).`;
    }
  }
}

async function fetchJson(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, backendUrl = null) {
  const base = backendUrl || options.backendUrl || BACKEND_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Handled below
    }
    if (!response.ok) {
      throw new Error((data && data.detail) || "Request failed with status " + response.status + ".");
    }
    if (!data) throw new Error("The backend returned an invalid JSON response.");
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The backend request timed out. Check that the service is running.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBackend() {
  const banner = document.getElementById("backend-status");
  try {
    const health = await fetchJson("/health", {}, 5000);
    banner.textContent = `Backend connected ✓ (Engine: ${health.engine || "scratch"})`;
    banner.className = "banner banner-ok";
  } catch {
    banner.textContent =
      "Backend not reachable at " + BACKEND_URL + ". Start the HTTPS Python service, then save its URL here.";
    banner.className = "banner banner-err";
  }
}

async function useSelection(targetId) {
  SELECTION_REVISIONS[targetId] = (SELECTION_REVISIONS[targetId] || 0) + 1;
  const reqRev = SELECTION_REVISIONS[targetId];
  if (targetId === "new-x-range") {
    invalidateNewPredictionInputs();
  } else if (targetId === "table-range") {
    invalidateTableProfile();
    markRunStale();
  } else {
    markRunStale();
  }

  try {
    let selectedAddress = null;
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load("address");
      await context.sync();
      selectedAddress = range.address;
    });

    if (reqRev !== SELECTION_REVISIONS[targetId]) {
      return;
    }

    const el = document.getElementById(targetId);
    if (el && selectedAddress) {
      el.value = selectedAddress;
    }

    if (targetId === "new-x-range") {
      invalidateNewPredictionInputs();
    } else {
      markRunStale();
    }
  } catch (error) {
    if (reqRev !== SELECTION_REVISIONS[targetId]) {
      return;
    }
    if (targetId === "new-x-range") {
      invalidateNewPredictionInputs();
    }
    showError("Could not read the selected cells: " + error.message);
  }
}

function getRangeByAddress(context, address) {
  let rangeAddress = address.trim();
  const separator = rangeAddress.lastIndexOf("!");
  let sheetName = null;
  if (separator >= 0) {
    sheetName = rangeAddress.slice(0, separator).replace(/^'|'$/g, "").replace(/''/g, "'");
    rangeAddress = rangeAddress.slice(separator + 1);
  }
  const sheet = sheetName
    ? context.workbook.worksheets.getItem(sheetName)
    : context.workbook.worksheets.getActiveWorksheet();
  return sheet.getRange(rangeAddress);
}

function isBlank(value) {
  return value === "" || value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function classifyProbability(probability, threshold) {
  return Number(probability) >= Number(threshold) ? 1 : 0;
}

function isOverlap(a, b) {
  return (
    a.rowIndex < b.rowIndex + b.rowCount &&
    a.rowIndex + a.rowCount > b.rowIndex &&
    a.columnIndex < b.columnIndex + b.columnCount &&
    a.columnIndex + a.columnCount > b.columnIndex
  );
}

function validateHeaderRow(headerRow) {
  const names = headerRow.map((cell) => (isBlank(cell) ? "" : String(cell).trim()));
  if (names.some((name) => !name)) {
    throw new Error("Feature headers cannot be blank.");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Feature headers must be unique.");
  }
  return names;
}

function validateNumericRows(rows, featureNames, firstDataRow, isPrediction = false) {
  const features = [];
  const constantChecks = Array.from({ length: featureNames.length }, () => new Set());

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const excelRow = firstDataRow + r;
    const parsedRow = [];
    for (let c = 0; c < row.length; c += 1) {
      const cell = row[c];
      if (isBlank(cell)) {
        throw new Error(`Row ${excelRow}, feature "${featureNames[c]}" is blank.`);
      }
      const num = Number(cell);
      if (!Number.isFinite(num)) {
        throw new Error(`Row ${excelRow}, feature "${featureNames[c]}" is non-numeric: "${cell}".`);
      }
      parsedRow.push(num);
      constantChecks[c].add(num);
    }
    features.push(parsedRow);
  }

  const constantFeatures = [];
  constantChecks.forEach((valuesSet, idx) => {
    if (valuesSet.size === 1) constantFeatures.push(featureNames[idx]);
  });

  if (!isPrediction && constantFeatures.length === featureNames.length) {
    throw new Error(
      "All selected features are constant (zero variance). " +
      "Logistic regression cannot learn weights without feature variation."
    );
  }

  return { features, constantFeatures };
}

function validateLabels(labelColumn, firstDataRow) {
  const unique = new Map();
  const labels = [];
  for (let r = 0; r < labelColumn.length; r += 1) {
    const val = labelColumn[r];
    const excelRow = firstDataRow + r;
    if (isBlank(val)) {
      throw new Error(`Row ${excelRow} outcome is blank.`);
    }
    const key = typeof val + ":" + String(val);
    if (!unique.has(key)) unique.set(key, val);
    labels.push(val);
  }
  if (unique.size !== 2) {
    const classes = [...unique.values()].slice(0, 5).join(", ");
    throw new Error(`Binary logistic regression needs exactly 2 classes, got ${unique.size}: [${classes}].`);
  }
  return { labels, classLabels: [...unique.values()].map((v) => String(v)) };
}

function renderPreview(data) {
  const preview = document.getElementById("data-preview");
  if (!preview) return;
  preview.innerHTML = "";

  // Render resolution preview banner if source descriptors are present
  if (data.source && data.source.x && data.source.y) {
    const resBox = document.createElement("div");
    resBox.className = "resolution-box";
    const lineX = document.createElement("div");
    lineX.className = "resolution-line";
    lineX.textContent = "X: " + formatDescriptorSummary(data.source.x, data.labels.length, data.featureNames.length, "features");
    resBox.appendChild(lineX);

    const lineY = document.createElement("div");
    lineY.className = "resolution-line";
    lineY.textContent = "Y: " + formatDescriptorSummary(data.source.y, data.labels.length, 1, "outcome");
    resBox.appendChild(lineY);

    preview.appendChild(resBox);
  }

  const maxCols = 10;
  const previewNames = data.featureNames.slice(0, maxCols);
  const omittedCols = data.featureNames.length - previewNames.length;

  const counts = data.classLabels.map((label) =>
    label + ": " + data.labels.filter((value) => String(value) === label).length
  );
  const details = [
    data.labels.length + " usable rows · " + data.featureNames.length + " features",
    "Classes: " + counts.join(", "),
    "Features: " + (omittedCols > 0 ? previewNames.join(", ") + ` (+${omittedCols} more)` : data.featureNames.join(", ")),
  ];
  if (data.constantFeatures && data.constantFeatures.length) {
    details.push("Constant feature warning: " + data.constantFeatures.join(", "));
  }

  const summaryP = document.createElement("p");
  summaryP.className = "preview-summary";
  summaryP.textContent = details.join(" | ");
  preview.appendChild(summaryP);

  // Multirow sample preview: header + first 3 rows, bounded to 10 columns max
  if (data.features && data.features.length) {
    const tableWrap = document.createElement("div");
    tableWrap.className = "preview-table-wrap";
    const table = document.createElement("table");
    table.className = "preview-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    const thRow = document.createElement("th");
    thRow.textContent = "Row";
    headerRow.appendChild(thRow);
    const thY = document.createElement("th");
    thY.textContent = "Outcome (Y)";
    headerRow.appendChild(thY);
    previewNames.forEach((name) => {
      const th = document.createElement("th");
      th.textContent = name;
      headerRow.appendChild(th);
    });
    if (omittedCols > 0) {
      const thMore = document.createElement("th");
      thMore.textContent = `+${omittedCols} more features`;
      headerRow.appendChild(thMore);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const sampleCount = Math.min(3, data.features.length);
    for (let i = 0; i < sampleCount; i += 1) {
      const tr = document.createElement("tr");
      const tdRow = document.createElement("td");
      tdRow.textContent = String(i + 1);
      tr.appendChild(tdRow);
      const tdY = document.createElement("td");
      tdY.textContent = String(data.labels[i]);
      tr.appendChild(tdY);
      previewNames.forEach((_, colIdx) => {
        const td = document.createElement("td");
        td.textContent = String(data.features[i][colIdx]);
        tr.appendChild(td);
      });
      if (omittedCols > 0) {
        const tdMore = document.createElement("td");
        tdMore.textContent = "…";
        tr.appendChild(tdMore);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    preview.appendChild(tableWrap);
  }

  preview.classList.remove("hidden");
}

function valuesFingerprint(matrix) {
  let hash = 0;
  for (let r = 0; r < matrix.length; r += 1) {
    for (let c = 0; c < matrix[r].length; c += 1) {
      const str = String(matrix[r][c]);
      for (let i = 0; i < str.length; i += 1) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
      }
      hash = (hash * 31 + 31) | 0; // cell delimiter
    }
    hash = (hash * 31 + 10) | 0; // row delimiter
  }
  return String(hash);
}

async function readTrainingData(yAddress, xAddress) {
  const hasHeader = document.getElementById("has-header").checked;
  let xValues, yValues, xDescriptor, yDescriptor;

  await Excel.run(async (context) => {
    const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
    activeWorksheet.load("id,name");
    await context.sync();

    const xResolved = await resolveRangeInput(context, xAddress, { fieldName: "X", activeWorksheet });
    const yResolved = await resolveRangeInput(context, yAddress, { fieldName: "Y", activeWorksheet });

    xValues = xResolved.descriptor.values;
    yValues = yResolved.descriptor.values;
    xDescriptor = xResolved.descriptor;
    yDescriptor = yResolved.descriptor;
  });

  if (xDescriptor.resolvedWorksheetId !== yDescriptor.resolvedWorksheetId) {
    throw new Error("X and Y must be on the same worksheet.");
  }
  if (yDescriptor.columnCount !== 1) {
    throw new Error("Select exactly one outcome (Y) column.");
  }
  if (xDescriptor.rowIndex !== yDescriptor.rowIndex || xDescriptor.rowCount !== yDescriptor.rowCount) {
    throw new Error("X and Y must start on the same row and have the same number of rows.");
  }
  if (isOverlap(xDescriptor, yDescriptor)) {
    throw new Error("The outcome column cannot overlap with feature columns.");
  }
  if (!xValues.length || !yValues.length) {
    throw new Error("The selected ranges are empty.");
  }

  const headerOffset = hasHeader ? 1 : 0;
  let featureNames, rows, labels, outcomeName = "Outcome";
  if (hasHeader) {
    if (xValues.length < 2) throw new Error("A header row requires at least one data row.");
    featureNames = validateHeaderRow(xValues[0]);
    if (isBlank(yValues[0][0])) throw new Error("The outcome header cannot be blank.");
    outcomeName = String(yValues[0][0]).trim();
    rows = xValues.slice(1);
    labels = yValues.slice(1).map((r) => r[0]);
  } else {
    featureNames = Array.from({ length: xDescriptor.columnCount }, (_, i) => "X" + (i + 1));
    rows = xValues;
    labels = yValues.map((r) => r[0]);
  }

  const firstDataRow = xDescriptor.rowIndex + headerOffset + 1;
  const numeric = validateNumericRows(rows, featureNames, firstDataRow);
  const labelInfo = validateLabels(labels, firstDataRow);

  TOTAL_USABLE_ROWS = labels.length;
  updateSplitSummary(
    Number(document.getElementById("train-pct").value) || 70,
    Number(document.getElementById("test-pct").value) || 30
  );

  renderPreview({
    featureNames,
    labels: labelInfo.labels,
    classLabels: labelInfo.classLabels,
    constantFeatures: numeric.constantFeatures,
    features: numeric.features,
    source: {
      x: xDescriptor,
      y: yDescriptor,
    },
  });

  return {
    features: numeric.features,
    labels: labelInfo.labels,
    featureNames,
    source: {
      x: xDescriptor,
      y: yDescriptor,
      hasHeader,
      firstDataRow,
      featureNames,
      outcomeName,
      createdAt: new Date().toISOString(),
    },
  };
}

async function profileTable() {
  const tableInput = document.getElementById("table-range");
  const address = tableInput ? tableInput.value.trim() : "";
  if (!address) {
    showError("Select a table range or Excel named range.");
    return;
  }

  const profileBtn = document.getElementById("profile-table-btn");
  if (profileBtn) {
    profileBtn.disabled = true;
    profileBtn.textContent = "Inspecting columns…";
  }

  const reqProfRev = ++TABLE_PROFILE_REVISION;

  try {
    let descriptor = null;
    let headers = null;
    let rows = null;

    if (typeof Excel !== "undefined" && Excel.run) {
      await Excel.run(async (context) => {
        const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
        activeWorksheet.load("id,name");
        await context.sync();
        const res = await resolveRangeInput(context, address, { fieldName: "Table", activeWorksheet });
        descriptor = res.descriptor;
      });
    }

    if (reqProfRev !== TABLE_PROFILE_REVISION) return;

    if (!descriptor || !descriptor.values || descriptor.values.length < 2) {
      throw new Error("Table must have a header row and at least 1 data row.");
    }

    const startRow = (descriptor && descriptor.rowIndex != null) ? descriptor.rowIndex + 1 : 1;
    const startCol = (descriptor && descriptor.columnIndex != null) ? descriptor.columnIndex + 1 : 1;

    headers = descriptor.values[0].map((h, i) => (isBlank(h) ? `Column_${colIndexToLetter(startCol - 1 + i)}` : String(h).trim()));
    rows = descriptor.values.slice(1);

    const profile = await fetchJson(
      "/profile-table",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headers: headers,
          rows: rows,
          table_range: descriptor.absoluteAddress,
          worksheet_name: descriptor.resolvedWorksheetName || descriptor.worksheetName,
          start_row: startRow,
          start_col: startCol,
        }),
      },
      REQUEST_TIMEOUT_MS,
      BACKEND_URL
    );

    if (reqProfRev !== TABLE_PROFILE_REVISION) return;

    TABLE_PROFILE_DATA = profile;
    TABLE_DESCRIPTOR = descriptor;
    TABLE_HEADERS = headers;
    TABLE_ROWS = rows;
    TABLE_FINGERPRINT = headers.join("|") + "::" + rows.length;

    renderTableProfile(profile, descriptor);
  } catch (err) {
    invalidateTableProfile();
    showError(err.message);
  } finally {
    if (profileBtn) {
      profileBtn.disabled = false;
      profileBtn.textContent = "Inspect table columns";
    }
  }
}

function renderTableProfile(profile, descriptor) {
  const profileCard = document.getElementById("table-profile-card");
  if (!profileCard) return;

  const summaryInfo = document.getElementById("table-summary-info");
  if (summaryInfo) {
    const addr = descriptor ? descriptor.absoluteAddress : "Table";
    summaryInfo.textContent = `${addr} · ${profile.total_rows} rows, ${profile.total_columns} columns`;
  }

  const ySelect = document.getElementById("table-y-select");
  if (ySelect) {
    ySelect.innerHTML = "";
    profile.columns.forEach((col) => {
      const opt = document.createElement("option");
      opt.value = String(col.index);
      opt.textContent = `${col.excel_col} · ${col.header} (${col.detected_type})`;
      if (profile.suggested_y && (col.header.toLowerCase() === profile.suggested_y.toLowerCase() || String(col.index) === String(profile.suggested_y))) {
        opt.selected = true;
      }
      ySelect.appendChild(opt);
    });
  }

  renderTableColumnsList(profile);
  profileCard.classList.remove("hidden");

  TOTAL_USABLE_ROWS = profile.usable_rows;
  updateSplitSummary(
    Number(document.getElementById("train-pct").value) || 70,
    Number(document.getElementById("test-pct").value) || 30
  );
}

function renderTableColumnsList(profile) {
  const list = document.getElementById("table-columns-list");
  if (!list) return;
  list.innerHTML = "";

  const selectedY = (document.getElementById("table-y-select") || {}).value || "";
  const yIndex = parseInt(selectedY, 10);
  const suggestedX = new Set(profile.suggested_x || []);

  profile.columns.forEach((col) => {
    const row = document.createElement("div");
    row.className = "table-col-row";
    row.id = `col-row-${col.index}`;

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "table-col-checkbox";
    cb.dataset.colIndex = String(col.index);
    cb.id = `col-cb-${col.index}`;

    const isY = !isNaN(yIndex)
      ? col.index === yIndex
      : col.header.toLowerCase() === selectedY.toLowerCase();
    if (isY) {
      cb.checked = false;
      cb.disabled = true;
      row.classList.add("disabled-col");
    } else {
      cb.checked = suggestedX.has(col.index);
      cb.disabled = false;
    }

    cb.addEventListener("change", () => {
      updateTableSelectionSummary();
      markRunStale();
    });

    const info = document.createElement("div");
    info.className = "table-col-header-info";

    const letterSpan = document.createElement("span");
    letterSpan.className = "table-col-letter";
    letterSpan.textContent = col.excel_col;

    const nameSpan = document.createElement("span");
    nameSpan.className = "table-col-name";
    nameSpan.textContent = col.header + (isY ? " (Outcome Y)" : "");

    const typeBadge = document.createElement("span");
    typeBadge.className = `badge-type badge-${col.detected_type}`;
    typeBadge.textContent = col.detected_type;

    info.appendChild(letterSpan);
    info.appendChild(nameSpan);
    info.appendChild(typeBadge);

    if (col.missing_count > 0) {
      const missingSpan = document.createElement("span");
      missingSpan.className = "tiny muted";
      const pct = ((col.missing_count / profile.total_rows) * 100).toFixed(1);
      missingSpan.textContent = `${col.missing_count} missing (${pct}%)`;
      info.appendChild(missingSpan);
    }

    if (col.is_leakage_candidate) {
      const leakAlert = document.createElement("span");
      leakAlert.className = "badge-type badge-warn";
      leakAlert.textContent = "⚠️ Leakage";
      leakAlert.title = col.leakage_reason || "Possible target leakage";
      info.appendChild(leakAlert);
    }

    row.appendChild(cb);
    row.appendChild(info);
    list.appendChild(row);
  });

  updateTableSelectionSummary();
}

function updateTableSelectionSummary() {
  const checkboxes = Array.from(document.querySelectorAll(".table-col-checkbox:checked"));
  const countEl = document.getElementById("table-selected-count");
  if (countEl) {
    countEl.textContent = `${checkboxes.length} feature${checkboxes.length === 1 ? "" : "s"} selected`;
  }

  const projEl = document.getElementById("table-projected-summary");
  if (projEl && TABLE_PROFILE_DATA) {
    const policy = (document.getElementById("table-missing-policy") || {}).value || "impute";
    const totalRows = TABLE_PROFILE_DATA.total_rows;
    if (policy === "drop_rows") {
      projEl.textContent = `Policy: complete cases only. Rows with missing cells in selected columns will be excluded before fitting.`;
    } else {
      projEl.textContent = `Projected: up to ${totalRows} rows. Missing numeric cells will be filled with train medians; missing categories with dedicated bucket.`;
    }
  }
}

function selectAllSuggestedTableColumns() {
  if (!TABLE_PROFILE_DATA) return;
  const selectedY = (document.getElementById("table-y-select") || {}).value || "";
  const yIndex = parseInt(selectedY, 10);
  const suggestedX = new Set(TABLE_PROFILE_DATA.suggested_x || []);
  document.querySelectorAll(".table-col-checkbox").forEach((cb) => {
    const idx = Number(cb.dataset.colIndex);
    const col = TABLE_PROFILE_DATA.columns[idx];
    const isY = !isNaN(yIndex)
      ? (col && col.index === yIndex)
      : (col && col.header.toLowerCase() === selectedY.toLowerCase());
    if (isY) {
      cb.checked = false;
      cb.disabled = true;
    } else {
      cb.checked = suggestedX.has(idx);
    }
  });
  updateTableSelectionSummary();
  markRunStale();
}

function clearAllTableColumns() {
  document.querySelectorAll(".table-col-checkbox").forEach((cb) => {
    cb.checked = false;
  });
  updateTableSelectionSummary();
  markRunStale();
}

function onTableYSelectChange() {
  if (TABLE_PROFILE_DATA) {
    renderTableColumnsList(TABLE_PROFILE_DATA);
  }
  markRunStale();
}

function onTableMissingPolicyChange() {
  updateTableSelectionSummary();
  markRunStale();
}

async function runTableTraining() {
  const tableAddress = document.getElementById("table-range").value;
  if (!tableAddress) {
    showError("Select a table range or Excel named range.");
    return;
  }

  if (!TABLE_PROFILE_DATA || !TABLE_DESCRIPTOR) {
    showError("Please click 'Inspect table columns' to profile the table before fitting.");
    return;
  }

  const ySelect = document.getElementById("table-y-select");
  const yVal = ySelect ? ySelect.value : "";
  const yColumn = yVal !== "" ? (isNaN(Number(yVal)) ? yVal : Number(yVal)) : (TABLE_PROFILE_DATA.suggested_y_index ?? 0);
  if (yColumn === null || yColumn === undefined || (typeof yColumn === "number" && isNaN(yColumn))) {
    showError("Select an outcome (Y) column.");
    return;
  }

  const checkboxes = Array.from(document.querySelectorAll(".table-col-checkbox:checked"));
  const selectedX = checkboxes.map((cb) => Number(cb.dataset.colIndex));
  if (!selectedX.length) {
    showError("Select at least one feature column (X).");
    return;
  }

  const button = document.getElementById("run-btn");
  button.disabled = true;
  button.textContent = "Fitting scratch model…";
  setModelActionsEnabled(false);

  const requestId = ++CURRENT_REQUEST_ID;
  const reqTrainRev = ++TRAIN_REVISION;
  const reqBackendUrl = BACKEND_URL;
  const testPctVal = Number(document.getElementById("test-pct").value) || 30;
  const testFraction = testPctVal / 100.0;
  const learningRate = Number(document.getElementById("learning-rate").value) || 0.1;
  const maxIterations = Number(document.getElementById("max-iter").value) || 10000;
  const tolerance = Number(document.getElementById("tolerance").value) || 1e-6;
  const l2Lambda = Number(document.getElementById("l2-lambda").value) || 0.0;
  const balance = document.getElementById("balance").checked;
  const cvEnabled = document.getElementById("cv").checked;
  const standardize = document.getElementById("standardize").checked;

  try {
    const missingPolicy = (document.getElementById("table-missing-policy") || {}).value || "impute";

    let currentHeaders = TABLE_HEADERS;
    let currentRows = TABLE_ROWS;
    let startRow = (TABLE_DESCRIPTOR && TABLE_DESCRIPTOR.rowIndex != null) ? TABLE_DESCRIPTOR.rowIndex + 1 : 1;
    let startCol = (TABLE_DESCRIPTOR && TABLE_DESCRIPTOR.columnIndex != null) ? TABLE_DESCRIPTOR.columnIndex + 1 : 1;

    if (typeof Excel !== "undefined" && Excel.run) {
      await Excel.run(async (context) => {
        const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
        activeWorksheet.load("id,name");
        await context.sync();
        const res = await resolveRangeInput(context, tableAddress, { fieldName: "Table", activeWorksheet });
        const vals = res.descriptor.values;
        if (vals && vals.length >= 2) {
          const freshStartCol = (res.descriptor.columnIndex != null) ? res.descriptor.columnIndex + 1 : 1;
          const freshHeaders = vals[0].map((h, i) => (isBlank(h) ? `Column_${colIndexToLetter(freshStartCol - 1 + i)}` : String(h).trim()));

          // Verify headers still match inspected snapshot
          if (
            TABLE_HEADERS &&
            (freshHeaders.length !== TABLE_HEADERS.length || freshHeaders.some((h, i) => h !== TABLE_HEADERS[i]))
          ) {
            invalidateTableProfile();
            throw new Error(
              "Table headers or columns have changed since inspection. Please click 'Inspect table columns' to re-inspect before fitting."
            );
          }

          currentHeaders = freshHeaders;
          currentRows = vals.slice(1);
          TABLE_DESCRIPTOR = res.descriptor;
          startRow = (res.descriptor.rowIndex != null) ? res.descriptor.rowIndex + 1 : 1;
          startCol = freshStartCol;
        }
      });
    }

    if (requestId !== CURRENT_REQUEST_ID || reqTrainRev !== TRAIN_REVISION || reqBackendUrl !== BACKEND_URL) return;

    const payload = {
      headers: currentHeaders,
      rows: currentRows,
      y_column: yColumn,
      selected_x_columns: selectedX,
      missing_policy: missingPolicy,
      impute_numeric: "median",
      test_size: testFraction,
      learning_rate: learningRate,
      max_iterations: maxIterations,
      tolerance: tolerance,
      l2_lambda: l2Lambda,
      class_weight: balance ? "balanced" : null,
      cv_folds: cvEnabled ? 5 : 0,
      random_state: 42,
      standardize: standardize,
      start_row: startRow,
      start_col: startCol,
    };

    const result = await fetchJson(
      "/train-table",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      REQUEST_TIMEOUT_MS,
      reqBackendUrl
    );

    if (requestId !== CURRENT_REQUEST_ID || reqTrainRev !== TRAIN_REVISION || reqBackendUrl !== BACKEND_URL) return;

    LAST_RESULT = {
      ...result,
      _source: TABLE_DESCRIPTOR,
      _activeThreshold: Number(result.threshold.value),
      _stale: false,
      _trainedAt: new Date().toISOString(),
      training_revision: reqTrainRev,
      backend_url: reqBackendUrl,
    };

    WHATIF_REVISION++;
    NEW_PRED_REVISION++;
    clearNewPrediction();
    renderResults(LAST_RESULT);
    setModelActionsEnabled(true);
  } catch (error) {
    if (requestId === CURRENT_REQUEST_ID && reqTrainRev === TRAIN_REVISION && reqBackendUrl === BACKEND_URL) {
      clearActiveModel();
      showError(error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Fit scratch model";
  }
}

async function runNumericModel() {
  const yAddress = document.getElementById("y-range").value;
  const xAddress = document.getElementById("x-range").value;
  if (!yAddress || !xAddress) {
    showError("Select both an outcome Y range and feature X range.");
    return;
  }

  const button = document.getElementById("run-btn");
  button.disabled = true;
  button.textContent = "Fitting scratch model…";
  setModelActionsEnabled(false);

  // Snapshot request ID, training revision, backend URL, and settings
  const requestId = ++CURRENT_REQUEST_ID;
  const reqTrainRev = ++TRAIN_REVISION;
  const reqBackendUrl = BACKEND_URL;
  const testPctVal = Number(document.getElementById("test-pct").value) || 30;
  const testFraction = testPctVal / 100.0;
  const learningRate = Number(document.getElementById("learning-rate").value) || 0.1;
  const maxIterations = Number(document.getElementById("max-iter").value) || 10000;
  const tolerance = Number(document.getElementById("tolerance").value) || 1e-6;
  const l2Lambda = Number(document.getElementById("l2-lambda").value) || 0.0;
  const balance = document.getElementById("balance").checked;
  const cvEnabled = document.getElementById("cv").checked;
  const standardize = document.getElementById("standardize").checked;

  try {
    const input = await readTrainingData(yAddress, xAddress);

    // Check if another request or settings change was initiated during worksheet read
    if (requestId !== CURRENT_REQUEST_ID || reqTrainRev !== TRAIN_REVISION || reqBackendUrl !== BACKEND_URL) return;

    const payload = {
      features: input.features,
      labels: input.labels,
      feature_names: input.featureNames,
      standardize: standardize,
      test_size: testFraction,
      learning_rate: learningRate,
      max_iterations: maxIterations,
      tolerance: tolerance,
      l2_lambda: l2Lambda,
      class_weight: balance ? "balanced" : null,
      cv_folds: cvEnabled ? 5 : 0,
      random_state: 42,
    };

    const result = await fetchJson(
      "/train",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      REQUEST_TIMEOUT_MS,
      reqBackendUrl
    );

    // Check if another request or settings change was initiated during training fetch
    if (requestId !== CURRENT_REQUEST_ID || reqTrainRev !== TRAIN_REVISION || reqBackendUrl !== BACKEND_URL) return;

    LAST_RESULT = {
      ...result,
      _source: input.source,
      _activeThreshold: Number(result.threshold.value),
      _stale: false,
      _trainedAt: new Date().toISOString(),
      training_revision: reqTrainRev,
      backend_url: reqBackendUrl,
    };

    WHATIF_REVISION++;
    NEW_PRED_REVISION++;
    clearNewPrediction();
    renderResults(LAST_RESULT);
    setModelActionsEnabled(true);
  } catch (error) {
    if (requestId === CURRENT_REQUEST_ID && reqTrainRev === TRAIN_REVISION && reqBackendUrl === BACKEND_URL) {
      clearActiveModel();
      showError(error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Fit scratch model";
  }
}

async function runModel() {
  const tableInput = document.getElementById("table-range");
  if (CURRENT_MODE === "table" && tableInput && tableInput.value.trim()) {
    return runTableTraining();
  }
  return runNumericModel();
}

function setMetric(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (value === null || value === undefined) ? "n/a" : Number(value).toFixed(3);
}

function renderResults(result) {
  document.getElementById("results").classList.remove("hidden");
  const evaluation = result.evaluation;
  const split = result.split;

  const totalN = result.n_samples || (result.table_metadata ? result.table_metadata.usable_rows : (split.n_train + split.n_test));
  const trainPct = split.actual_train_percent != null ? split.actual_train_percent : Math.round((split.n_train / (split.n_train + split.n_test)) * 100);
  const testPct = split.actual_test_percent != null ? split.actual_test_percent : Math.round((split.n_test / (split.n_train + split.n_test)) * 100);

  document.getElementById("eval-note").textContent =
    `· ${totalN} rows; train ${split.n_train} (${trainPct}%), ` +
    `test ${split.n_test} (${testPct}%)`;

  // Render Table Preparation & Metadata summary if Table Mode
  const tableSummaryCard = document.getElementById("table-results-summary");
  if (tableSummaryCard) {
    if (result.table_mode && result.table_metadata) {
      const meta = result.table_metadata;
      const rowsInfoEl = document.getElementById("table-results-rows-info");
      if (rowsInfoEl) {
        let text = `Dataset: ${meta.usable_rows} usable rows (${split.n_train} train, ${split.n_test} test) out of ${meta.total_rows} total rows.`;
        if (meta.excluded_missing_y_rows && meta.excluded_missing_y_rows.length > 0) {
          text += ` Excluded ${meta.excluded_missing_y_rows.length} rows with missing outcome.`;
        }
        if (meta.excluded_missing_x_rows && meta.excluded_missing_x_rows.length > 0) {
          text += ` Complete case policy excluded ${meta.excluded_missing_x_rows.length} rows with missing cells.`;
        }
        rowsInfoEl.textContent = text;
      }
      const encInfoEl = document.getElementById("table-results-encodings-info");
      if (encInfoEl) {
        const specs = meta.column_specs || [];
        const encLines = specs.map((s) => {
          const h = s.source_header || s.header;
          if (s.col_type === "categorical") {
            return `${h}: categorical (reference level: ${s.reference_category || "first"})`;
          }
          if (s.col_type === "numeric") {
            return `${h}: numeric (train median: ${s.impute_value !== null ? s.impute_value : "n/a"})`;
          }
          return `${h}: ${s.col_type}`;
        });
        encInfoEl.textContent = "Saved preparation rules: " + encLines.join(" · ");
      }
      tableSummaryCard.classList.remove("hidden");
    } else {
      tableSummaryCard.classList.add("hidden");
    }
  }

  // Render diagnostics banner
  const diag = result.diagnostics || {};
  const badge = document.getElementById("diag-status-badge");
  if (diag.converged) {
    badge.textContent = "Converged ✓";
    badge.className = "status-badge converged";
  } else {
    const stopReason = (diag.stop_reason || "").toLowerCase();
    if (stopReason.includes("step-halving")) {
      badge.textContent = "Halted (Step-Halving)";
    } else if (stopReason.includes("separation") || stopReason.includes("divergence")) {
      badge.textContent = "Stopped (Separation)";
    } else if (stopReason.includes("maximum iterations")) {
      badge.textContent = "Reached Iteration Cap";
    } else {
      badge.textContent = "Not Converged";
    }
    badge.className = "status-badge capped";
  }

  document.getElementById("d-init-loss").textContent = diag.initial_loss != null ? diag.initial_loss.toFixed(4) : "–";
  document.getElementById("d-final-loss").textContent = diag.final_loss != null ? diag.final_loss.toFixed(4) : "–";
  document.getElementById("d-iters").textContent = diag.iterations !== undefined ? String(diag.iterations) : "–";
  document.getElementById("d-grad-norm").textContent =
    diag.gradient_norm != null
      ? diag.gradient_norm.toExponential(2)
      : "–";
  document.getElementById("diag-stop-reason").textContent =
    `Stop reason: ${diag.stop_reason || "Completed"} · Time: ${diag.elapsed_seconds || 0}s · Step reductions: ${diag.step_reductions || 0}`;

  // Render bounded Training Loss Curve with actual objective title
  const lambda = (result.training_settings && result.training_settings.l2_lambda) || 0;
  const isBalanced = result.training_settings && result.training_settings.class_weight === "balanced";
  const objName = (lambda > 0 ? "Regularized " : "") + (isBalanced ? "Weighted " : "") + "Cross-entropy J(w,b)";
  renderLossCurve(diag.loss_history || [], objName);

  // Performance metrics at 0.50
  const metrics = result.metrics;
  setMetric("m-acc", metrics.accuracy);
  setMetric("m-auc", metrics.auc);
  setMetric("m-prec", metrics.precision);
  setMetric("m-rec", metrics.recall);

  const gain = metrics.accuracy_gain;
  document.getElementById("quality-note").textContent =
    `Train majority-class baseline: ${metrics.baseline_accuracy != null ? metrics.baseline_accuracy.toFixed(3) : "n/a"}; ` +
    `accuracy change @ 0.50: ${gain != null ? ((gain >= 0 ? "+" : "") + gain.toFixed(3)) : "n/a"}. ` +
    `Log loss: ${metrics.log_loss != null ? metrics.log_loss.toFixed(4) : "n/a"}; Brier score: ${metrics.brier_score != null ? metrics.brier_score.toFixed(4) : "n/a"}.`;

  // Surface training warnings, separation alerts, and evaluation notices
  const warnEl = document.getElementById("eval-warning");
  if (warnEl) {
    const warnings = [];
    if (result.training_warnings && result.training_warnings.length) {
      warnings.push(...result.training_warnings);
    }
    if (result.cross_validation && result.cross_validation.warnings && result.cross_validation.warnings.length) {
      warnings.push(...result.cross_validation.warnings);
    }
    if (result.evaluation && result.evaluation.warning) {
      warnings.push(result.evaluation.warning);
    }
    if (warnings.length > 0) {
      warnEl.textContent = "Warning: " + warnings.join(" | ");
      warnEl.classList.remove("hidden");
    } else {
      warnEl.textContent = "";
      warnEl.classList.add("hidden");
    }
  }

  const cvNote = document.getElementById("cv-note");
  if (result.cross_validation && result.cross_validation.available) {
    const cv = result.cross_validation;
    let cvText =
      `${cv.actual_folds}-fold training CV — AUC ${cv.auc_mean != null ? cv.auc_mean.toFixed(3) : "n/a"} ± ${cv.auc_std != null ? cv.auc_std.toFixed(3) : "n/a"}, ` +
      `accuracy @ 0.50: ${cv.accuracy_mean != null ? cv.accuracy_mean.toFixed(3) : "n/a"} ± ${cv.accuracy_std != null ? cv.accuracy_std.toFixed(3) : "n/a"}.`;
    if (cv.converged_folds !== undefined && cv.converged_folds < cv.actual_folds) {
      cvText += ` (${cv.converged_folds}/${cv.actual_folds} folds converged).`;
    }
    cvNote.textContent = cvText;
    cvNote.classList.remove("hidden");
  } else if (result.cross_validation) {
    cvNote.textContent = "Cross-validation unavailable: " + result.cross_validation.reason;
    cvNote.classList.remove("hidden");
  }

  // Render learned parameters (w, b) and score/sigmoid equations
  renderParametersAndEquations(result);

  // Safe text-node rendering of Coefficients table (bounded to 50 rows)
  const tbody = document.querySelector("#coef-table tbody");
  tbody.innerHTML = "";
  const displayCoefs = result.coefficients.slice(0, 50);
  displayCoefs.forEach((c) => {
    const row = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = c.name;
    const tdCoef = document.createElement("td");
    tdCoef.textContent = `${c.coef >= 0 ? "+" : ""}${c.coef.toFixed(3)}`;
    const tdOdds = document.createElement("td");
    tdOdds.textContent = c.odds_ratio === null ? "inf" : (c.odds_ratio != null ? c.odds_ratio.toFixed(2) : "–");
    const tdP = document.createElement("td");
    tdP.textContent = (c.p_value == null) ? "n/a" : (c.p_value < 0.001 ? "<0.001" : c.p_value.toFixed(3));
    row.appendChild(tdName);
    row.appendChild(tdCoef);
    row.appendChild(tdOdds);
    row.appendChild(tdP);
    tbody.appendChild(row);
  });

  let infText = result.inference.reason || "P-values are n/a for scratch gradient descent.";
  if (result.coefficients.length > 50) {
    infText += ` (Displaying top 50 of ${result.coefficients.length} coefficients; full table exported in report).`;
  }
  document.getElementById("inference-note").textContent = infText;

  renderCoefChart(result.coefficients);
  renderRocChart(result.roc, metrics.auc);

  // Set threshold slider to suggested value
  const thresholdSlider = document.getElementById("threshold");
  const suggestedThr = result.suggested_threshold != null ? result.suggested_threshold : (result.threshold?.value ?? 0.5);
  thresholdSlider.value = suggestedThr.toFixed(2);
  document.getElementById("threshold-out").textContent = suggestedThr.toFixed(2);
  const thrNote = result.threshold?.note || result.threshold?.source || "default";
  document.getElementById("thr-suggest").textContent =
    `Suggested threshold: ${suggestedThr.toFixed(2)} (${thrNote}).`;

  updateConfusion(suggestedThr);
  buildWhatIf(result.feature_names);
}

function updateDecisionRuleText(threshold) {
  const el = document.getElementById("eq-decision-text");
  if (!el || !LAST_RESULT) return;
  const pos = LAST_RESULT.class_labels?.positive ?? "1";
  const neg = LAST_RESULT.class_labels?.negative ?? "0";
  el.textContent = `Class = "${pos}" (1) if p ≥ ${threshold.toFixed(2)}, else "${neg}" (0)`;
}

function renderParametersTable(result = LAST_RESULT) {
  if (!result) return;
  const tbody = document.querySelector("#params-table tbody");
  if (!tbody) return;

  const params = result.parameters || {};
  const names = result.feature_names || [];
  const wModel = params.weights_model_space || [];
  const bModel = params.intercept_model_space ?? 0;
  const wOrig = params.weights_original_units || [];
  const bOrig = params.intercept_original_units ?? 0;
  const conversionValid = Boolean(params.conversion_valid);

  const query = (PARAMS_SEARCH_QUERY || "").trim().toLowerCase();
  const allFeatures = names.map((name, i) => ({
    index: i,
    name,
    wModel: wModel[i],
    wOrig: wOrig[i],
  }));

  const filtered = query
    ? allFeatures.filter((f) => f.name.toLowerCase().includes(query))
    : allFeatures;

  const totalPages = Math.max(1, Math.ceil(filtered.length / PARAMS_PAGE_SIZE));
  if (PARAMS_CURRENT_PAGE > totalPages) PARAMS_CURRENT_PAGE = totalPages;
  if (PARAMS_CURRENT_PAGE < 1) PARAMS_CURRENT_PAGE = 1;

  tbody.textContent = "";

  // Intercept row on page 1 if query empty or matches intercept
  if (PARAMS_CURRENT_PAGE === 1 && (!query || query.includes("intercept") || query.includes("bias") || query === "b")) {
    const trB = document.createElement("tr");
    const tdBParam = document.createElement("td");
    tdBParam.textContent = "b";
    const tdBName = document.createElement("td");
    tdBName.textContent = "Intercept (Bias)";
    const tdBModel = document.createElement("td");
    tdBModel.textContent = (bModel >= 0 ? "+" : "") + Number(bModel).toFixed(4);
    const tdBOrig = document.createElement("td");
    tdBOrig.textContent = conversionValid ? (bOrig >= 0 ? "+" : "") + Number(bOrig).toFixed(4) : "n/a";
    trB.appendChild(tdBParam);
    trB.appendChild(tdBName);
    trB.appendChild(tdBModel);
    trB.appendChild(tdBOrig);
    tbody.appendChild(trB);
  }

  const startIdx = (PARAMS_CURRENT_PAGE - 1) * PARAMS_PAGE_SIZE;
  const pageItems = filtered.slice(startIdx, startIdx + PARAMS_PAGE_SIZE);

  const specs = (result.table_mode && result.table_metadata) ? result.table_metadata.column_specs || [] : [];
  const refMap = {};
  specs.forEach((s) => {
    if (s.reference_category) {
      refMap[s.header] = s.reference_category;
    }
  });

  pageItems.forEach((item) => {
    const tr = document.createElement("tr");
    const tdParam = document.createElement("td");
    tdParam.textContent = `w${item.index + 1}`;
    const tdName = document.createElement("td");
    let displayName = item.name;
    if (result.table_mode) {
      const eqIdx = item.name.indexOf("=");
      if (eqIdx !== -1) {
        const colHeader = item.name.slice(0, eqIdx);
        if (refMap[colHeader]) {
          displayName += ` (ref: ${refMap[colHeader]})`;
        }
      }
    }
    tdName.textContent = displayName;
    const tdModel = document.createElement("td");
    tdModel.textContent = (item.wModel >= 0 ? "+" : "") + (item.wModel !== undefined ? Number(item.wModel).toFixed(4) : "–");
    const tdOrig = document.createElement("td");
    tdOrig.textContent = conversionValid && item.wOrig !== undefined ? (item.wOrig >= 0 ? "+" : "") + Number(item.wOrig).toFixed(4) : "n/a";
    tr.appendChild(tdParam);
    tr.appendChild(tdName);
    tr.appendChild(tdModel);
    tr.appendChild(tdOrig);
    tbody.appendChild(tr);
  });

  // Update pagination controls
  const prevBtn = document.getElementById("params-prev-btn");
  const nextBtn = document.getElementById("params-next-btn");
  const pageInfo = document.getElementById("params-page-info");
  const paginationBar = document.getElementById("params-pagination");

  if (prevBtn) prevBtn.disabled = PARAMS_CURRENT_PAGE <= 1;
  if (nextBtn) nextBtn.disabled = PARAMS_CURRENT_PAGE >= totalPages;
  if (pageInfo) {
    pageInfo.textContent = `Page ${PARAMS_CURRENT_PAGE} of ${totalPages} (${filtered.length} features)`;
  }
  if (paginationBar) {
    paginationBar.classList.toggle("hidden", totalPages <= 1 && names.length <= PARAMS_PAGE_SIZE && !query);
  }

  const interpNote = document.getElementById("param-interp-note");
  if (interpNote) {
    let noteText = "Model-space weights apply to standardised features (per std dev). Original-unit weights apply directly to raw Excel values. Parameters express statistical associations, not causal effects.";
    if (names.length > PARAMS_PAGE_SIZE || query) {
      const fromNum = filtered.length > 0 ? startIdx + 1 : 0;
      const toNum = Math.min(startIdx + PARAMS_PAGE_SIZE, filtered.length);
      noteText = `Showing parameters ${fromNum}–${toNum} of ${filtered.length}. Use Prev/Next or Search to inspect all parameters. Click "Export model weights" for the full parameter table. ` + noteText;
    }
    interpNote.textContent = noteText;
  }
}

function renderParametersAndEquations(result) {
  const params = result.parameters || {};
  const names = result.feature_names || [];
  const wModel = params.weights_model_space || [];
  const bModel = params.intercept_model_space ?? 0;
  const wOrig = params.weights_original_units || [];
  const bOrig = params.intercept_original_units ?? 0;
  const isStd = Boolean(params.standardized);
  const conversionValid = Boolean(params.conversion_valid);

  renderParametersTable(result);

  // 2. Score Equation text
  const eqScore = document.getElementById("eq-score-text");
  const eqUnitNote = document.getElementById("eq-unit-note");
  if (eqScore) {
    if (names.length <= 10) {
      if (conversionValid) {
        const terms = names.map((name, i) => {
          const w = wOrig[i] ?? 0;
          return `(${w >= 0 ? "+" : ""}${w.toFixed(4)})·x${i + 1}`;
        });
        const biasTerm = `(${bOrig >= 0 ? "+" : ""}${bOrig.toFixed(4)})`;
        eqScore.textContent = `z = ${terms.join(" + ")} + ${biasTerm}`;
        if (eqUnitNote) {
          eqUnitNote.textContent = isStd
            ? "Equation uses original raw Excel feature units (converted from model space)."
            : "Equation uses unstandardised raw feature units.";
        }
      } else {
        const terms = names.map((name, i) => {
          const w = wModel[i] ?? 0;
          return `(${w >= 0 ? "+" : ""}${w.toFixed(4)})·x̂${i + 1}`;
        });
        const biasTerm = `(${bModel >= 0 ? "+" : ""}${bModel.toFixed(4)})`;
        eqScore.textContent = `z = ${terms.join(" + ")} + ${biasTerm}`;
        if (eqUnitNote) {
          eqUnitNote.textContent = "Equation uses standardised feature inputs x̂ = (x - μ) / σ (raw conversion invalid).";
        }
      }
    } else {
      if (conversionValid) {
        eqScore.textContent = `z = Σ (wⱼ · xⱼ) + b   [j = 1..${names.length}]`;
        if (eqUnitNote) {
          eqUnitNote.textContent = `Compact summation for ${names.length} features in raw units. Click "Export model weights" for the complete parameter table.`;
        }
      } else {
        eqScore.textContent = `z = Σ (w_modelⱼ · x̂ⱼ) + b_model   [x̂ = (x-μ)/σ, j = 1..${names.length}]`;
        if (eqUnitNote) {
          eqUnitNote.textContent = `Compact standardized summation for ${names.length} features. Click "Export model weights" for the complete parameter table.`;
        }
      }
    }
  }

  // 3. Decision rule text
  updateDecisionRuleText(result._activeThreshold || result.suggested_threshold || 0.5);
}

function renderLossCurve(lossHistory, yTitle = "Cross-entropy J(w,b)") {
  const canvas = document.getElementById("loss-chart");
  if (!canvas) return;
  if (lossChart) lossChart.destroy();

  const labels = lossHistory.map((p) => p.iteration);
  const data = lossHistory.map((p) => p.loss);

  lossChart = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: yTitle,
          data,
          borderColor: "#1d9e75",
          backgroundColor: "rgba(29, 158, 117, 0.08)",
          borderWidth: 2,
          fill: true,
          tension: 0.1,
          pointRadius: lossHistory.length <= 25 ? 3 : 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => `Iteration ${items[0].label}`,
            label: (item) => `Loss: ${Number(item.raw).toFixed(5)}`,
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: "Iteration pass", font: { size: 10 } },
          ticks: { font: { size: 9 }, maxTicksLimit: 8 },
        },
        y: {
          title: { display: true, text: yTitle, font: { size: 10 } },
          ticks: { font: { size: 9 } },
        },
      },
    },
  });
}

function renderCoefChart(coefficients) {
  const canvas = document.getElementById("coef-chart");
  if (!canvas) return;
  if (coefChart) coefChart.destroy();

  const allFeatures = coefficients.filter((c) => c.name !== "Intercept");
  let features = allFeatures;
  if (features.length > 20) {
    features = [...allFeatures].sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)).slice(0, 20);
  }

  coefChart = new Chart(canvas, {
    type: "bar",
    data: {
      labels: features.map((c) => c.name),
      datasets: [
        {
          data: features.map((c) => c.coef),
          backgroundColor: features.map((c) => (c.coef >= 0 ? "#1d9e75" : "#a32d2d")),
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: {
          display: allFeatures.length > 20,
          text: `Top 20 features by absolute weight (out of ${allFeatures.length})`,
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 } } },
        y: { ticks: { font: { size: 10 } } },
      },
    },
  });
}

function renderRocChart(roc, auc) {
  const canvas = document.getElementById("roc-chart");
  if (!canvas) return;
  if (rocChart) rocChart.destroy();

  const aucInline = document.getElementById("auc-inline");
  if (aucInline) aucInline.textContent = auc !== null ? `(AUC = ${auc.toFixed(3)})` : "";

  if (!roc || !Array.isArray(roc.fpr) || !Array.isArray(roc.tpr)) return;
  const points = roc.fpr.map((x, i) => ({ x, y: roc.tpr[i] }));
  rocChart = new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        {
          label: "ROC",
          data: points,
          borderColor: "#185fa5",
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
        {
          label: "Chance",
          data: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
          borderColor: "#cdccc4",
          borderDash: [4, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { type: "linear", min: 0, max: 1, title: { display: true, text: "False Positive Rate" } },
        y: { type: "linear", min: 0, max: 1, title: { display: true, text: "True Positive Rate" } },
      },
    },
  });
}

function updateConfusion(threshold) {
  if (!LAST_RESULT || !LAST_RESULT.threshold_data) return;
  LAST_RESULT._activeThreshold = threshold;
  updateDecisionRuleText(threshold);
  const data = LAST_RESULT.threshold_data;
  const yTrue = data.y_true;
  const probs = data.prob;

  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (let i = 0; i < probs.length; i += 1) {
    const pred = probs[i] >= threshold ? 1 : 0;
    const actual = yTrue[i];
    if (actual === 1 && pred === 1) tp += 1;
    else if (actual === 0 && pred === 0) tn += 1;
    else if (actual === 0 && pred === 1) fp += 1;
    else if (actual === 1 && pred === 0) fn += 1;
  }

  const container = document.getElementById("confusion");
  container.innerHTML =
    '<div class="cell head"></div><div class="cell head">Pred 0</div><div class="cell head">Pred 1</div>' +
    `<div class="cell head">Actual 0</div><div class="cell tn"><span class="big">${tn}</span>TN</div><div class="cell fp"><span class="big">${fp}</span>FP</div>` +
    `<div class="cell head">Actual 1</div><div class="cell fn"><span class="big">${fn}</span>FN</div><div class="cell tp"><span class="big">${tp}</span>TP</div>`;

  const total = tp + tn + fp + fn || 1;
  const accuracy = (tp + tn) / total;
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);

  LAST_RESULT._currentThresholdMetrics = {
    threshold, accuracy, precision, recall, f1, confusion: { tn, fp, fn, tp },
  };

  document.getElementById("t-acc").textContent = accuracy.toFixed(3);
  document.getElementById("t-prec").textContent = precision.toFixed(3);
  document.getElementById("t-rec").textContent = recall.toFixed(3);
  document.getElementById("t-f1").textContent = f1.toFixed(3);
}

function invalidateWhatIfExplanation() {
  if (LAST_RESULT) {
    LAST_RESULT._lastWhatIf = null;
    LAST_RESULT._lastWhatIfProb = null;
  }
  const resultBox = document.getElementById("whatif-result");
  if (resultBox) {
    resultBox.classList.add("hidden");
  }
}

function refreshWhatIfResultIfActive() {
  const resultBox = document.getElementById("whatif-result");
  if (!resultBox || resultBox.classList.contains("hidden")) return;
  if (!LAST_RESULT || !LAST_RESULT._lastWhatIf) return;

  const info = LAST_RESULT._lastWhatIf;
  const prob = info.prob;
  const threshold = LAST_RESULT._activeThreshold;
  const pred = prob >= threshold ? 1 : 0;
  const classLabel = pred === 1 ? LAST_RESULT.class_labels.positive : LAST_RESULT.class_labels.negative;

  const summary = document.getElementById("whatif-summary");
  if (summary) {
    summary.textContent =
      `Positive probability (${LAST_RESULT.class_labels.positive}): ${(prob * 100).toFixed(2)}%. ` +
      `Predicted class at threshold ${threshold.toFixed(2)}: ${classLabel}.`;
  }

  const stepDecision = document.getElementById("whatif-step-decision");
  if (stepDecision) {
    stepDecision.textContent =
      `5. Decision: p (${prob.toFixed(4)}) ${prob >= threshold ? "≥" : "<"} threshold (${threshold.toFixed(2)}) → Class ${pred} (${classLabel})`;
  }
}

function buildWhatIf(featureNames) {
  const box = document.getElementById("whatif-inputs");
  box.textContent = "";
  const whatIfBtn = document.getElementById("whatif-btn");

  if (LAST_RESULT && LAST_RESULT.table_mode && LAST_RESULT.table_metadata) {
    const colSpecs = LAST_RESULT.table_metadata.column_specs || [];
    if (colSpecs.length > 25) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = `Manual what-if inputs are limited to models with 25 or fewer source features (this model has ${colSpecs.length}). Use "Score new rows" below to score single or multiple rows.`;
      box.appendChild(note);
      if (whatIfBtn) whatIfBtn.disabled = true;
      invalidateWhatIfExplanation();
      return;
    }
    if (whatIfBtn && !LAST_RESULT._stale) {
      whatIfBtn.disabled = false;
    }

    colSpecs.forEach((spec) => {
      const headerName = spec.source_header || spec.header;
      const colIndex = spec.source_index != null ? spec.source_index : spec.index;
      const label = document.createElement("label");
      label.className = "field";
      const caption = document.createElement("span");
      caption.textContent = `${headerName} (${spec.col_type})`;
      label.appendChild(caption);

      if (spec.col_type === "categorical") {
        const select = document.createElement("select");
        select.className = "form-select";
        select.dataset.colIndex = String(colIndex);
        select.dataset.feature = headerName;
        select.dataset.colType = "categorical";

        const defOpt = document.createElement("option");
        defOpt.value = "";
        defOpt.textContent = `(Missing / Default: ${spec.reference_category || "Reference"})`;
        select.appendChild(defOpt);

        const catsToDisplay = spec.all_train_categories || spec.vocabulary || spec.categories || [];
        catsToDisplay.forEach((cat) => {
          if (cat === "_missing_") return;
          const opt = document.createElement("option");
          opt.value = cat;
          opt.textContent = `${cat}${cat === spec.reference_category ? " (Ref)" : ""}`;
          select.appendChild(opt);
        });

        select.addEventListener("change", invalidateWhatIfExplanation);
        label.appendChild(select);
      } else if (spec.col_type === "boolean") {
        const select = document.createElement("select");
        select.className = "form-select";
        select.dataset.colIndex = String(colIndex);
        select.dataset.feature = headerName;
        select.dataset.colType = "boolean";

        const optDefault = document.createElement("option");
        optDefault.value = "";
        optDefault.textContent = `(Default: ${spec.impute_value === 1.0 ? "True" : "False"})`;
        select.appendChild(optDefault);

        const optT = document.createElement("option");
        optT.value = "true";
        optT.textContent = "True";
        const optF = document.createElement("option");
        optF.value = "false";
        optF.textContent = "False";
        select.appendChild(optT);
        select.appendChild(optF);

        select.addEventListener("change", invalidateWhatIfExplanation);
        label.appendChild(select);
      } else {
        const input = document.createElement("input");
        input.type = "number";
        input.step = "any";
        input.placeholder = spec.impute_value !== null ? `Default: ${spec.impute_value}` : "Enter value";
        input.dataset.colIndex = String(colIndex);
        input.dataset.feature = headerName;
        input.dataset.colType = "numeric";
        input.addEventListener("input", invalidateWhatIfExplanation);
        label.appendChild(input);
      }

      box.appendChild(label);
    });
    invalidateWhatIfExplanation();
    return;
  }

  if (featureNames.length > 25) {
    const note = document.createElement("p");
    note.className = "muted small";
    note.textContent = `Manual what-if inputs are limited to models with 25 or fewer features (this model has ${featureNames.length}). Use "Score new rows" below to score single or multiple rows with all ${featureNames.length} features.`;
    box.appendChild(note);
    if (whatIfBtn) whatIfBtn.disabled = true;
    invalidateWhatIfExplanation();
    return;
  }
  if (whatIfBtn && LAST_RESULT && !LAST_RESULT._stale) {
    whatIfBtn.disabled = false;
  }
  featureNames.forEach((name) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    const input = document.createElement("input");
    caption.textContent = name;
    input.type = "number";
    input.step = "any";
    input.placeholder = "Enter value";
    input.dataset.feature = name;
    input.addEventListener("input", invalidateWhatIfExplanation);
    label.appendChild(caption);
    label.appendChild(input);
    box.appendChild(label);
  });
  invalidateWhatIfExplanation();
}

function readWhatIfRow() {
  if (LAST_RESULT && LAST_RESULT.table_mode && LAST_RESULT.table_metadata) {
    const inputs = Array.from(document.querySelectorAll("#whatif-inputs input, #whatif-inputs select"));
    return inputs.map((inp) => {
      const type = inp.dataset.colType;
      const val = inp.value.trim();
      if (type === "numeric") {
        if (val === "") return null;
        const num = Number(val);
        if (!Number.isFinite(num)) throw new Error(`${inp.dataset.feature} must be a finite number.`);
        return num;
      }
      if (type === "boolean") {
        if (val === "") return null;
        return val.toLowerCase() === "true";
      }
      return val === "" ? null : val;
    });
  }

  return Array.from(document.querySelectorAll("#whatif-inputs input")).map((input) => {
    if (input.value.trim() === "") throw new Error("Enter a value for " + input.dataset.feature + ".");
    const val = Number(input.value);
    if (!Number.isFinite(val)) throw new Error(input.dataset.feature + " must be a finite number.");
    return val;
  });
}

async function runWhatIf() {
  if (!ensureActiveModel()) return;
  const snapshot = LAST_RESULT;
  const reqModelId = snapshot.model_id;
  const reqBackendUrl = BACKEND_URL;
  const reqTrainRev = TRAIN_REVISION;
  const reqWhatIfRev = ++WHATIF_REVISION;

  let rowValues;
  try {
    rowValues = readWhatIfRow();
  } catch (err) {
    showError(err.message);
    return;
  }

  const whatIfBtn = document.getElementById("whatif-btn");
  if (whatIfBtn) {
    whatIfBtn.disabled = true;
    whatIfBtn.textContent = "Calculating…";
  }

  try {
    let data;
    if (snapshot.table_mode && snapshot.table_metadata) {
      const colSpecs = snapshot.table_metadata.column_specs || [];
      const sourceHeaders = snapshot.table_metadata.source_headers || [];
      const rawRow = new Array(sourceHeaders.length).fill(null);

      colSpecs.forEach((spec, i) => {
        const idx = spec.source_index != null ? spec.source_index : spec.index;
        rawRow[idx] = rowValues[i];
      });

      data = await fetchJson(
        "/predict-table",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: reqModelId,
            headers: sourceHeaders,
            rows: [rawRow],
            threshold: snapshot._activeThreshold,
          }),
        },
        REQUEST_TIMEOUT_MS,
        reqBackendUrl
      );
    } else {
      data = await fetchJson(
        "/predict",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: reqModelId,
            features: [rowValues],
            threshold: snapshot._activeThreshold,
          }),
        },
        REQUEST_TIMEOUT_MS,
        reqBackendUrl
      );
    }

    // Stale check: reject late response if model, settings, backend, or what-if inputs changed
    if (
      WHATIF_REVISION !== reqWhatIfRev ||
      TRAIN_REVISION !== reqTrainRev ||
      !LAST_RESULT ||
      LAST_RESULT.model_id !== reqModelId ||
      LAST_RESULT._stale ||
      BACKEND_URL !== reqBackendUrl
    ) {
      return;
    }

    // Check if input fields changed in DOM while fetch was in flight
    let currentInputs;
    try {
      currentInputs = readWhatIfRow();
    } catch {
      return;
    }
    if (currentInputs.length !== rowValues.length || currentInputs.some((val, i) => val !== rowValues[i])) {
      return;
    }

    const result = data.results[0];
    const backendScore = result.score;
    const backendProb = result.prob;
    const currentThreshold = LAST_RESULT._activeThreshold;
    const calculatedPred = backendProb >= currentThreshold ? 1 : 0;
    const classLabel = calculatedPred === 1 ? data.class_labels.positive : data.class_labels.negative;

    // Render whatif summary
    const summary = document.getElementById("whatif-summary");
    if (summary) {
      summary.textContent =
        `Positive probability (${data.class_labels.positive}): ${(backendProb * 100).toFixed(2)}%. ` +
        `Predicted class at threshold ${currentThreshold.toFixed(2)}: ${classLabel}.`;
    }

    let contributions = [];
    let sumContributions = 0;
    const params = LAST_RESULT.parameters || {};
    const bModel = params.intercept_model_space ?? 0;
    let arithmeticDiff = 0;
    let hasDiscrepancy = false;

    const tbody = document.querySelector("#whatif-table tbody");
    if (tbody) {
      tbody.textContent = "";
      if (snapshot.table_mode && snapshot.table_metadata) {
        const specs = snapshot.table_metadata.column_specs || [];
        specs.slice(0, 25).forEach((spec, i) => {
          const val = rowValues[i];
          const tr = document.createElement("tr");
          const tdName = document.createElement("td");
          tdName.textContent = spec.source_header || spec.header;
          const tdRaw = document.createElement("td");
          tdRaw.textContent = val !== null && val !== undefined ? String(val) : "(missing)";
          const tdScaled = document.createElement("td");
          tdScaled.textContent = spec.col_type;
          const tdW = document.createElement("td");
          tdW.textContent = spec.col_type === "categorical" ? `ref: ${spec.reference_category || "base"}` : (spec.impute_value != null ? `med: ${spec.impute_value}` : "–");
          const tdContrib = document.createElement("td");
          tdContrib.textContent = "–";
          tr.appendChild(tdName);
          tr.appendChild(tdRaw);
          tr.appendChild(tdScaled);
          tr.appendChild(tdW);
          tr.appendChild(tdContrib);
          tbody.appendChild(tr);
        });
      } else {
        const featureNames = LAST_RESULT.feature_names || [];
        const wModel = params.weights_model_space || [];
        const means = params.feature_means;
        const scales = params.feature_scales;
        const isStd = Boolean(params.standardized && means && scales);

        featureNames.slice(0, 25).forEach((name, j) => {
          const xRaw = rowValues[j];
          const mean = isStd ? means[j] : 0;
          const scale = isStd ? scales[j] : 1;
          const xScaled = isStd ? (xRaw - mean) / scale : xRaw;
          const w = wModel[j] ?? 0;
          const contrib = w * xScaled;
          contributions.push(contrib);
          sumContributions += contrib;

          const tr = document.createElement("tr");
          const tdName = document.createElement("td");
          tdName.textContent = name;
          const tdRaw = document.createElement("td");
          tdRaw.textContent = Number.isFinite(xRaw) ? xRaw.toFixed(4) : String(xRaw);
          const tdScaled = document.createElement("td");
          tdScaled.textContent = isStd ? xScaled.toFixed(4) : "–";
          const tdW = document.createElement("td");
          tdW.textContent = w.toFixed(4);
          const tdContrib = document.createElement("td");
          tdContrib.textContent = (contrib >= 0 ? "+" : "") + contrib.toFixed(4);

          tr.appendChild(tdName);
          tr.appendChild(tdRaw);
          tr.appendChild(tdScaled);
          tr.appendChild(tdW);
          tr.appendChild(tdContrib);
          tbody.appendChild(tr);
        });

        arithmeticDiff = Math.abs(sumContributions + bModel - backendScore);
        hasDiscrepancy = arithmeticDiff > 1e-4;
      }
    }

    const stepsBox = document.getElementById("whatif-calculation-steps");
    if (stepsBox) {
      stepsBox.textContent = "";
      const step1 = document.createElement("div");
      step1.textContent = snapshot.table_mode
        ? "1. Raw table inputs prepared and encoded by saved pipeline"
        : `1. Sum of feature contributions: Σ(w_j · x̂_j) = ${sumContributions.toFixed(4)}`;
      const step2 = document.createElement("div");
      step2.textContent = `2. Intercept (bias): b = ${bModel.toFixed(4)}`;
      const step3 = document.createElement("div");
      step3.textContent = `3. Linear score: z = ${snapshot.table_mode ? backendScore.toFixed(4) : `Σ + b = ${backendScore.toFixed(4)}`}`;
      const step4 = document.createElement("div");
      step4.textContent = `4. Sigmoid probability: p = σ(${backendScore.toFixed(4)}) = ${(backendProb * 100).toFixed(2)}% (${backendProb.toFixed(6)})`;
      const step5 = document.createElement("div");
      step5.id = "whatif-step-decision";
      step5.textContent = `5. Decision: p (${backendProb.toFixed(4)}) ${backendProb >= currentThreshold ? "≥" : "<"} threshold (${currentThreshold.toFixed(2)}) → Class ${calculatedPred} (${classLabel})`;

      stepsBox.appendChild(step1);
      stepsBox.appendChild(step2);
      stepsBox.appendChild(step3);
      stepsBox.appendChild(step4);
      stepsBox.appendChild(step5);
    }

    let warnEl = document.getElementById("whatif-warning");
    if (hasDiscrepancy) {
      if (!warnEl) {
        warnEl = document.createElement("div");
        warnEl.id = "whatif-warning";
        warnEl.className = "notice";
        const resultBox = document.getElementById("whatif-result");
        if (resultBox) resultBox.insertBefore(warnEl, resultBox.firstChild);
      }
      warnEl.textContent = `Notice: Arithmetic sum Σ(w·x̂) + b (${(sumContributions + bModel).toFixed(6)}) differs from backend score (${backendScore.toFixed(6)}) by ${arithmeticDiff.toExponential(2)}.`;
      warnEl.classList.remove("hidden");
    } else if (warnEl) {
      warnEl.textContent = "";
      warnEl.classList.add("hidden");
    }

    LAST_RESULT._lastWhatIf = {
      row: rowValues,
      prob: backendProb,
      score: backendScore,
      pred: calculatedPred,
      contributions,
      sumContributions,
      b: bModel,
    };
    LAST_RESULT._lastWhatIfProb = backendProb;

    const resultBox = document.getElementById("whatif-result");
    if (resultBox) resultBox.classList.remove("hidden");
  } catch (error) {
    if (
      WHATIF_REVISION === reqWhatIfRev &&
      TRAIN_REVISION === reqTrainRev &&
      LAST_RESULT &&
      LAST_RESULT.model_id === reqModelId &&
      !LAST_RESULT._stale
    ) {
      showError(error.message);
    }
  } finally {
    if (whatIfBtn) {
      whatIfBtn.disabled = !LAST_RESULT || LAST_RESULT._stale || (LAST_RESULT?.feature_names?.length || 0) > 25;
      whatIfBtn.textContent = "Calculate probability";
    }
  }
}


async function sourceStillMatches(source) {
  if (!source) return false;
  try {
    return await Excel.run(async (context) => {
      if (source.x && source.y) {
        const xValid = await verifySourceDescriptor(context, source.x);
        const yValid = await verifySourceDescriptor(context, source.y);
        return xValid && yValid;
      }
      if (source.values || source.absoluteAddress) {
        return await verifySourceDescriptor(context, source);
      }
      return true;
    });
  } catch {
    return false;
  }
}

async function addUniqueWorksheet(context, prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const base = (prefix + " " + stamp).slice(0, 28);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix === 0 ? base : base.slice(0, 28) + " " + suffix;
    const existing = context.workbook.worksheets.getItemOrNullObject(name);
    await context.sync();
    if (existing.isNullObject) return context.workbook.worksheets.add(name);
  }
  throw new Error("Could not create a unique report worksheet.");
}

function sourceLabel(sheet, address) {
  if (!address) return "";
  if (address.includes("!")) return address;
  return sheet ? `'${sheet}'!${address}` : address;
}

function formatSourceExportLabel(descriptor) {
  if (!descriptor) return "";
  if (descriptor.table) descriptor = descriptor.table;
  if (descriptor.kind === "name") {
    return `${descriptor.originalText} (${descriptor.scope}) -> ${descriptor.absoluteAddress}`;
  }
  return descriptor.absoluteAddress || sourceLabel(descriptor.resolvedWorksheetName, descriptor.originalText || descriptor.address);
}

function reportMetadataRows(result) {
  const source = result._source || {};
  const split = result.split || {};
  const selected = result._currentThresholdMetrics || result.metrics_at_threshold || {};
  const diag = result.diagnostics || {};
  const settings = result.training_settings || {};
  const cv = result.cross_validation;

  const lambda = settings.l2_lambda || 0;
  const isBalanced = settings.class_weight === "balanced";
  let objFormula = "Mean binary cross-entropy: J(w,b) = -(1/m)*sum[y_i*ln(p_i) + (1-y_i)*ln(1-p_i)]";
  if (isBalanced && lambda > 0) {
    objFormula = `Weighted binary cross-entropy with L2 regularization (lambda=${lambda}): J(w,b) = sum[s_i*loss_i]/sum[s_i] + (lambda/2)*sum[w_j^2] (no penalty on b)`;
  } else if (lambda > 0) {
    objFormula = `Binary cross-entropy with L2 regularization (lambda=${lambda}): J(w,b) = -(1/m)*sum[y_i*ln(p_i) + (1-y_i)*ln(1-p_i)] + (lambda/2)*sum[w_j^2] (no penalty on b)`;
  } else if (isBalanced) {
    objFormula = "Weighted binary cross-entropy: J(w,b) = sum[s_i*loss_i]/sum[s_i]";
  }

  const cvSummary = cv && cv.available
    ? `${cv.actual_folds}-fold CV: AUC ${cv.auc_mean != null ? cv.auc_mean.toFixed(3) : "n/a"} ± ${cv.auc_std != null ? cv.auc_std.toFixed(3) : "n/a"}, Accuracy ${cv.accuracy_mean != null ? cv.accuracy_mean.toFixed(3) : "n/a"} ± ${cv.accuracy_std != null ? cv.accuracy_std.toFixed(3) : "n/a"} (${cv.converged_folds ?? cv.actual_folds}/${cv.actual_folds} folds converged)`
    : (cv && cv.reason ? `Unavailable (${cv.reason})` : "Disabled");

  const reqTrain = split.requested_train_percent ?? Math.round((1 - (settings.test_size ?? 0.3)) * 100);
  const reqTest = split.requested_test_percent ?? Math.round((settings.test_size ?? 0.3) * 100);

  const featureList = result.feature_names || [];
  let featuresVal = "";
  if (featureList.length <= 10) {
    featuresVal = featureList.map(prepareIdentityText).join(", ") + ` (${featureList.length} total)`;
  } else {
    const preview = featureList.slice(0, 10).map(prepareIdentityText).join(", ");
    featuresVal = `${preview} ... and ${featureList.length - 10} more (${featureList.length} total; see Parameters table for full feature order)`;
  }
  featuresVal = prepareDescription(featuresVal, 32000);

  const rows = [
    ["Logistic Regression Report (Scratch Engine)", ""],
    ["Trained Timestamp", result._trainedAt || result.trained_at || new Date().toISOString()],
    ["Model ID", prepareIdentityText(result.model_id)],
    ["Software Versions", `Package v0.1.0; Manifest v1.0.0.0; Python ${result.software?.python || "3.14"}; NumPy ${result.software?.numpy || "2.x"}`],
    ["Engine & Method", `${result.engine || "scratch"} (${result.method || "Full-batch gradient descent"})`],
    ["Objective Function", objFormula],
    ["Source X", source.x ? formatSourceExportLabel(source.x) : (source.absoluteAddress ? formatSourceExportLabel(source) : "–")],
    ["Source Y", source.y ? formatSourceExportLabel(source.y) : (result.table_metadata ? result.table_metadata.y_column_name : "–")],
    ["Features", featuresVal],
    ["Class Mapping", `0 = ${prepareIdentityText(result.class_labels.negative)}; 1 = ${prepareIdentityText(result.class_labels.positive)}`],
    ["Random Seed", String(settings.random_state ?? 42)],
    ["Maximum Iterations", String(settings.max_iterations ?? 10000)],
    ["Convergence Tolerance", String(settings.tolerance ?? 1e-6)],
    ["Class Balancing", settings.class_weight || "unweighted"],
    ["Requested Split", `Train ${reqTrain}%, Test ${reqTest}%`],
    ["Rows & Actual Allocation", `${result.n_samples || (result.table_metadata ? result.table_metadata.usable_rows : (split.n_train + split.n_test))} total; Train ${split.n_train} (${split.actual_train_percent}%), Test ${split.n_test} (${split.actual_test_percent}%)`],
    ["Convergence Status", `${diag.converged ? "Converged" : "Not Converged"} (${diag.stop_reason || ""})`],
    ["Optimization Stats", `Iterations: ${diag.iterations || 0}; Initial loss: ${diag.initial_loss != null ? diag.initial_loss.toFixed(4) : "–"}; Final loss: ${diag.final_loss != null ? diag.final_loss.toFixed(4) : "–"}; Grad norm: ${diag.gradient_norm != null ? diag.gradient_norm.toExponential(2) : "–"}`],
    ["Learning Rate alpha / L2 lambda", `${settings.learning_rate} / ${settings.l2_lambda}`],
    ["Cross-Validation", cvSummary],
    ["Preprocessing", result.standardized ? "Standardised using training-set means and population scales" : "Raw features"],
    ["Active Threshold", `Active ${result._activeThreshold.toFixed(2)}; suggested ${result.threshold.value.toFixed(2)} from ${result.threshold.source}`],
    ["0.50 Test Metrics", `Accuracy ${result.metrics.accuracy != null ? result.metrics.accuracy.toFixed(3) : "n/a"}, Precision ${result.metrics.precision != null ? result.metrics.precision.toFixed(3) : "n/a"}, Recall ${result.metrics.recall != null ? result.metrics.recall.toFixed(3) : "n/a"}, F1 ${result.metrics.f1 != null ? result.metrics.f1.toFixed(3) : "n/a"}, AUC ${result.metrics.auc != null ? result.metrics.auc.toFixed(3) : "n/a"}`],
    ["Active-Threshold Test Metrics", `Accuracy ${selected.accuracy != null ? selected.accuracy.toFixed(3) : "n/a"}, Precision ${selected.precision != null ? selected.precision.toFixed(3) : "n/a"}, Recall ${selected.recall != null ? selected.recall.toFixed(3) : "n/a"}, F1 ${selected.f1 != null ? selected.f1.toFixed(3) : "n/a"}`],
    ["Training Majority Baseline", `Baseline accuracy: ${result.metrics.baseline_accuracy != null ? result.metrics.baseline_accuracy.toFixed(3) : "n/a"}; gain @ 0.50: ${result.metrics.accuracy_gain != null ? ((result.metrics.accuracy_gain >= 0 ? "+" : "") + result.metrics.accuracy_gain.toFixed(3)) : "n/a"}`],
    ["Inference", result.inference?.reason || "P-values unavailable for scratch gradient descent."],
  ];

  if (result.table_mode && result.table_metadata) {
    const tMeta = result.table_metadata;
    rows.push(
      ["Analysis Mode", "Table Mode (Automatic Encoding & Preparation)"],
      ["Source Table", formatSourceExportLabel(source)],
      ["Outcome Column (Y)", `${tMeta.y_column_name} (Col ${colIndexToLetter(tMeta.y_column_index)})`],
      ["Selected Columns (X)", tMeta.selected_indices.map((i) => `${colIndexToLetter(i)} · ${tMeta.source_headers[i]}`).join(", ")],
      ["Missing Values Policy", tMeta.missing_policy === "drop_rows" ? "Complete Cases Only (Drop Missing)" : "Median / Category Imputation"],
      ["Total Input Rows", String(tMeta.total_rows)],
      ["Usable Modeling Rows", String(tMeta.usable_rows)],
      ["Excluded Missing Y Rows", String(tMeta.excluded_missing_y_rows ? tMeta.excluded_missing_y_rows.length : 0)],
      ["Excluded Missing X Rows", String(tMeta.excluded_missing_x_rows ? tMeta.excluded_missing_x_rows.length : 0)]
    );
  }

  if (result.training_warnings && result.training_warnings.length > 0) {
    const joined = result.training_warnings.join(" | ");
    if (joined.length <= 32000) {
      rows.push(["Training Warnings", joined]);
    } else {
      let remaining = joined;
      let part = 1;
      while (remaining.length > 0) {
        rows.push([`Training Warnings (Part ${part})`, prepareDescription(remaining.slice(0, 32000), 32000)]);
        remaining = remaining.slice(32000);
        part++;
      }
    }
  }
  if (cv && cv.warnings && cv.warnings.length > 0) {
    const joined = cv.warnings.join(" | ");
    if (joined.length <= 32000) {
      rows.push(["Cross-Validation Warnings", joined]);
    } else {
      let remaining = joined;
      let part = 1;
      while (remaining.length > 0) {
        rows.push([`Cross-Validation Warnings (Part ${part})`, prepareDescription(remaining.slice(0, 32000), 32000)]);
        remaining = remaining.slice(32000);
        part++;
      }
    }
  }

  return rows.map(([label, val]) => [
    escapeLiteralText(String(label)),
    typeof val === "string" ? escapeLiteralText(val) : val,
  ]);
}

async function writePredictions() {
  if (!ensureActiveModel()) return;
  const button = document.getElementById("writeback-btn");
  const origBtnText = button ? button.textContent : "Export full report to new sheet";
  if (button) {
    button.disabled = true;
    button.textContent = "Exporting…";
  }

  const targetResult = LAST_RESULT;
  const token = createExportToken("report", targetResult);
  const snapshot = {
    ...targetResult,
    _activeThreshold: targetResult._activeThreshold,
    _currentThresholdMetrics: targetResult._currentThresholdMetrics ? { ...targetResult._currentThresholdMetrics } : null,
  };
  let batchesCommitted = 0;

  try {
    const matches = await sourceStillMatches(snapshot._source);
    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed during export preparation. Export cancelled.");
    }
    if (!matches) {
      if (isExportTokenValid(token)) {
        markRunStale();
      }
      const isNamed = (snapshot._source.x && snapshot._source.x.kind === "name") ||
                      (snapshot._source.y && snapshot._source.y.kind === "name");
      if (isNamed) {
        throw new Error("The named range changed. Fit/score again.");
      } else {
        throw new Error("The training data changed after this model ran. Train again before exporting.");
      }
    }

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed during export preparation. Export cancelled.");
    }

    await Excel.run(async (context) => {
      const sheet = await addUniqueWorksheet(context, "LR Report");

      if (!isExportTokenValid(token)) {
        throw new Error("Settings or model changed during sheet creation. Export cancelled.");
      }

      try {
        const metadata = reportMetadataRows(snapshot);
        await writeTableChunks(context, sheet, 0, 0, metadata, {
          token,
          formatHeaders: true,
          formatFirstColBold: true,
          onChunkWritten: () => { batchesCommitted++; },
        });

        // Parameter Specification Table
        const paramStart = metadata.length + 2;
        const params = snapshot.parameters || {};
        const names = snapshot.feature_names || [];
        const wModel = params.weights_model_space || [];
        const bModel = params.intercept_model_space ?? 0;
        const wOrig = params.weights_original_units || wModel;
        const bOrig = params.intercept_original_units ?? bModel;
        const means = params.feature_means;
        const scales = params.feature_scales;
        const isStd = Boolean(params.standardized);
        const conversionValid = Boolean(params.conversion_valid);

        const paramTableRows = [
          [
            "Parameter",
            "Feature Name",
            "Original-Unit Weight",
            "Model-Space Weight",
            "Training Mean",
            "Training Scale (Pop Std Dev)",
            "Unit Interpretation",
          ],
          [
            "b (Intercept)",
            "Intercept",
            conversionValid ? bOrig : "n/a",
            bModel,
            "",
            "",
            "Constant baseline log-odds",
          ],
          ...names.map((name, i) => [
            "w" + (i + 1),
            prepareIdentityText(name),
            conversionValid && wOrig[i] !== undefined ? wOrig[i] : "n/a",
            wModel[i] !== undefined ? wModel[i] : 0,
            means && means[i] !== undefined ? means[i] : "",
            scales && scales[i] !== undefined ? scales[i] : "",
            isStd
              ? "Log-odds per original raw unit; model-space weight is per standard deviation"
              : "Log-odds per original raw unit",
          ]),
        ];

        await writeTableChunks(context, sheet, paramStart, 0, paramTableRows, {
          chunkSize: 250,
          token,
          formatHeaders: true,
          formatColOffset: 2,
          formatColCount: 4,
          numberFormat: "0.000000",
          onChunkWritten: (done, total) => {
            batchesCommitted++;
            if (button) button.textContent = `Exporting parameters (${done}/${total})…`;
          },
        });

        // Coefficients & Odds Ratios table
        const coefficientStart = paramStart + paramTableRows.length + 2;
        const coefficientRows = [
          ["Feature / Intercept", "Weight (Log-odds)", "Odds ratio", "Std. error", "p-value"],
          ...snapshot.coefficients.map((c) => [
            prepareIdentityText(c.name), c.coef, c.odds_ratio !== null ? c.odds_ratio : "inf",
            c.std_error ?? "n/a", c.p_value ?? "n/a",
          ]),
        ];
        await writeTableChunks(context, sheet, coefficientStart, 0, coefficientRows, {
          chunkSize: 250,
          token,
          formatHeaders: true,
          onChunkWritten: () => { batchesCommitted++; },
        });

        // Feature Scaling table
        let nextStart = coefficientStart + coefficientRows.length + 2;
        if (snapshot.preprocessing && snapshot.preprocessing.standardized) {
          const scalingRows = [
            ["Feature scaling fitted on training rows", "Mean", "Scale (Pop Std Dev)"],
            ...snapshot.feature_names.map((name, index) => [
              prepareIdentityText(name),
              snapshot.preprocessing.feature_means[index],
              snapshot.preprocessing.feature_scales[index],
            ]),
          ];
          await writeTableChunks(context, sheet, nextStart, 0, scalingRows, {
            chunkSize: 250,
            token,
            formatHeaders: true,
            onChunkWritten: () => { batchesCommitted++; },
          });
          nextStart += scalingRows.length + 2;
        }

        // Training Loss History table
        const lossHistory = (snapshot.diagnostics && snapshot.diagnostics.loss_history) || [];
        if (lossHistory.length) {
          const historyRows = [
            ["Iteration", "Binary Cross-Entropy Loss"],
            ...lossHistory.map((p) => [p.iteration, p.loss]),
          ];
          await writeTableChunks(context, sheet, nextStart, 0, historyRows, {
            chunkSize: 250,
            token,
            formatHeaders: true,
            onChunkWritten: () => { batchesCommitted++; },
          });
          nextStart += historyRows.length + 2;
        }

        // Predictions on all original source rows (with partition flag!)
        const source = snapshot._source;
        const probabilities = snapshot.predictions.prob;
        const partitions = snapshot.predictions.partition || [];
        const threshold = snapshot._activeThreshold;

        const predictionRows = [
          ["Source row", "Probability", "Predicted code", "Predicted label", "Partition"],
          ...probabilities.map((probability, index) => {
            const pred = classifyProbability(probability, threshold);
            const partition = partitions[index] || "data";
            return [
              source.firstDataRow + index,
              probability,
              pred,
              prepareIdentityText(pred === 1 ? snapshot.class_labels.positive : snapshot.class_labels.negative),
              partition,
            ];
          }),
        ];

        await writeTableChunks(context, sheet, nextStart, 0, predictionRows, {
          chunkSize: 250,
          token,
          formatHeaders: true,
          formatColOffset: 1,
          formatColCount: 1,
          numberFormat: "0.000000",
          onChunkWritten: (done, total) => {
            batchesCommitted++;
            if (button) button.textContent = `Exporting predictions (${done}/${total})…`;
          },
        });

        sheet.getUsedRange().format.autofitColumns();
        if (typeof sheet.freezePanes?.freezeRows === "function") {
          sheet.freezePanes.freezeRows(1);
        }
        sheet.activate();
        await context.sync();

        if (!isExportTokenValid(token)) {
          throw new Error("Settings or model changed during final export synchronization. Export cancelled.");
        }
      } catch (innerErr) {
        if (batchesCommitted > 0) {
          try {
            const isStale = innerErr.message && innerErr.message.includes("during final export synchronization");
            const prefix = isStale ? "[STALE EXPORT - CANCELLED: " : "[INCOMPLETE EXPORT - CANCELLED: ";
            sheet.getRange("A1").values = [[prefix + innerErr.message + "]"]];
            await context.sync();
          } catch (markerErr) {
            throw new Error(`${innerErr.message} (Warning: Could not update sheet status marker: ${markerErr.message})`);
          }
        }
        throw innerErr;
      }
    });

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed after export completed. Export marked stale.");
    }

    flash("writeback-btn", "Report exported ✓");
  } catch (error) {
    showError("Export failed: " + error.message);
  } finally {
    if (button) {
      button.textContent = origBtnText;
      button.disabled = !LAST_RESULT || LAST_RESULT._stale;
    }
  }
}

function colIndexToLetter(colIndex) {
  let letter = "";
  let temp = colIndex;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

async function exportModelWeights() {
  if (!ensureActiveModel()) return;
  const button = document.getElementById("export-weights-btn");
  const origBtnText = button ? button.textContent : "Export model weights";
  if (button) {
    button.disabled = true;
    button.textContent = "Exporting…";
  }

  const targetResult = LAST_RESULT;
  const token = createExportToken("weights", targetResult);
  const snapshot = {
    ...targetResult,
    _activeThreshold: targetResult._activeThreshold,
    _currentThresholdMetrics: targetResult._currentThresholdMetrics ? { ...targetResult._currentThresholdMetrics } : null,
  };
  let batchesCommitted = 0;

  try {
    const matches = await sourceStillMatches(snapshot._source);
    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed during export preparation. Export cancelled.");
    }
    if (!matches) {
      if (isExportTokenValid(token)) {
        markRunStale();
      }
      const isNamed = (snapshot._source.x && snapshot._source.x.kind === "name") ||
                      (snapshot._source.y && snapshot._source.y.kind === "name");
      if (isNamed) {
        throw new Error("The named range changed. Fit/score again.");
      } else {
        throw new Error("The training data changed after this model ran. Train again before exporting.");
      }
    }

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed during export preparation. Export cancelled.");
    }

    await Excel.run(async (context) => {
      const sheet = await addUniqueWorksheet(context, "Model Weights");

      if (!isExportTokenValid(token)) {
        throw new Error("Settings or model changed during sheet creation. Export cancelled.");
      }

      try {
        const names = snapshot.feature_names || [];
        const params = snapshot.parameters || {};
        const wModel = params.weights_model_space || [];
        const bModel = params.intercept_model_space ?? 0;
        const wOrig = params.weights_original_units || wModel;
        const bOrig = params.intercept_original_units ?? bModel;
        const means = params.feature_means;
        const scales = params.feature_scales;
        const threshold = snapshot._activeThreshold;
        const isStd = Boolean(params.standardized);
        const conversionValid = Boolean(params.conversion_valid);

        // 1. Model Metadata block
        const metaRows = [
          ["Model Specification & Learned Parameters (Scratch Engine)", ""],
          ["Model ID", prepareIdentityText(snapshot.model_id)],
          ["Trained Timestamp", snapshot._trainedAt || new Date().toISOString()],
          ["Feature Count", String(names.length)],
          ["Class Mapping", `0 = ${prepareIdentityText(snapshot.class_labels.negative)}; 1 = ${prepareIdentityText(snapshot.class_labels.positive)}`],
          ["Feature Space", params.feature_space || (isStd ? "standardized" : "original")],
          ["Preprocessing", isStd ? "Standardised using training-set means and population scales" : "Raw unstandardised features"],
          ["Convergence Status", `${snapshot.diagnostics?.converged ? "Converged" : "Not Converged"} (${snapshot.diagnostics?.stop_reason || ""})`],
          ["Iterations / Final Loss", `${snapshot.diagnostics?.iterations ?? 0} iters; final loss ${snapshot.diagnostics?.final_loss != null ? snapshot.diagnostics.final_loss.toFixed(6) : "–"}`],
          ["Learning Rate / L2 Penalty", `alpha=${snapshot.training_settings?.learning_rate}, lambda=${snapshot.training_settings?.l2_lambda}`],
          ["Active Decision Threshold", threshold.toFixed(2)],
          ["Parameter Note", "Learned weights quantify log-odds associations with outcome, not causal effects."],
        ];

        if (snapshot.table_mode && snapshot.table_metadata) {
          const tMeta = snapshot.table_metadata;
          metaRows.push(
            ["Analysis Mode", "Table Mode (Automatic Encoding & Preparation)"],
            ["Source Table", formatSourceExportLabel(snapshot._source)],
            ["Outcome Column (Y)", `${tMeta.y_column_name || "Y"} (index ${tMeta.y_column_index})`],
            ["Missing Value Policy", tMeta.missing_policy === "drop_rows" ? "Complete Cases Only (Drop Missing)" : "Median / Category Bucket Imputation"],
            ["Total Raw Rows", String(tMeta.total_rows)],
            ["Usable Rows", String(tMeta.usable_rows)],
            ["Excluded (Missing Y)", String(tMeta.excluded_missing_y_rows ? tMeta.excluded_missing_y_rows.length : 0)],
            ["Excluded (Missing X)", String(tMeta.excluded_missing_x_rows ? tMeta.excluded_missing_x_rows.length : 0)]
          );
        }

        if (snapshot.training_warnings && snapshot.training_warnings.length > 0) {
          const joined = snapshot.training_warnings.join(" | ");
          if (joined.length <= 32000) {
            metaRows.push(["Training Warnings", joined]);
          } else {
            let remaining = joined;
            let part = 1;
            while (remaining.length > 0) {
              metaRows.push([`Training Warnings (Part ${part})`, prepareDescription(remaining.slice(0, 32000), 32000)]);
              remaining = remaining.slice(32000);
              part++;
            }
          }
        }

        const sanitizedMeta = metaRows.map(([label, val]) => [
          escapeLiteralText(String(label)),
          typeof val === "string" ? escapeLiteralText(val) : val,
        ]);

        await writeTableChunks(context, sheet, 0, 0, sanitizedMeta, {
          token,
          formatHeaders: true,
          formatFirstColBold: true,
          onChunkWritten: () => { batchesCommitted++; },
        });

        // 2. Parameter Specification Table
        const paramStart = sanitizedMeta.length + 2;
        const paramHeaders = [
          "Parameter", "Feature Name", "Original-Unit Weight", "Model-Space Weight",
          "Training Mean", "Training Scale (Pop Std Dev)", "Unit Interpretation",
        ];
        const paramTableRows = [
          paramHeaders,
          [
            "b (Intercept)",
            "Intercept",
            conversionValid ? bOrig : "n/a",
            bModel,
            "",
            "",
            "Constant baseline log-odds",
          ],
          ...names.map((name, i) => [
            "w" + (i + 1),
            prepareIdentityText(name),
            conversionValid && wOrig[i] !== undefined ? wOrig[i] : "n/a",
            wModel[i] !== undefined ? wModel[i] : 0,
            means && means[i] !== undefined ? means[i] : "",
            scales && scales[i] !== undefined ? scales[i] : "",
            isStd
              ? "Log-odds per original raw unit; model-space weight is per standard deviation"
              : "Log-odds per original raw unit",
          ]),
        ];

        await writeTableChunks(context, sheet, paramStart, 0, paramTableRows, {
          chunkSize: 250,
          token,
          formatHeaders: true,
          formatColOffset: 2,
          formatColCount: 4,
          numberFormat: "0.000000",
          onChunkWritten: (done, total) => {
            batchesCommitted++;
            if (button) button.textContent = `Exporting parameters (${done}/${total})…`;
          },
        });

        // 3. Mathematical Equations Reference
        let nextStart = paramStart + paramTableRows.length + 2;
        const eqRows = [
          ["Mathematical Equations & Calculation Rules", ""],
          ["Score equation", "z = SUMPRODUCT(inputs, weights) + bias"],
          ["Sigmoid equation", "p = 1 / (1 + EXP(-z))   [Stable form: IF(z>=0, 1/(1+EXP(-z)), EXP(z)/(1+EXP(z)))]"],
          ["Threshold decision", `Class = IF(p >= ${threshold.toFixed(2)}, 1, 0)   [1 = "${escapeExcelFormulaString(snapshot.class_labels.positive)}", 0 = "${escapeExcelFormulaString(snapshot.class_labels.negative)}"]`],
          ["Unit convention", isStd
            ? (conversionValid
                ? "Original-unit weights allow direct evaluation on raw Excel feature values without manual standardization."
                : "Raw conversion is numerically invalid. Use standardized features x̂ = (x - μ) / σ with model-space weights.")
            : "Features unstandardized: weights apply directly to raw Excel values."],
        ];
        if (names.length <= 10) {
          if (conversionValid) {
            const terms = names.map((name, i) => `(${wOrig[i] >= 0 ? "+" : ""}${wOrig[i].toFixed(4)})*${name}`);
            eqRows.push(["Concrete score equation", `z = ${terms.join(" + ")} + (${bOrig >= 0 ? "+" : ""}${bOrig.toFixed(4)})`]);
          } else {
            const terms = names.map((name, i) => `(${wModel[i] >= 0 ? "+" : ""}${wModel[i].toFixed(4)})*${name}_scaled`);
            eqRows.push(["Concrete model-space equation", `z = ${terms.join(" + ")} + (${bModel >= 0 ? "+" : ""}${bModel.toFixed(4)})`]);
          }
        } else {
          eqRows.push(["Score equation", `z = sum(w_j * x_j) + b   (for ${names.length} features)`]);
        }

        const sanitizedEqRows = eqRows.map(([label, val]) => [
          prepareDescription(label, 32000),
          typeof val === "string" ? prepareDescription(val, 32000) : val,
        ]);

        await writeTableChunks(context, sheet, nextStart, 0, sanitizedEqRows, {
          token,
          formatHeaders: true,
          formatFirstColBold: true,
          onChunkWritten: () => { batchesCommitted++; },
        });

        // 4. Live Recalculable Excel Formula Example
        const hasCategoricals = snapshot.table_mode && (snapshot.table_metadata?.column_specs || []).some((s) => s.col_type === "categorical");
        if (hasCategoricals) {
          nextStart += sanitizedEqRows.length + 2;
          await writeTableChunks(context, sheet, nextStart, 0, [
            ["Excel Formula Guidance", "Formula Limitation for Mixed Categorical Data"],
            ["Notice", "Categorical features in this model are dummy-encoded into indicator variables (0/1) relative to reference levels."],
            ["Scoring Recommendation", "Excel's standard SUMPRODUCT cannot directly process raw text (e.g. 'female', 'S'). Use the 'Score new rows' taskpane button to score raw sheets using the full saved preparation pipeline, or encode indicators manually according to the Parameter Specification Table above."],
          ], {
            token,
            formatHeaders: true,
            formatFirstColBold: true,
            onChunkWritten: () => { batchesCommitted++; },
          });
        } else if (names.length <= 500) {
          nextStart += sanitizedEqRows.length + 2;
          await writeTableChunks(context, sheet, nextStart, 0, [
            ["Live Recalculable Prediction Example", "Edit any input cell below to see Excel recalculate score and probability in real time."],
          ], {
            token,
            formatHeaders: true,
            formatFirstColBold: true,
            onChunkWritten: () => { batchesCommitted++; },
          });
          nextStart += 2;

          const exampleHeaders = ["Row / Feature", ...names.map(prepareIdentityText)];
          const exampleRowVals = snapshot._lastWhatIf?.row || (means ? means.map((m) => m) : names.map(() => 1.0));

          if (conversionValid || !isStd) {
            const inputRowVals = ["Example Input (x)", ...exampleRowVals];
            const weightFormulas = ["Original-Unit Weight (w)", ...names.map((_, i) => `=C${paramStart + 3 + i}`)];

            const gridRows = [exampleHeaders, inputRowVals, weightFormulas];
            await writeTableChunks(context, sheet, nextStart, 0, gridRows, {
              token,
              formatHeaders: true,
              formatFirstColBold: true,
              onChunkWritten: () => { batchesCommitted++; },
            });
            sheet.getRangeByIndexes(nextStart + 1, 1, 1, names.length).numberFormat = [names.map(() => "0.0000")];

            const inputRowExcel = nextStart + 2;
            const weightRowExcel = nextStart + 3;
            const startColLetter = "B";
            const endColLetter = colIndexToLetter(names.length);
            const inputRange = `${startColLetter}${inputRowExcel}:${endColLetter}${inputRowExcel}`;
            const weightRange = `${startColLetter}${weightRowExcel}:${endColLetter}${weightRowExcel}`;
            const interceptCell = `C${paramStart + 2}`;

            const calcStart = nextStart + 4;
            const c = calcStart;
            const calculationRows = [
              ["Intercept b (linked)", `=${interceptCell}`],
              ["Decision Threshold", threshold],
              ["Linear Score z (Formula)", `=SUMPRODUCT(${inputRange}, ${weightRange}) + B${c + 1}`],
              ["Probability p (Formula)", `=IF(B${c + 3}>=0, 1/(1+EXP(-B${c + 3})), EXP(B${c + 3})/(1+EXP(B${c + 3})))`],
              ["Predicted Class (Formula)", `=IF(B${c + 4}>=B${c + 2}, 1, 0)`],
              ["Predicted Label (Formula)", `=IF(B${c + 5}=1, "${escapeExcelFormulaString(snapshot.class_labels.positive)}", "${escapeExcelFormulaString(snapshot.class_labels.negative)}")`],
            ];

            await writeTableChunks(context, sheet, calcStart, 0, calculationRows, {
              token,
              formatFirstColBold: true,
              onChunkWritten: () => { batchesCommitted++; },
            });
            sheet.getRangeByIndexes(calcStart + 1, 1, 1, 1).numberFormat = [["0.00"]];
            sheet.getRangeByIndexes(calcStart + 2, 1, 1, 1).numberFormat = [["0.000000"]];
            sheet.getRangeByIndexes(calcStart + 3, 1, 1, 1).numberFormat = [["0.0000%"]];
          } else {
            const inputRowVals = ["Raw Input (x_raw)", ...exampleRowVals];
            const meanRowVals = ["Training Mean (mu)", ...(means || names.map(() => 0))];
            const scaleRowVals = ["Training Scale (sigma)", ...(scales || names.map(() => 1))];
            const rawRowExcel = nextStart + 2;
            const meanRowExcel = nextStart + 3;
            const scaleRowExcel = nextStart + 4;

            const scaledFormulas = ["Standardized Input (x_hat)", ...names.map((_, i) => {
              const col = colIndexToLetter(i + 1);
              return `=(${col}${rawRowExcel}-${col}${meanRowExcel})/${col}${scaleRowExcel}`;
            })];
            const weightFormulas = ["Model-Space Weight (w_model)", ...names.map((_, i) => `=D${paramStart + 3 + i}`)];

            const gridRows = [exampleHeaders, inputRowVals, meanRowVals, scaleRowVals, scaledFormulas, weightFormulas];
            await writeTableChunks(context, sheet, nextStart, 0, gridRows, {
              token,
              formatHeaders: true,
              formatFirstColBold: true,
              onChunkWritten: () => { batchesCommitted++; },
            });
            sheet.getRangeByIndexes(nextStart + 1, 1, 3, names.length).numberFormat =
              Array.from({ length: 3 }, () => names.map(() => "0.0000"));

            const scaledRowExcel = nextStart + 5;
            const weightRowExcel = nextStart + 6;
            const startColLetter = "B";
            const endColLetter = colIndexToLetter(names.length);
            const scaledInputRange = `${startColLetter}${scaledRowExcel}:${endColLetter}${scaledRowExcel}`;
            const weightRange = `${startColLetter}${weightRowExcel}:${endColLetter}${weightRowExcel}`;
            const interceptCell = `D${paramStart + 2}`;

            const calcStart = nextStart + 7;
            const c = calcStart;
            const calculationRows = [
              ["Intercept b (model-space, linked)", `=${interceptCell}`],
              ["Decision Threshold", threshold],
              ["Linear Score z (Formula)", `=SUMPRODUCT(${scaledInputRange}, ${weightRange}) + B${c + 1}`],
              ["Probability p (Formula)", `=IF(B${c + 3}>=0, 1/(1+EXP(-B${c + 3})), EXP(B${c + 3})/(1+EXP(B${c + 3})))`],
              ["Predicted Class (Formula)", `=IF(B${c + 4}>=B${c + 2}, 1, 0)`],
              ["Predicted Label (Formula)", `=IF(B${c + 5}=1, "${escapeExcelFormulaString(snapshot.class_labels.positive)}", "${escapeExcelFormulaString(snapshot.class_labels.negative)}")`],
            ];

            await writeTableChunks(context, sheet, calcStart, 0, calculationRows, {
              token,
              formatFirstColBold: true,
              onChunkWritten: () => { batchesCommitted++; },
            });
            sheet.getRangeByIndexes(calcStart + 1, 1, 1, 1).numberFormat = [["0.00"]];
            sheet.getRangeByIndexes(calcStart + 2, 1, 1, 1).numberFormat = [["0.000000"]];
            sheet.getRangeByIndexes(calcStart + 3, 1, 1, 1).numberFormat = [["0.0000%"]];
          }
        } else {
          nextStart += sanitizedEqRows.length + 2;
          await writeTableChunks(context, sheet, nextStart, 0, [
            ["Live Recalculable Formula Example", "Horizontal formula example omitted for models with > 500 features."],
            ["Parameter Note", "Use the complete Parameter Specification Table above and the model-space equations to score rows."],
          ], {
            token,
            formatFirstColBold: true,
            onChunkWritten: () => { batchesCommitted++; },
          });
        }

        sheet.getUsedRange().format.autofitColumns();
        if (typeof sheet.freezePanes?.freezeRows === "function") {
          sheet.freezePanes.freezeRows(1);
        }
        sheet.activate();
        await context.sync();

        if (!isExportTokenValid(token)) {
          throw new Error("Settings or model changed during final export synchronization. Export cancelled.");
        }
      } catch (innerErr) {
        if (batchesCommitted > 0) {
          try {
            const isStale = innerErr.message && innerErr.message.includes("during final export synchronization");
            const prefix = isStale ? "[STALE EXPORT - CANCELLED: " : "[INCOMPLETE EXPORT - CANCELLED: ";
            sheet.getRange("A1").values = [[prefix + innerErr.message + "]"]];
            await context.sync();
          } catch (markerErr) {
            throw new Error(`${innerErr.message} (Warning: Could not update sheet status marker: ${markerErr.message})`);
          }
        }
        throw innerErr;
      }
    });

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or model changed after export completed. Export marked stale.");
    }

    flash("export-weights-btn", "Weights exported ✓");
  } catch (error) {
    showError("Export model weights failed: " + error.message);
  } finally {
    if (button) {
      button.textContent = origBtnText;
      button.disabled = !LAST_RESULT || LAST_RESULT._stale;
    }
  }
}


async function readNewFeatureData(address, hasHeader, expectedFeatures) {
  let values, descriptor;
  await Excel.run(async (context) => {
    const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
    activeWorksheet.load("id,name");
    await context.sync();
    const resolved = await resolveRangeInput(context, address, { fieldName: "New X", activeWorksheet });
    values = resolved.descriptor.values;
    descriptor = resolved.descriptor;
  });

  if (!values || !values.length) throw new Error("The selected new-row range is empty.");
  if (descriptor.columnCount !== expectedFeatures.length) {
    throw new Error(`New rows must have ${expectedFeatures.length} features, got ${descriptor.columnCount}.`);
  }

  const headerOffset = hasHeader ? 1 : 0;
  if (hasHeader) {
    if (values.length < 2) throw new Error("A header row requires at least one data row.");
    const names = validateHeaderRow(values[0]);
    if (names.length !== expectedFeatures.length) {
      throw new Error(`Feature header count mismatch: expected ${expectedFeatures.length} features, received ${names.length}.`);
    }
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== expectedFeatures[i]) {
        throw new Error(`Feature header mismatch at column ${i + 1}: expected "${expectedFeatures[i]}", received "${names[i]}".`);
      }
    }
  }

  const rows = hasHeader ? values.slice(1) : values;
  const firstDataRow = descriptor.rowIndex + headerOffset + 1;
  const numeric = validateNumericRows(rows, expectedFeatures, firstDataRow, true);

  return {
    features: numeric.features,
    source: {
      ...descriptor,
      hasHeader,
      firstDataRow,
      expectedFeatures,
    },
  };
}

async function readNewTableData(address, hasHeader) {
  let values, descriptor;
  await Excel.run(async (context) => {
    const activeWorksheet = context.workbook.worksheets.getActiveWorksheet();
    activeWorksheet.load("id,name");
    await context.sync();
    const resolved = await resolveRangeInput(context, address, { fieldName: "New rows table", activeWorksheet });
    values = resolved.descriptor.values;
    descriptor = resolved.descriptor;
  });

  if (!values || !values.length) throw new Error("The selected new-row range is empty.");

  let headers = [];
  let rows = [];
  let firstDataRow = descriptor.rowIndex + 1;

  if (hasHeader) {
    if (values.length < 2) throw new Error("A header row requires at least one data row.");
    headers = values[0].map((h) => (h === null || h === undefined ? "" : String(h).trim()));
    rows = values.slice(1);
    firstDataRow = descriptor.rowIndex + 2;
  } else {
    const selectedHeaders = (LAST_RESULT && LAST_RESULT.table_metadata && LAST_RESULT.table_metadata.selected_indices)
      ? LAST_RESULT.table_metadata.selected_indices.map((i) => LAST_RESULT.table_metadata.source_headers[i])
      : [];
    if (descriptor.columnCount === selectedHeaders.length) {
      headers = selectedHeaders;
      rows = values;
    } else {
      throw new Error(
        `When new rows do not include headers, column count (${descriptor.columnCount}) must match selected features count (${selectedHeaders.length}). Alternatively, check "New rows include the trained feature headers" to match columns by header name.`
      );
    }
  }

  return {
    headers,
    rows,
    source: {
      ...descriptor,
      hasHeader,
      firstDataRow,
    },
  };
}

async function scoreNewRows() {
  if (!ensureActiveModel()) return;
  const address = document.getElementById("new-x-range").value;
  if (!address) {
    showError("Select an X range for new rows.");
    return;
  }

  const button = document.getElementById("score-new-btn");
  if (button) {
    button.disabled = true;
    button.textContent = "Scoring…";
  }

  const reqModelId = LAST_RESULT.model_id;
  const reqBackendUrl = BACKEND_URL;
  const reqTrainRev = TRAIN_REVISION;
  const reqNewPredRev = ++NEW_PRED_REVISION;

  try {
    const isTableMode = Boolean(LAST_RESULT && LAST_RESULT.table_mode);
    let data;
    let inputSource;

    if (isTableMode) {
      const input = await readNewTableData(
        address,
        document.getElementById("new-has-header").checked
      );

      // Recheck after worksheet read
      if (
        NEW_PRED_REVISION !== reqNewPredRev ||
        TRAIN_REVISION !== reqTrainRev ||
        !LAST_RESULT ||
        LAST_RESULT.model_id !== reqModelId ||
        LAST_RESULT._stale ||
        BACKEND_URL !== reqBackendUrl
      ) {
        return;
      }

      data = await fetchJson(
        "/predict-table",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: reqModelId,
            headers: input.headers,
            rows: input.rows,
            threshold: LAST_RESULT._activeThreshold,
          }),
        },
        REQUEST_TIMEOUT_MS,
        reqBackendUrl
      );
      inputSource = input.source;
    } else {
      const input = await readNewFeatureData(
        address,
        document.getElementById("new-has-header").checked,
        LAST_RESULT.feature_names
      );

      // Recheck after worksheet read
      if (
        NEW_PRED_REVISION !== reqNewPredRev ||
        TRAIN_REVISION !== reqTrainRev ||
        !LAST_RESULT ||
        LAST_RESULT.model_id !== reqModelId ||
        LAST_RESULT._stale ||
        BACKEND_URL !== reqBackendUrl
      ) {
        return;
      }

      data = await fetchJson(
        "/predict",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: reqModelId,
            features: input.features,
            threshold: LAST_RESULT._activeThreshold,
          }),
        },
        REQUEST_TIMEOUT_MS,
        reqBackendUrl
      );
      inputSource = input.source;
    }

    // Recheck after fetchJson
    if (
      NEW_PRED_REVISION !== reqNewPredRev ||
      TRAIN_REVISION !== reqTrainRev ||
      !LAST_RESULT ||
      LAST_RESULT.model_id !== reqModelId ||
      LAST_RESULT._stale ||
      BACKEND_URL !== reqBackendUrl
    ) {
      return;
    }

    // Reclassify with current active threshold if user adjusted slider in flight
    const currentThreshold = LAST_RESULT._activeThreshold;
    data.threshold = currentThreshold;
    data.results = data.results.map((r) => ({
      ...r,
      pred: r.prob >= currentThreshold ? 1 : 0,
    }));

    LAST_NEW_PREDICTION = {
      ...data,
      _source: inputSource,
      model_id: reqModelId,
      revision: reqNewPredRev,
      table_mode: isTableMode,
    };

    const exportBtn = document.getElementById("export-new-btn");
    if (exportBtn) {
      exportBtn.classList.remove("hidden");
      exportBtn.disabled = false;
    }
    const note = document.getElementById("new-score-note");
    if (note) {
      let msg = `Scored ${data.results.length} new rows. Click "Export new-row predictions" to write them to Excel.`;
      if (data.warnings && data.warnings.length) {
        msg += ` (${data.warnings.length} warning${data.warnings.length > 1 ? "s" : ""}: ${data.warnings[0]})`;
      }
      note.textContent = msg;
    }
  } catch (error) {
    if (
      NEW_PRED_REVISION === reqNewPredRev &&
      TRAIN_REVISION === reqTrainRev &&
      LAST_RESULT &&
      LAST_RESULT.model_id === reqModelId &&
      !LAST_RESULT._stale
    ) {
      showError(error.message);
    }
  } finally {
    if (button) {
      button.disabled = !LAST_RESULT || LAST_RESULT._stale;
      button.textContent = "Score new rows";
    }
  }
}

function refreshNewPredictionThreshold(threshold) {
  if (!LAST_NEW_PREDICTION) return;
  LAST_NEW_PREDICTION.threshold = threshold;
  LAST_NEW_PREDICTION.results = LAST_NEW_PREDICTION.results.map((r) => ({
    ...r,
    pred: r.prob >= threshold ? 1 : 0,
  }));
}

async function newSourceStillMatches(source) {
  try {
    return await Excel.run(async (context) => {
      return await verifySourceDescriptor(context, source);
    });
  } catch {
    return false;
  }
}

async function exportNewPredictions() {
  if (!ensureActiveModel()) return;
  if (!LAST_NEW_PREDICTION) return;
  const button = document.getElementById("export-new-btn");
  const origBtnText = button ? button.textContent : "Export new-row predictions";
  if (button) {
    button.disabled = true;
    button.textContent = "Exporting…";
  }

  const snapshot = LAST_NEW_PREDICTION;
  const source = snapshot._source;
  const token = createExportToken("new_pred", LAST_RESULT, snapshot);
  let batchesCommitted = 0;

  try {
    if (!isExportTokenValid(token)) {
      throw new Error("The trained model changed or is stale. Train a model before exporting predictions.");
    }

    const sourceMatches = await newSourceStillMatches(source);
    if (!isExportTokenValid(token)) {
      throw new Error("Settings or prediction changed during source verification. Export cancelled.");
    }
    if (!sourceMatches) {
      if (isExportTokenValid(token)) {
        clearNewPrediction();
      }
      throw new Error("The new-row data or named range changed. Score these rows again before exporting.");
    }

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or prediction changed during export preparation. Export cancelled.");
    }

    await Excel.run(async (context) => {
      const sheet = await addUniqueWorksheet(context, "New Predictions");

      if (!isExportTokenValid(token)) {
        throw new Error("Settings or prediction changed during sheet creation. Export cancelled.");
      }

      try {
        const results = snapshot.results;
        const threshold = snapshot.threshold;

        const metadata = [
          ["New Row Predictions", ""],
          ["Model ID", prepareIdentityText(snapshot.model_id)],
          ["Source X", formatSourceExportLabel(source)],
          ["Threshold", threshold.toFixed(2)],
          ["Positive Class", prepareIdentityText(snapshot.class_labels.positive)],
          ["Negative Class", prepareIdentityText(snapshot.class_labels.negative)],
        ];
        const sanitizedMeta = metadata.map(([label, val]) => [
          escapeLiteralText(String(label)),
          typeof val === "string" ? escapeLiteralText(val) : val,
        ]);

        await writeTableChunks(context, sheet, 0, 0, sanitizedMeta, {
          token,
          formatHeaders: true,
          formatFirstColBold: true,
          onChunkWritten: () => { batchesCommitted++; },
        });

        const predictionStart = sanitizedMeta.length + 2;
        const rows = [
          ["Row", "Probability", "Predicted code", "Predicted label"],
          ...results.map((r, i) => [
            source.firstDataRow + i,
            r.prob,
            r.pred,
            prepareIdentityText(r.pred === 1 ? snapshot.class_labels.positive : snapshot.class_labels.negative),
          ]),
        ];

        await writeTableChunks(context, sheet, predictionStart, 0, rows, {
          chunkSize: 250,
          token,
          formatHeaders: true,
          formatColOffset: 1,
          formatColCount: 1,
          numberFormat: "0.000000",
          onChunkWritten: (done, total) => {
            batchesCommitted++;
            if (button) button.textContent = `Exporting predictions (${done}/${total})…`;
          },
        });

        sheet.getUsedRange().format.autofitColumns();
        sheet.activate();
        await context.sync();

        if (!isExportTokenValid(token)) {
          throw new Error("Settings or prediction changed during final export synchronization. Export cancelled.");
        }
      } catch (innerErr) {
        if (batchesCommitted > 0) {
          try {
            const isStale = innerErr.message && innerErr.message.includes("during final export synchronization");
            const prefix = isStale ? "[STALE EXPORT - CANCELLED: " : "[INCOMPLETE EXPORT - CANCELLED: ";
            sheet.getRange("A1").values = [[prefix + innerErr.message + "]"]];
            await context.sync();
          } catch (markerErr) {
            throw new Error(`${innerErr.message} (Warning: Could not update sheet status marker: ${markerErr.message})`);
          }
        }
        throw innerErr;
      }
    });

    if (!isExportTokenValid(token)) {
      throw new Error("Settings or prediction changed after export completed. Export marked stale.");
    }

    flash("export-new-btn", "Predictions exported ✓");
  } catch (error) {
    showError("Export failed: " + error.message);
  } finally {
    if (button) {
      button.textContent = origBtnText;
      button.disabled = !LAST_NEW_PREDICTION;
      if (!LAST_NEW_PREDICTION) {
        button.classList.add("hidden");
      }
    }
  }
}

function ensureActiveModel() {
  if (!LAST_RESULT) {
    showError("Fit a model first.");
    return false;
  }
  if (LAST_RESULT._stale) {
    showError("The model settings or data changed. Fit the model again.");
    return false;
  }
  return true;
}

function setModelActionsEnabled(enabled) {
  const exportWeightsBtn = document.getElementById("export-weights-btn");
  if (exportWeightsBtn) exportWeightsBtn.disabled = !enabled;
  document.getElementById("writeback-btn").disabled = !enabled;
  const whatIfBtn = document.getElementById("whatif-btn");
  if (whatIfBtn) {
    const featureCount = LAST_RESULT?.feature_names?.length || 0;
    whatIfBtn.disabled = !enabled || featureCount > 25;
  }
  document.getElementById("score-new-btn").disabled = !enabled;
}

function markRunStale() {
  CURRENT_REQUEST_ID++;
  TRAIN_REVISION++;
  WHATIF_REVISION++;
  NEW_PRED_REVISION++;
  if (LAST_RESULT) LAST_RESULT._stale = true;
  setModelActionsEnabled(false);
  clearNewPrediction();
  invalidateWhatIfExplanation();
}


function clearNewPrediction() {
  LAST_NEW_PREDICTION = null;
  const exportBtn = document.getElementById("export-new-btn");
  if (exportBtn) {
    exportBtn.classList.add("hidden");
    exportBtn.disabled = true;
  }
  const note = document.getElementById("new-score-note");
  if (note) note.textContent = "";
}

function clearActiveModel(message) {
  LAST_RESULT = null;
  LAST_NEW_PREDICTION = null;
  setModelActionsEnabled(false);
  clearNewPrediction();
  const res = document.getElementById("results");
  if (res) res.classList.add("hidden");
  if (message) showError(message);
}

function flash(buttonId, temporaryText) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  const original = button.textContent;
  button.textContent = temporaryText;
  setTimeout(() => {
    button.textContent = original;
  }, 2000);
}

function showError(message) {
  const toast = document.getElementById("error-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 4000);
}
