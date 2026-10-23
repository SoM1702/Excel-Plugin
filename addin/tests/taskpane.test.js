const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function element(id, tag = "div", type = "") {
  let _textContent = "";
  let _type = type;
  let _tagName = tag.toUpperCase();
  const el = {
    id,
    get tagName() { return _tagName; },
    set tagName(val) { _tagName = val.toUpperCase(); },
    get type() { return _type; },
    set type(val) {
      _type = val;
      if (["text", "number", "range", "checkbox", "radio"].includes(val)) {
        _tagName = "INPUT";
      }
    },
    value: "",
    style: {},
    checked: false,
    get textContent() {
      if (this.children.length > 0) {
        return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(" ");
      }
      return _textContent;
    },
    set textContent(val) {
      _textContent = val;
      this.children = [];
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(val) {
      if (val === "") {
        this.children = [];
        _textContent = "";
      }
    },
    className: "",
    dataset: {},
    disabled: false,
    children: [],
    listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(event, listener) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(listener);
    },
    trigger(event, eventObj = {}) {
      const payload = { target: el, ...eventObj };
      (this.listeners[event] || []).forEach((cb) => cb(payload));
    },
  };
  el.classList = {
    contains(cls) { return el.className.includes(cls); },
    add(cls) { if (!this.contains(cls)) el.className = (el.className + " " + cls).trim(); },
    remove(cls) { el.className = el.className.replace(cls, "").trim(); },
    toggle(cls, force) {
      const has = this.contains(cls);
      const shouldAdd = force !== undefined ? force : !has;
      if (shouldAdd) this.add(cls); else this.remove(cls);
      return this.contains(cls);
    },
  };
  return el;
}

function bootTaskPane({ excelContext = null, fetchMock = null } = {}) {
  const ids = [
    "run-btn", "writeback-btn", "whatif-btn", "score-new-btn", "export-new-btn", "export-weights-btn",
    "test-size", "test-pct", "train-pct", "split-summary-badge", "allocation-counts",
    "threshold", "threshold-out", "thr-suggest", "backend-url", "save-url", "backend-status",
    "y-range", "x-range", "has-header", "standardize", "learning-rate", "max-iter",
    "tolerance", "l2-lambda", "balance", "cv", "new-x-range", "new-has-header", "new-score-note",
    "eval-warning", "error-toast", "t-acc", "t-prec", "t-rec", "t-f1", "confusion",
    "results", "m-acc", "m-auc", "m-prec", "m-rec", "quality-note", "eval-note",
    "cv-note", "inference-note", "coef-chart", "roc-chart", "loss-chart",
    "d-init-loss", "d-final-loss", "d-iters", "d-grad-norm", "diag-status-badge",
    "diag-stop-reason", "whatif-inputs", "whatif-result", "whatif-summary", "whatif-calculation-steps",
    "whatif-limit-note", "whatif-prep-notes", "whatif-unavailable-msg", "whatif-worked-card",
    "eq-score-text", "eq-sigmoid-text", "eq-decision-text", "eq-unit-note", "param-interp-note",
    "data-preview",
    "params-search", "params-pagination", "params-prev-btn", "params-page-info", "params-next-btn",
    "mode-table-btn", "mode-numeric-btn", "table-mode-container", "numeric-mode-container",
    "table-range", "profile-table-btn", "table-profile-card", "table-summary-info",
    "table-y-select", "table-missing-policy", "table-select-all-suggested", "table-select-clear",
    "table-selected-count", "table-columns-list", "table-projected-summary",
    "table-results-summary", "table-results-rows-info", "table-results-encodings-info",
  ];

  const buttonIds = new Set([
    "run-btn", "writeback-btn", "whatif-btn", "score-new-btn", "export-new-btn", "export-weights-btn", "save-url",
    "params-prev-btn", "params-next-btn",
    "mode-table-btn", "mode-numeric-btn", "profile-table-btn", "table-select-all-suggested", "table-select-clear",
  ]);
  const inputTypes = {
    "test-size": "range", "test-pct": "number", "train-pct": "number", "threshold": "range",
    "backend-url": "text", "y-range": "text", "x-range": "text", "has-header": "checkbox",
    "standardize": "checkbox", "learning-rate": "number", "max-iter": "number", "tolerance": "number",
    "l2-lambda": "number", "balance": "checkbox", "cv": "checkbox", "new-x-range": "text",
    "new-has-header": "checkbox", "params-search": "text", "table-range": "text",
  };
  const elements = Object.fromEntries(
    ids.map((id) => {
      if (buttonIds.has(id)) return [id, element(id, "button", "button")];
      if (inputTypes[id]) {
        const el = element(id, "input", inputTypes[id]);
        if (inputTypes[id] === "checkbox") el.checked = true;
        return [id, el];
      }
      return [id, element(id, "div")];
    })
  );
  elements.balance.checked = false;
  elements.cv.checked = false;
  if (elements["numeric-mode-container"]) {
    elements["numeric-mode-container"].classList.add("hidden");
  }

  const rangePick = element("range-pick", "button", "button");
  rangePick.dataset.target = "x-range";

  const tbody = element("coef-tbody", "tbody");
  const paramsTbody = element("params-tbody", "tbody");
  const whatifTbody = element("whatif-tbody", "tbody");

  const document = {
    createElement(tag) {
      return element(tag, tag);
    },
    getElementById(id) {
      if (elements[id]) return elements[id];
      const findIn = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        for (const child of node.children || []) {
          const found = findIn(child);
          if (found) return found;
        }
        return null;
      };
      for (const root of Object.values(elements)) {
        const found = findIn(root);
        if (found) return found;
      }
      return element(id);
    },
    querySelectorAll(selector) {
      if (selector === "button[data-target]") return [rangePick];
      if (selector === "#whatif-inputs input" || selector === "#whatif-inputs input, #whatif-inputs select") {
        const findInputsAndSelects = (node) => {
          let list = [];
          if (!node) return list;
          if (node.tagName === "INPUT" || node.tagName === "SELECT") {
            list.push(node);
          }
          for (const child of node.children || []) {
            list = list.concat(findInputsAndSelects(child));
          }
          return list;
        };
        return findInputsAndSelects(elements["whatif-inputs"]);
      }
      if (selector === ".table-col-checkbox:checked") {
        const findCheckboxes = (node) => {
          let list = [];
          if (!node) return list;
          if (node.tagName === "INPUT" && node.type === "checkbox" && node.classList.contains("table-col-checkbox") && node.checked) {
            list.push(node);
          }
          for (const child of node.children || []) {
            list = list.concat(findCheckboxes(child));
          }
          return list;
        };
        return findCheckboxes(elements["table-columns-list"]);
      }
      return [];
    },
    querySelector(selector) {
      if (selector === "#coef-table tbody") return tbody;
      if (selector === "#params-table tbody") return paramsTbody;
      if (selector === "#whatif-table tbody") return whatifTbody;
      return null;
    },
  };

  const context = {
    AbortController,
    Chart: function () {
      return { destroy() {} };
    },
    Excel: {
      run: async (fn) => {
        if (excelContext) return await fn(excelContext);
      },
    },
    Office: {
      HostType: { Excel: "Excel" },
      context: {
        requirements: {
          isSetSupported: () => true,
        },
      },
      onReady(listener) { listener({ host: "Excel" }); },
    },
    clearTimeout,
    console,
    document,
    fetch: fetchMock || (async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) })),
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
  };

  vm.createContext(context);
  const rangeInputSource = fs.readFileSync(path.join(__dirname, "..", "src", "taskpane", "range-input.js"), "utf8");
  vm.runInContext(rangeInputSource, context);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "taskpane", "taskpane.js"), "utf8");
  vm.runInContext(source, context);
  return { context, elements, rangePick, tbody, paramsTbody, whatifTbody };
}


test("backend Save binds only its own action", () => {
  const { elements, rangePick } = bootTaskPane();
  assert.equal(elements["save-url"].listeners.click.length, 1);
  assert.equal(rangePick.listeners.click.length, 1);
});

test("linked split controls keep Train% + Test% = 100%", () => {
  const { elements } = bootTaskPane();

  // Initial values
  assert.equal(elements["train-pct"].value, 70);
  assert.equal(elements["test-pct"].value, 30);
  assert.equal(elements["test-size"].value, "0.30");

  // User changes test-pct to 20%
  elements["test-pct"].value = "20";
  elements["test-pct"].trigger("input");

  assert.equal(elements["train-pct"].value, 80);
  assert.equal(elements["test-size"].value, "0.20");
  assert.equal(elements["split-summary-badge"].textContent, "80% / 20%");

  // User changes train-pct to 85%
  elements["train-pct"].value = "85";
  elements["train-pct"].trigger("input");

  assert.equal(elements["test-pct"].value, 15);
  assert.equal(elements["test-size"].value, "0.15");
  assert.equal(elements["split-summary-badge"].textContent, "85% / 15%");
});

test("selected threshold drives live classification metrics and syncs what-if", () => {
  const { context, elements } = bootTaskPane();
  vm.runInContext(
    "LAST_RESULT = { _stale: false, threshold_data: { y_true: [1, 0], prob: [0.4, 0.2] }, class_labels: { positive: '1', negative: '0' } }; updateConfusion(0.3);",
    context
  );
  assert.equal(elements["t-acc"].textContent, "1.000");
  assert.equal(elements["t-prec"].textContent, "1.000");
  assert.equal(elements["t-rec"].textContent, "1.000");
  assert.equal(vm.runInContext("LAST_RESULT._activeThreshold", context), 0.3);
  assert.equal(vm.runInContext("classifyProbability(0.4, 0.3)", context), 1);
  assert.equal(vm.runInContext("classifyProbability(0.4, 0.5)", context), 0);
});

test("modifying training settings marks model stale", () => {
  const { context, elements } = bootTaskPane();
  vm.runInContext(
    "LAST_RESULT = { _stale: false, model_id: 'm1' }; setModelActionsEnabled(true);",
    context
  );
  assert.equal(elements["writeback-btn"].disabled, false);

  // Change learning rate
  elements["learning-rate"].trigger("change");
  assert.equal(vm.runInContext("LAST_RESULT._stale", context), true);
  assert.equal(elements["writeback-btn"].disabled, true);
});

test("isBlank identifies empty and whitespace-only cells", () => {
  const { context } = bootTaskPane();
  assert.equal(vm.runInContext("isBlank('')", context), true);
  assert.equal(vm.runInContext("isBlank('   ')", context), true);
  assert.equal(vm.runInContext("isBlank('\\t\\n')", context), true);
  assert.equal(vm.runInContext("isBlank(null)", context), true);
  assert.equal(vm.runInContext("isBlank(undefined)", context), true);
  assert.equal(vm.runInContext("isBlank('0')", context), false);
  assert.equal(vm.runInContext("isBlank(0)", context), false);
  assert.equal(vm.runInContext("isBlank('valid')", context), false);
});

test("valuesFingerprint differentiates [1, 23] and [12, 3] with cell and row delimiters", () => {
  const { context } = bootTaskPane();
  const fp1 = vm.runInContext("valuesFingerprint([[1, 23]])", context);
  const fp2 = vm.runInContext("valuesFingerprint([[12, 3]])", context);
  assert.notEqual(fp1, fp2);
});

test("batch prediction validates 1-row and identical rows without constant-feature error", () => {
  const { context } = bootTaskPane();
  // Batch prediction with 1 row: should succeed
  const singleRow = vm.runInContext(
    "validateNumericRows([[5.0, 10.0]], ['featureA', 'featureB'], 2, true)",
    context
  );
  assert.equal(singleRow.features.length, 1);
  assert.equal(singleRow.features[0][0], 5.0);
  assert.equal(singleRow.features[0][1], 10.0);

  // Batch prediction with multiple identical rows: should succeed
  const identicalRows = vm.runInContext(
    "validateNumericRows([[5.0, 10.0], [5.0, 10.0]], ['featureA', 'featureB'], 2, true)",
    context
  );
  assert.equal(identicalRows.features.length, 2);

  // Training validation with identical rows should reject zero variance
  assert.throws(
    () => vm.runInContext("validateNumericRows([[5.0, 10.0], [5.0, 10.0]], ['featureA', 'featureB'], 2, false)", context),
    /All selected features are constant/
  );
});

test("refreshNewPredictionThreshold updates predictions when threshold slider moves", () => {
  const { context } = bootTaskPane();
  vm.runInContext(
    "LAST_NEW_PREDICTION = { threshold: 0.5, results: [{ prob: 0.45, pred: 0 }, { prob: 0.7, pred: 1 }] }; refreshNewPredictionThreshold(0.4);",
    context
  );
  const updated = vm.runInContext("LAST_NEW_PREDICTION", context);
  assert.equal(updated.threshold, 0.4);
  assert.equal(updated.results[0].pred, 1);
  assert.equal(updated.results[1].pred, 1);
});

test("settings modification increments CURRENT_REQUEST_ID and invalidates in-flight run", () => {
  const { context, elements } = bootTaskPane();
  const initId = vm.runInContext("CURRENT_REQUEST_ID", context);
  elements["learning-rate"].trigger("change");
  const nextId = vm.runInContext("CURRENT_REQUEST_ID", context);
  assert.equal(nextId, initId + 1);
});

test("coefficient table renders safely using textContent preventing HTML injection", () => {
  const { context, tbody } = bootTaskPane();
  const mockResult = {
    n_samples: 15,
    split: { n_train: 10, n_test: 5, actual_train_percent: 67, actual_test_percent: 33 },
    diagnostics: {
      converged: true,
      initial_loss: 0.69,
      final_loss: 0.35,
      iterations: 50,
      gradient_norm: 1e-4,
      stop_reason: "tolerance",
      elapsed_seconds: 0.05,
      step_reductions: 0,
      loss_history: [0.69, 0.35],
    },
    training_settings: { l2_lambda: 0, class_weight: null },
    metrics: {
      accuracy: 0.8,
      auc: 0.85,
      precision: 0.8,
      recall: 0.8,
      accuracy_gain: 0.1,
      baseline_accuracy: 0.7,
      log_loss: 0.4,
      brier_score: 0.12,
    },
    coefficients: [
      { name: "<img src=x onerror=alert(1)>", coef: 1.234, odds_ratio: 3.43, p_value: 0.02 },
    ],
    cross_validation: null,
    inference: { reason: "scratch" },
    roc: { fpr: [0, 1], tpr: [0, 1] },
    suggested_threshold: 0.5,
    threshold: { value: 0.5, note: "f1", source: "test" },
    threshold_data: { y_true: [1, 0], prob: [0.6, 0.4] },
    class_labels: { positive: "1", negative: "0" },
    feature_names: ["<img src=x onerror=alert(1)>"],
  };
  vm.runInContext(`renderResults(${JSON.stringify(mockResult)})`, context);
  assert.equal(tbody.children.length, 1);
  const row = tbody.children[0];
  // Name was set as textContent, not parsed as HTML element child
  assert.equal(row.children[0].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(row.children[0].innerHTML, "");
});

function createMockExcelContext(sheets = {}, workbookNames = {}, activeSheet = "churn_data") {
  const wsMap = {};
  for (const [name, cfg] of Object.entries(sheets)) {
    const localNames = cfg.names || {};
    const ranges = cfg.ranges || {};
    wsMap[name] = {
      id: cfg.id || `{id-${name}}`,
      name,
      isNullObject: false,
      load() {},
      names: {
        getItemOrNullObject(itemName) {
          const match = Object.keys(localNames).find((k) => k.toLowerCase() === itemName.toLowerCase());
          return match ? localNames[match] : { isNullObject: true, load() {} };
        },
      },
      getRange(addr) {
        if (ranges[addr]) return ranges[addr];
        const match = Object.keys(ranges).find((k) => k.toLowerCase() === addr.toLowerCase());
        if (match) return ranges[match];
        throw new Error(`Range ${addr} not found on sheet ${name}`);
      },
    };
  }

  let active = activeSheet;
  const context = {
    workbook: {
      worksheets: {
        get items() {
          return Object.values(wsMap);
        },
        load() {},
        getActiveWorksheet() {
          return wsMap[active];
        },
        getItemOrNullObject(name) {
          return wsMap[name] || { isNullObject: true, load() {} };
        },
        add(name) {
          const ranges = [];
          const sheet = {
            id: `{id-${name}}`,
            name,
            load() {},
            getRange(addr) {
              const r = {
                address: addr,
                row: 0,
                col: 0,
                numRows: 1,
                numCols: 1,
                values: null,
                numberFormat: null,
                format: { font: {}, autofitColumns() {} },
              };
              ranges.push(r);
              if (addr === "A1") {
                sheet._a1Range = r;
              }
              return r;
            },
            getRangeByIndexes(row, col, numRows, numCols) {
              const r = {
                row,
                col,
                numRows,
                numCols,
                values: null,
                numberFormat: null,
                format: { font: {}, autofitColumns() {} },
              };
              ranges.push(r);
              return r;
            },
            getUsedRange() {
              return { format: { autofitColumns() {} } };
            },
            freezePanes: { freezeRows() {} },
            activate() {},
            _ranges: ranges,
          };
          wsMap[name] = sheet;
          return sheet;
        },
      },

      names: {
        getItemOrNullObject(itemName) {
          const match = Object.keys(workbookNames).find((k) => k.toLowerCase() === itemName.toLowerCase());
          return match ? workbookNames[match] : { isNullObject: true, load() {} };
        },
      },
      getSelectedRange() {
        return context._selectedRange || { address: "Sheet1!$A$1:$B$2", load() {} };
      },
    },
    _selectedRange: { address: "Sheet1!$A$1:$B$2", load() {} },
    setSelectedRange(addr) {
      context._selectedRange = { address: addr, load() {} };
    },
    setActiveSheet(name) {
      active = name;
    },
    sync: async () => {},
  };
  return context;
}

function makeRange(sheetName, address, values, rowIndex = 0, columnIndex = 0) {
  return {
    address: `${sheetName}!${address}`,
    values,
    rowIndex,
    columnIndex,
    rowCount: values.length,
    columnCount: values[0].length,
    worksheet: { id: `{id-${sheetName}}`, name: sheetName, load() {} },
    load() {},
  };
}

function makeNamedItem(name, range, scope = "Workbook") {
  return {
    name,
    type: "Range",
    scope,
    isNullObject: false,
    load() {},
    getRange() {
      return range;
    },
  };
}

test("readTrainingData resolves both named range and cell address, yielding identical dataset", async () => {
  const xValues = [
    ["FeatureA", "FeatureB"],
    [1.0, 2.0],
    [3.0, 4.0],
    [5.0, 6.0],
    [7.0, 8.0],
  ];
  const yValues = [
    ["Churn"],
    [0],
    [1],
    [0],
    [1],
  ];

  const xRange = makeRange("churn_data", "$A$1:$B$5", xValues, 0, 0);
  const yRange = makeRange("churn_data", "$J$1:$J$5", yValues, 0, 9);

  const excelContext = createMockExcelContext(
    {
      churn_data: {
        id: "s-churn",
        ranges: {
          "A1:B5": xRange,
          "$A$1:$B$5": xRange,
          "J1:J5": yRange,
          "$J$1:$J$5": yRange,
        },
      },
    },
    {
      CustomerFeatures: makeNamedItem("CustomerFeatures", xRange, "Workbook"),
      ChurnOutcome: makeNamedItem("ChurnOutcome", yRange, "Workbook"),
    },
    "churn_data"
  );

  const { context, elements } = bootTaskPane({ excelContext });

  // 1. Read with defined names
  const namedResult = await vm.runInContext(
    'readTrainingData("ChurnOutcome", "CustomerFeatures")',
    context
  );

  // 2. Read with cell addresses
  const addressResult = await vm.runInContext(
    'readTrainingData("churn_data!J1:J5", "churn_data!A1:B5")',
    context
  );

  // Verify numerical and label features match exactly
  assert.deepEqual(namedResult.features, addressResult.features);
  assert.deepEqual(namedResult.labels, addressResult.labels);
  assert.deepEqual(namedResult.featureNames, addressResult.featureNames);

  // Verify descriptors identify kind
  assert.equal(namedResult.source.x.kind, "name");
  assert.equal(namedResult.source.x.canonicalName, "CustomerFeatures");
  assert.equal(namedResult.source.x.scope, "Workbook");
  assert.equal(addressResult.source.x.kind, "address");

  // Verify resolution preview was displayed
  const preview = elements["data-preview"];
  assert.equal(preview.classList.contains("hidden"), false);
  const textContent = preview.textContent;
  assert.match(textContent, /churn_data!\$A\$1:\$B\$5; 4 data rows, 2 features/);
  assert.match(textContent, /churn_data!\$J\$1:\$J\$5; 4 data rows, 1 outcome/);
});

test("readTrainingData handles mixed inputs: X as name, Y as address", async () => {
  const xValues = [["F1", "F2"], [1, 2], [3, 4], [5, 6]];
  const yValues = [["Label"], [0], [1], [0]];
  const xRange = makeRange("Sheet1", "$A$1:$B$4", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$C$1:$C$4", yValues, 0, 2);

  const excelContext = createMockExcelContext(
    {
      Sheet1: {
        id: "s1",
        ranges: { "C1:C4": yRange, "$C$1:$C$4": yRange },
      },
    },
    {
      FeatName: makeNamedItem("FeatName", xRange, "Workbook"),
    },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const result = await vm.runInContext('readTrainingData("Sheet1!C1:C4", "FeatName")', context);
  assert.equal(result.source.x.kind, "name");
  assert.equal(result.source.y.kind, "address");
  assert.equal(result.features.length, 3);
});

test("readTrainingData rejects mismatched rows or sheets on named ranges", async () => {
  const xValues = [["F1"], [1], [2], [3]];
  const yValuesDiffSheet = [["Y"], [0], [1], [0]];
  const yValuesDiffRows = [["Y"], [0], [1]];

  const xRange = makeRange("Sheet1", "$A$1:$A$4", xValues, 0, 0);
  const yRangeDiffSheet = makeRange("Sheet2", "$B$1:$B$4", yValuesDiffSheet, 0, 1);
  const yRangeDiffRows = makeRange("Sheet1", "$B$1:$B$3", yValuesDiffRows, 0, 1);

  const excelContext = createMockExcelContext(
    {
      Sheet1: { id: "s1" },
      Sheet2: { id: "s2" },
    },
    {
      XFeat: makeNamedItem("XFeat", xRange, "Workbook"),
      YDiffSheet: makeNamedItem("YDiffSheet", yRangeDiffSheet, "Workbook"),
      YDiffRows: makeNamedItem("YDiffRows", yRangeDiffRows, "Workbook"),
    },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });

  await assert.rejects(
    () => vm.runInContext('readTrainingData("YDiffSheet", "XFeat")', context),
    /X and Y must be on the same worksheet/
  );

  await assert.rejects(
    () => vm.runInContext('readTrainingData("YDiffRows", "XFeat")', context),
    /X and Y must start on the same row and have the same number of rows/
  );
});

test("readNewFeatureData resolves named range for new rows and validates schema", async () => {
  const newValues = [["F1", "F2"], [10.5, 20.5]];
  const newRange = makeRange("Sheet1", "$A$1:$B$2", newValues, 0, 0);

  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1" } },
    { NewRows: makeNamedItem("NewRows", newRange, "Workbook") },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const result = await vm.runInContext(
    'readNewFeatureData("NewRows", true, ["F1", "F2"])',
    context
  );
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0][0], 10.5);
  assert.equal(result.source.kind, "name");
  assert.equal(result.source.canonicalName, "NewRows");
});

test("writePredictions blocks export and emits actionable message when named range changes", async () => {
  const xValues = [["F1"], [1.0], [2.0]];
  const yValues = [["Y"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$A$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$B$1:$B$3", yValues, 0, 1);

  const excelContext = createMockExcelContext(
    {
      Sheet1: {
        id: "s1",
        ranges: { "A1:A3": xRange, "B1:B3": yRange },
      },
      Sheet2: { id: "s2" },
    },
    {
      TrainX: makeNamedItem("TrainX", xRange, "Workbook"),
      TrainY: makeNamedItem("TrainY", yRange, "Workbook"),
    },
    "Sheet1"
  );

  const { context, elements } = bootTaskPane({ excelContext });

  const input = await vm.runInContext('readTrainingData("TrainY", "TrainX")', context);

  // Set active model
  vm.runInContext(
    `LAST_RESULT = {
      model_id: "m1",
      _source: ${JSON.stringify(input.source)},
      _activeThreshold: 0.5,
      _stale: false,
      feature_names: ["F1"],
      class_labels: { positive: "1", negative: "0" },
      split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
      n_samples: 2,
      metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
      metrics_at_threshold: { accuracy: 1, precision: 1, recall: 1, f1: 1 },
      threshold: { value: 0.5, source: "test" },
      predictions: { prob: [0.1, 0.9], partition: ["train", "test"] },
      coefficients: [{ name: "F1", coef: 1.2, odds_ratio: 3.3 }],
      inference: {},
    };
    setModelActionsEnabled(true);`,
    context
  );

  // 1. Re-verification succeeds even if active worksheet is switched to Sheet2
  excelContext.setActiveSheet("Sheet2");
  const matchesActiveSwitched = await vm.runInContext("sourceStillMatches(LAST_RESULT._source)", context);
  assert.equal(matchesActiveSwitched, true);

  // 2. Modifying named range target or values in Excel fails verification
  xRange.values = [["F1"], [999.0], [2.0]];
  const matchesAltered = await vm.runInContext("sourceStillMatches(LAST_RESULT._source)", context);
  assert.equal(matchesAltered, false);

  // Attempting writePredictions throws
  await vm.runInContext("writePredictions()", context);
  assert.equal(elements["error-toast"].textContent, "Export failed: The named range changed. Fit/score again.");
});

test("reportMetadataRows exports original input text, scope, and resolved absolute address", () => {
  const { context } = bootTaskPane();
  const mockResult = {
    model_id: "mod-123",
    _trainedAt: "2026-10-14T00:00:00Z",
    _source: {
      x: {
        originalText: "CustomerFeatures",
        kind: "name",
        canonicalName: "CustomerFeatures",
        scope: "Workbook",
        absoluteAddress: "churn_data!$A$1:$I$401",
      },
      y: {
        originalText: "ChurnOutcome",
        kind: "name",
        canonicalName: "ChurnOutcome",
        scope: "Workbook",
        absoluteAddress: "churn_data!$J$1:$J$401",
      },
    },
    split: { n_train: 280, n_test: 120, actual_train_percent: 70, actual_test_percent: 30 },
    n_samples: 400,
    feature_names: ["f1", "f2"],
    class_labels: { positive: "1", negative: "0" },
    training_settings: {},
    diagnostics: {},
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3 },
    metrics_at_threshold: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8 },
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
    inference: {},
  };

  const rows = vm.runInContext(`reportMetadataRows(${JSON.stringify(mockResult)})`, context);
  const xRow = rows.find((r) => r[0] === "Source X");
  const yRow = rows.find((r) => r[0] === "Source Y");

  assert.equal(xRow[1], "CustomerFeatures (Workbook) -> churn_data!$A$1:$I$401");
  assert.equal(yRow[1], "ChurnOutcome (Workbook) -> churn_data!$J$1:$J$401");
});

test("learned weights and b populate params-table and equation text, not placeholders", () => {
  const { context, elements, paramsTbody } = bootTaskPane();
  const mockResult = {
    model_id: "test-model-abc",
    n_samples: 30,
    split: { n_train: 20, n_test: 10, actual_train_percent: 67, actual_test_percent: 33 },
    feature_names: ["Tenure", "MonthlyCharges", "Contract"],
    class_labels: { positive: "Churn", negative: "Stay" },
    standardized: true,
    suggested_threshold: 0.45,
    threshold: { value: 0.45, source: "training_cv" },
    coefficients: [
      { name: "Intercept", coef: -0.4321, odds_ratio: 0.6491, p_value: null },
      { name: "Tenure", coef: -0.6543, odds_ratio: 0.5198, p_value: null },
      { name: "MonthlyCharges", coef: 0.3219, odds_ratio: 1.3797, p_value: null },
      { name: "Contract", coef: -0.8765, odds_ratio: 0.4162, p_value: null },
    ],
    parameters: {
      model_id: "test-model-abc",
      feature_names: ["Tenure", "MonthlyCharges", "Contract"],
      feature_space: "standardized",
      weights_model_space: [-0.6543, 0.3219, -0.8765],
      intercept_model_space: -0.4321,
      weights_original_units: [-0.06543, 0.003219, -0.43825],
      intercept_original_units: 0.8123,
      feature_means: [24.0, 70.0, 1.2],
      feature_scales: [10.0, 100.0, 2.0],
      standardized: true,
      conversion_valid: true,
      class_labels: { positive: "Churn", negative: "Stay" },
    },
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3, log_loss: 0.4, brier_score: 0.15 },
    diagnostics: { converged: true, iterations: 150, final_loss: 0.35 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: { reason: "Gradient descent" },
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  // Table should have Intercept + 3 features = 4 rows
  assert.equal(paramsTbody.children.length, 4);

  // Intercept row check
  const bRow = paramsTbody.children[0];
  assert.equal(bRow.children[0].textContent, "b");
  assert.equal(bRow.children[1].textContent, "Intercept (Bias)");
  assert.equal(bRow.children[2].textContent, "-0.4321");
  assert.equal(bRow.children[3].textContent, "+0.8123");

  // Feature rows check
  const w1Row = paramsTbody.children[1];
  assert.equal(w1Row.children[0].textContent, "w1");
  assert.equal(w1Row.children[1].textContent, "Tenure");
  assert.equal(w1Row.children[2].textContent, "-0.6543");
  assert.equal(w1Row.children[3].textContent, "-0.0654");

  // Equation preview check
  const scoreEq = elements["eq-score-text"].textContent;
  assert.ok(scoreEq.includes("x1"));
  assert.ok(scoreEq.includes("-0.0654"));
  assert.ok(scoreEq.includes("+0.0032"));
  assert.ok(scoreEq.includes("+0.8123"));

  // Decision rule text
  assert.ok(elements["eq-decision-text"].textContent.includes("Churn"));
  assert.ok(elements["eq-decision-text"].textContent.includes("Stay"));
  assert.ok(elements["eq-decision-text"].textContent.includes("0.45"));
});

test("what-if step-by-step contributions sum plus b matches backend score and probability", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "test-model-abc",
          threshold: 0.5,
          class_labels: { positive: "Churn", negative: "Stay" },
          results: [{ score: 0.693147, prob: 0.666667, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "test-model-abc",
    n_samples: 30,
    split: { n_train: 20, n_test: 10, actual_train_percent: 67, actual_test_percent: 33 },
    feature_names: ["Tenure", "MonthlyCharges"],
    class_labels: { positive: "Churn", negative: "Stay" },
    standardized: true,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: -0.1, odds_ratio: 0.9, p_value: null },
      { name: "Tenure", coef: -0.5, odds_ratio: 0.6, p_value: null },
      { name: "MonthlyCharges", coef: 0.8, odds_ratio: 2.2, p_value: null },
    ],
    parameters: {
      model_id: "test-model-abc",
      feature_names: ["Tenure", "MonthlyCharges"],
      weights_model_space: [-0.5, 0.8],
      intercept_model_space: -0.1,
      weights_original_units: [-0.05, 0.04],
      intercept_original_units: -0.2,
      feature_means: [10.0, 50.0],
      feature_scales: [10.0, 20.0],
      standardized: true,
      conversion_valid: true,
      class_labels: { positive: "Churn", negative: "Stay" },
    },
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3, log_loss: 0.4, brier_score: 0.15 },
    diagnostics: { converged: true, iterations: 100, final_loss: 0.3 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  // Set inputs for whatif
  const inputs = elements["whatif-inputs"].children.map((lbl) => lbl.children.find((c) => c.tagName === "INPUT"));
  inputs[0].value = "20"; // Tenure (scaled: (20 - 10) / 10 = 1.0)
  inputs[1].value = "70"; // MonthlyCharges (scaled: (70 - 50) / 20 = 1.0)

  // Run what-if
  await vm.runInContext("runWhatIf()", context);

  // Result box should be visible
  assert.equal(elements["whatif-result"].classList.contains("hidden"), false);

  // What-if table should have 2 feature rows
  assert.equal(whatifTbody.children.length, 2);

  // Verify feature 1 row (Tenure: input 20, scaled 1.0, weight -0.5, contribution -0.5)
  const r1 = whatifTbody.children[0];
  assert.equal(r1.children[0].textContent, "Tenure");
  assert.equal(r1.children[1].textContent, "20.0000");
  assert.equal(r1.children[2].textContent, "1.0000");
  assert.equal(r1.children[3].textContent, "-0.5000");
  assert.equal(r1.children[4].textContent, "-0.5000");

  // Verify feature 2 row (MonthlyCharges: input 70, scaled 1.0, weight 0.8, contribution +0.8)
  const r2 = whatifTbody.children[1];
  assert.equal(r2.children[0].textContent, "MonthlyCharges");
  assert.equal(r2.children[1].textContent, "70.0000");
  assert.equal(r2.children[2].textContent, "1.0000");
  assert.equal(r2.children[3].textContent, "0.8000");
  assert.equal(r2.children[4].textContent, "+0.8000");

  // Verify summary text
  assert.ok(elements["whatif-summary"].textContent.includes("66.67%"));
  assert.ok(elements["whatif-summary"].textContent.includes("Churn"));

  // Verify steps container has 5 steps
  const steps = elements["whatif-calculation-steps"].children;
  assert.equal(steps.length, 5);
  assert.ok(steps[0].textContent.includes("0.3000")); // -0.5 + 0.8 = 0.3
  assert.ok(steps[1].textContent.includes("-0.1000")); // b = -0.1
  assert.ok(steps[2].textContent.includes("0.6931")); // z = 0.6931
  assert.ok(steps[3].textContent.includes("66.67%"));
  assert.ok(steps[4].textContent.includes("Class 1 (Churn)"));
});

test("moving threshold preserves weights, score, and probability while updating predicted class", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "test-model-abc",
          threshold: 0.5,
          class_labels: { positive: "Churn", negative: "Stay" },
          results: [{ score: 0.693147, prob: 0.666667, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "test-model-abc",
    n_samples: 20,
    split: { n_train: 14, n_test: 6, actual_train_percent: 70, actual_test_percent: 30 },
    feature_names: ["Tenure"],
    class_labels: { positive: "Churn", negative: "Stay" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: 0.0, odds_ratio: 1.0, p_value: null },
      { name: "Tenure", coef: 0.6931, odds_ratio: 2.0, p_value: null },
    ],
    parameters: {
      model_id: "test-model-abc",
      feature_names: ["Tenure"],
      weights_model_space: [0.6931],
      intercept_model_space: 0.0,
      weights_original_units: [0.6931],
      intercept_original_units: 0.0,
      feature_means: null,
      feature_scales: null,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Churn", negative: "Stay" },
    },
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3, log_loss: 0.4, brier_score: 0.15 },
    diagnostics: { converged: true, iterations: 50, final_loss: 0.3 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  const input = elements["whatif-inputs"].children[0].children.find((c) => c.tagName === "INPUT");
  input.value = "1.0";
  await vm.runInContext("runWhatIf()", context);

  // At threshold 0.5, pred is 1 (Churn)
  assert.ok(elements["whatif-summary"].textContent.includes("Churn"));

  // Move threshold to 0.75 (higher than 0.666667)
  elements.threshold.value = "0.75";
  elements.threshold.trigger("input", { target: { value: "0.75" } });

  // Probability must remain 66.67%, but predicted class flips to Stay
  assert.ok(elements["whatif-summary"].textContent.includes("66.67%"));
  assert.ok(elements["whatif-summary"].textContent.includes("Stay"));

  const stepDecision = elements["whatif-calculation-steps"].children[4];
  assert.ok(stepDecision.textContent.includes("Class 0 (Stay)"));
});

test("editing what-if inputs invalidates explanation until recalculation", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "test-model-abc",
          threshold: 0.5,
          class_labels: { positive: "Churn", negative: "Stay" },
          results: [{ score: 0.5, prob: 0.622, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "test-model-abc",
    n_samples: 20,
    split: { n_train: 14, n_test: 6, actual_train_percent: 70, actual_test_percent: 30 },
    feature_names: ["Tenure"],
    class_labels: { positive: "Churn", negative: "Stay" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: 0.0, odds_ratio: 1.0, p_value: null },
      { name: "Tenure", coef: 0.5, odds_ratio: 1.65, p_value: null },
    ],
    parameters: {
      model_id: "test-model-abc",
      feature_names: ["Tenure"],
      weights_model_space: [0.5],
      intercept_model_space: 0.0,
      weights_original_units: [0.5],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Churn", negative: "Stay" },
    },
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3, log_loss: 0.4, brier_score: 0.15 },
    diagnostics: { converged: true, iterations: 50, final_loss: 0.3 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  const input = elements["whatif-inputs"].children[0].children.find((c) => c.tagName === "INPUT");
  input.value = "1.0";
  await vm.runInContext("runWhatIf()", context);

  assert.equal(elements["whatif-result"].classList.contains("hidden"), false);

  // User edits input value
  input.trigger("input");

  // Explanation must be immediately hidden / invalidated
  assert.equal(elements["whatif-result"].classList.contains("hidden"), true);
  const lastWhatIf = vm.runInContext("LAST_RESULT._lastWhatIf", context);
  assert.equal(lastWhatIf, null);
});

test("exportModelWeights creates uniquely named sheet and writes full parameters, equations, and recalculable SUMPRODUCT formula", async () => {
  const xValues = [["Age", "Income", "Score"], [40.0, 50000.0, 600.0], [50.0, 60000.0, 700.0]];
  const yValues = [["Default"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$C$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$D$1:$D$3", yValues, 0, 3);

  const excelContext = createMockExcelContext(
    {
      Sheet1: {
        id: "s1",
        ranges: { "A1:C3": xRange, "$A$1:$C$3": xRange, "D1:D3": yRange, "$D$1:$D$3": yRange },
      },
    },
    {
      CustFeats: makeNamedItem("CustFeats", xRange, "Workbook"),
      CustOutcome: makeNamedItem("CustOutcome", yRange, "Workbook"),
    },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const input = await vm.runInContext('readTrainingData("CustOutcome", "CustFeats")', context);

  const mockResult = {
    model_id: "test-model-xyz",
    _trainedAt: "2026-10-14T01:00:00Z",
    _source: input.source,
    _activeThreshold: 0.5,
    _stale: false,
    n_samples: 2,
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    feature_names: ["Age", "Income", "Score"],
    class_labels: { positive: "Default", negative: "Good" },
    standardized: true,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    coefficients: [
      { name: "Intercept", coef: -0.4, odds_ratio: 0.67, p_value: null },
      { name: "Age", coef: 0.6, odds_ratio: 1.82, p_value: null },
      { name: "Income", coef: -0.3, odds_ratio: 0.74, p_value: null },
      { name: "Score", coef: 0.2, odds_ratio: 1.22, p_value: null },
    ],
    parameters: {
      model_id: "test-model-xyz",
      feature_names: ["Age", "Income", "Score"],
      weights_model_space: [0.6, -0.3, 0.2],
      intercept_model_space: -0.4,
      weights_original_units: [0.06, -0.0003, 0.02],
      intercept_original_units: -1.5,
      feature_means: [40.0, 50000.0, 600.0],
      feature_scales: [10.0, 1000.0, 10.0],
      standardized: true,
      conversion_valid: true,
      class_labels: { positive: "Default", negative: "Good" },
    },
    metrics: { accuracy: 0.85, precision: 0.85, recall: 0.85, f1: 0.85, auc: 0.9, baseline_accuracy: 0.5, accuracy_gain: 0.35, log_loss: 0.3, brier_score: 0.1 },
    diagnostics: { converged: true, iterations: 120, final_loss: 0.25 },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  // Click Export model weights
  await vm.runInContext("exportModelWeights()", context);

  // Find added Model Weights sheet
  const createdSheet = excelContext.workbook.worksheets.items.find((s) => s.name && s.name.startsWith("Model Weights"));
  assert.ok(createdSheet, "Model Weights worksheet must be created");
  assert.match(createdSheet.name, /^Model Weights \d{14}/);

  // Inspect ranges written to createdSheet
  // 1. Metadata Block
  const metaRange = createdSheet._ranges.find((r) => r.row === 0 && r.col === 0 && r.numCols === 2);
  assert.ok(metaRange, "Metadata range should be written at row 0");
  assert.equal(metaRange.values[1][0], "Model ID");
  assert.equal(metaRange.values[1][1], "test-model-xyz");
  assert.equal(metaRange.values[10][0], "Active Decision Threshold");
  assert.equal(metaRange.values[10][1], "0.50");

  // 2. Parameter Specification Table
  const paramTableRange = createdSheet._ranges.find((r) => r.row === 14 && r.col === 0 && r.numCols === 7);
  assert.ok(paramTableRange, "Parameter table range should be written at row 14");
  assert.deepEqual(Array.from(paramTableRange.values[0]), [
    "Parameter", "Feature Name", "Original-Unit Weight", "Model-Space Weight",
    "Training Mean", "Training Scale (Pop Std Dev)", "Unit Interpretation",
  ]);
  // Intercept row at row 15 (Excel row 16)
  assert.equal(paramTableRange.values[1][0], "b (Intercept)");
  assert.equal(paramTableRange.values[1][1], "Intercept");
  assert.equal(paramTableRange.values[1][2], -1.5);
  assert.equal(paramTableRange.values[1][3], -0.4);
  // Feature rows at rows 16..18 (Excel rows 17..19)
  assert.equal(paramTableRange.values[2][0], "w1");
  assert.equal(paramTableRange.values[2][1], "Age");
  assert.equal(paramTableRange.values[2][2], 0.06);
  assert.equal(paramTableRange.values[2][3], 0.6);
  assert.equal(paramTableRange.values[3][0], "w2");
  assert.equal(paramTableRange.values[3][1], "Income");
  assert.equal(paramTableRange.values[3][2], -0.0003);
  assert.equal(paramTableRange.values[3][3], -0.3);
  assert.equal(paramTableRange.values[4][0], "w3");
  assert.equal(paramTableRange.values[4][1], "Score");
  assert.equal(paramTableRange.values[4][2], 0.02);
  assert.equal(paramTableRange.values[4][3], 0.2);

  // 3. Live Recalculable Example Grid & Calculation Block
  const gridRange = createdSheet._ranges.find((r) => r.row === 31 && r.col === 0 && r.numCols === 4);
  assert.ok(gridRange, "Formula grid should be written at row 31");
  assert.deepEqual(Array.from(gridRange.values[0]), ["Row / Feature", "Age", "Income", "Score"]);
  assert.deepEqual(Array.from(gridRange.values[1]), ["Example Input (x)", 40.0, 50000.0, 600.0]);
  assert.deepEqual(Array.from(gridRange.values[2]), ["Original-Unit Weight (w)", "=C17", "=C18", "=C19"]);

  const calcRange = createdSheet._ranges.find((r) => r.row === 35 && r.col === 0 && r.numCols === 2);
  assert.ok(calcRange, "Calculation block should be written at row 35 (Excel rows 36-41)");

  // Assert exact formulas and values in the calculation block:
  // Row c (Excel row 36, cell B36): Intercept linked
  assert.equal(calcRange.values[0][0], "Intercept b (linked)");
  assert.equal(calcRange.values[0][1], "=C16");

  // Row c+1 (Excel row 37, cell B37): Decision Threshold
  assert.equal(calcRange.values[1][0], "Decision Threshold");
  assert.equal(calcRange.values[1][1], 0.5);

  // Row c+2 (Excel row 38, cell B38): Score formula
  assert.equal(calcRange.values[2][0], "Linear Score z (Formula)");
  assert.equal(calcRange.values[2][1], "=SUMPRODUCT(B33:D33, B34:D34) + B36");

  // Row c+3 (Excel row 39, cell B39): Probability formula
  assert.equal(calcRange.values[3][0], "Probability p (Formula)");
  assert.equal(calcRange.values[3][1], "=IF(B38>=0, 1/(1+EXP(-B38)), EXP(B38)/(1+EXP(B38)))");

  // Row c+4 (Excel row 40, cell B40): Predicted Class formula
  assert.equal(calcRange.values[4][0], "Predicted Class (Formula)");
  assert.equal(calcRange.values[4][1], "=IF(B39>=B37, 1, 0)");

  // Row c+5 (Excel row 41, cell B41): Predicted Label formula
  assert.equal(calcRange.values[5][0], "Predicted Label (Formula)");
  assert.equal(calcRange.values[5][1], '=IF(B40=1, "Default", "Good")');

  // Verify ABSENCE OF CIRCULAR REFERENCES:
  // B38 must NOT contain B38 or forward references
  assert.equal(calcRange.values[2][1].includes("B38"), false, "Score must not reference itself B38");
  assert.equal(calcRange.values[2][1].includes("B39"), false, "Score must not reference probability B39");

  // B39 must NOT contain B39 or forward references
  assert.equal(calcRange.values[3][1].includes("B39"), false, "Probability must not reference itself B39");
  assert.equal(calcRange.values[3][1].includes("B40"), false, "Probability must not reference class B40");

  // B40 must NOT contain B40 or forward references
  assert.equal(calcRange.values[4][1].includes("B40"), false, "Class must not reference itself B40");
  assert.equal(calcRange.values[4][1].includes("B41"), false, "Class must not reference label B41");

  // B41 must NOT contain B41
  assert.equal(calcRange.values[5][1].includes("B41"), false, "Label must not reference itself B41");
});

test("large feature counts (50 features) use compact equation in UI", () => {
  const { context, elements, paramsTbody } = bootTaskPane();
  const nFeats = 50;
  const names = Array.from({ length: nFeats }, (_, i) => `Feature_${i + 1}`);
  const weights = Array.from({ length: nFeats }, (_, i) => (i + 1) * 0.05);

  const mockResult = {
    model_id: "test-model-large",
    n_samples: 50,
    split: { n_train: 40, n_test: 10, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: names,
    class_labels: { positive: "Yes", negative: "No" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: 0.1, odds_ratio: 1.1, p_value: null },
      ...names.map((name, i) => ({ name, coef: weights[i], odds_ratio: 1.0, p_value: null })),
    ],
    parameters: {
      model_id: "test-model-large",
      feature_names: names,
      weights_model_space: weights,
      intercept_model_space: 0.1,
      weights_original_units: weights,
      intercept_original_units: 0.1,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Yes", negative: "No" },
    },
    metrics: { accuracy: 0.8, precision: 0.8, recall: 0.8, f1: 0.8, auc: 0.85, baseline_accuracy: 0.5, accuracy_gain: 0.3, log_loss: 0.4, brier_score: 0.15 },
    diagnostics: { converged: true, iterations: 50, final_loss: 0.3 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  // Table must contain all 50 features + 1 intercept = 51 rows
  assert.equal(paramsTbody.children.length, 51);

  // Compact equation displayed
  const scoreEq = elements["eq-score-text"].textContent;
  assert.equal(scoreEq, "z = Σ (wⱼ · xⱼ) + b   [j = 1..50]");
});

test("three-feature worked example evaluates z=1.1, p≈0.75026, class=1 at threshold 0.5 without cycles", async () => {
  const xValues = [["Age", "Income", "Score"], [2.0, 1.0, 3.0], [4.0, 2.0, 6.0]];
  const yValues = [["Default"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$C$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$D$1:$D$3", yValues, 0, 3);

  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:C3": xRange, "$A$1:$C$3": xRange, "D1:D3": yRange, "$D$1:$D$3": yRange } } },
    { Feats: makeNamedItem("Feats", xRange, "Workbook"), Target: makeNamedItem("Target", yRange, "Workbook") },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const input = await vm.runInContext('readTrainingData("Target", "Feats")', context);

  // Worked example weights: w = [0.6, -0.3, 0.2], b = -0.4, x = [2, 1, 3]
  const mockResult = {
    model_id: "worked-example-3feat",
    _trainedAt: "2026-10-14T02:00:00Z",
    _source: input.source,
    _activeThreshold: 0.5,
    _lastWhatIf: { row: [2.0, 1.0, 3.0] },
    _stale: false,
    n_samples: 1,
    split: { n_train: 1, n_test: 0, actual_train_percent: 100, actual_test_percent: 0 },
    feature_names: ["Age", "Income", "Score"],
    class_labels: { positive: "Default", negative: "Good" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    coefficients: [
      { name: "Intercept", coef: -0.4, odds_ratio: 0.67, p_value: null },
      { name: "Age", coef: 0.6, odds_ratio: 1.82, p_value: null },
      { name: "Income", coef: -0.3, odds_ratio: 0.74, p_value: null },
      { name: "Score", coef: 0.2, odds_ratio: 1.22, p_value: null },
    ],
    parameters: {
      model_id: "worked-example-3feat",
      feature_names: ["Age", "Income", "Score"],
      weights_model_space: [0.6, -0.3, 0.2],
      intercept_model_space: -0.4,
      weights_original_units: [0.6, -0.3, 0.2],
      intercept_original_units: -0.4,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Default", negative: "Good" },
    },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [1], prob: [0.75] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("exportModelWeights()", context);

  const createdSheet = excelContext.workbook.worksheets.items.find((s) => s.name && s.name.startsWith("Model Weights"));
  assert.ok(createdSheet);

  const gridRange = createdSheet._ranges.find((r) => r.row === 31 && r.col === 0 && r.numCols === 4);
  assert.deepEqual(Array.from(gridRange.values[1]), ["Example Input (x)", 2.0, 1.0, 3.0]);

  const calcRange = createdSheet._ranges.find((r) => r.row === 35 && r.col === 0 && r.numCols === 2);
  assert.ok(calcRange);

  // Evaluate the formulas algebraically to assert the exact worked example:
  // z = w · x + b = 0.6*2 + (-0.3)*1 + 0.2*3 + (-0.4) = 1.2 - 0.3 + 0.6 - 0.4 = 1.1
  const w = [0.6, -0.3, 0.2];
  const x = [2.0, 1.0, 3.0];
  const b = -0.4;
  const z = w[0] * x[0] + w[1] * x[1] + w[2] * x[2] + b;
  assert.equal(Math.round(z * 1000) / 1000, 1.1);

  // p = 1 / (1 + exp(-z)) ≈ 0.7502601056
  const p = 1 / (1 + Math.exp(-z));
  assert.ok(Math.abs(p - 0.7502601056) < 1e-7);

  // class at threshold 0.5 is 1
  const predClass = p >= 0.5 ? 1 : 0;
  assert.equal(predClass, 1);
});

test("asynchronous what-if rejects delayed earlier response when a newer request completes first", async () => {
  let resolveReq1, resolveReq2;
  const req1Promise = new Promise((resolve) => { resolveReq1 = resolve; });
  const req2Promise = new Promise((resolve) => { resolveReq2 = resolve; });

  let callCount = 0;
  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      callCount += 1;
      if (callCount === 1) {
        await req1Promise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            model_id: "m-async",
            threshold: 0.5,
            class_labels: { positive: "Yes", negative: "No" },
            results: [{ score: 1.0, prob: 0.731, pred: 1 }],
          }),
        };
      } else {
        await req2Promise;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            model_id: "m-async",
            threshold: 0.5,
            class_labels: { positive: "Yes", negative: "No" },
            results: [{ score: 2.0, prob: 0.8808, pred: 1 }],
          }),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "m-async",
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: ["Feat1"],
    class_labels: { positive: "Yes", negative: "No" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: 0.0, odds_ratio: 1.0 },
      { name: "Feat1", coef: 1.0, odds_ratio: 2.7 },
    ],
    parameters: {
      model_id: "m-async",
      feature_names: ["Feat1"],
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      weights_original_units: [1.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Yes", negative: "No" },
    },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  const input = elements["whatif-inputs"].children[0].children.find((c) => c.tagName === "INPUT");

  // Request 1 starts
  input.value = "1.0";
  const p1 = vm.runInContext("runWhatIf()", context);

  // Request 2 starts immediately with a different value
  input.value = "2.0";
  const p2 = vm.runInContext("runWhatIf()", context);

  // Resolve Request 2 FIRST
  resolveReq2();
  await p2;

  // Verify Request 2 displayed: 88.08%
  assert.ok(elements["whatif-summary"].textContent.includes("88.08%"));

  // Now resolve Request 1 LATER (out of order)
  resolveReq1();
  await p1;

  // The obsolete Request 1 must NOT overwrite Request 2!
  assert.ok(elements["whatif-summary"].textContent.includes("88.08%"));
  assert.equal(elements["whatif-summary"].textContent.includes("73.10%"), false);
});

test("what-if reclassifies prediction using active threshold if slider changed during pending request", async () => {
  let resolveReq;
  const reqPromise = new Promise((resolve) => { resolveReq = resolve; });

  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      await reqPromise;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "m-thr",
          threshold: 0.5,
          class_labels: { positive: "HighRisk", negative: "LowRisk" },
          results: [{ score: 0.693, prob: 0.6667, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "m-thr",
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: ["F1"],
    class_labels: { positive: "HighRisk", negative: "LowRisk" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [
      { name: "Intercept", coef: 0.0, odds_ratio: 1.0 },
      { name: "F1", coef: 0.693, odds_ratio: 2.0 },
    ],
    parameters: {
      model_id: "m-thr",
      feature_names: ["F1"],
      weights_model_space: [0.693],
      intercept_model_space: 0.0,
      weights_original_units: [0.693],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "HighRisk", negative: "LowRisk" },
    },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  const input = elements["whatif-inputs"].children[0].children.find((c) => c.tagName === "INPUT");
  input.value = "1.0";

  // Start what-if
  const whatIfPromise = vm.runInContext("runWhatIf()", context);

  // User drags threshold slider to 0.75 while request is in-flight
  elements.threshold.value = "0.75";
  elements.threshold.trigger("input", { target: { value: "0.75" } });
  assert.equal(vm.runInContext("LAST_RESULT._activeThreshold", context), 0.75);

  // Now resolve the server response (which returns prob 0.6667)
  resolveReq();
  await whatIfPromise;

  // Since prob 0.6667 < threshold 0.75, it must be classified as LowRisk (class 0)
  assert.ok(elements["whatif-summary"].textContent.includes("66.67%"));
  assert.ok(elements["whatif-summary"].textContent.includes("Predicted class at threshold 0.75: LowRisk"));
});

test("what-if rejects delayed response if input values changed before response arrived", async () => {
  let resolveReq;
  const reqPromise = new Promise((resolve) => { resolveReq = resolve; });

  const fetchMock = async (url) => {
    if (url.endsWith("/predict")) {
      await reqPromise;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "m-change",
          threshold: 0.5,
          class_labels: { positive: "Yes", negative: "No" },
          results: [{ score: 0.5, prob: 0.622, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });
  const mockResult = {
    model_id: "m-change",
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: ["F1"],
    class_labels: { positive: "Yes", negative: "No" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [{ name: "F1", coef: 0.5 }],
    parameters: {
      model_id: "m-change",
      feature_names: ["F1"],
      weights_model_space: [0.5],
      intercept_model_space: 0.0,
      weights_original_units: [0.5],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Yes", negative: "No" },
    },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("renderResults(LAST_RESULT)", context);

  const input = elements["whatif-inputs"].children[0].children.find((c) => c.tagName === "INPUT");
  input.value = "1.0";

  // Start what-if
  const whatIfPromise = vm.runInContext("runWhatIf()", context);

  // User edits input while in-flight
  input.value = "5.0";
  input.trigger("input");

  // Explanation should already be hidden
  assert.equal(elements["whatif-result"].classList.contains("hidden"), true);

  // Resolve delayed response
  resolveReq();
  await whatIfPromise;

  // Delayed response should be rejected because input value doesn't match captured value
  assert.equal(elements["whatif-result"].classList.contains("hidden"), true);
  assert.equal(vm.runInContext("LAST_RESULT._lastWhatIf", context), null);
});

test("exportNewPredictions detects changed new-row source, clears prediction cache and preserves LAST_RESULT", async () => {
  const trainXRange = makeRange("Sheet1", "$A$1:$A$3", [["F1"], [1.0], [2.0]], 0, 0);
  const trainYRange = makeRange("Sheet1", "$B$1:$B$3", [["Y"], [0], [1]], 0, 1);
  const newRowRange = makeRange("Sheet2", "$A$1:$A$3", [["F1"], [3.0], [4.0]], 0, 0);

  const excelContext = createMockExcelContext(
    {
      Sheet1: { id: "s1", ranges: { "A1:A3": trainXRange, "$A$1:$A$3": trainXRange, "B1:B3": trainYRange, "$B$1:$B$3": trainYRange } },
      Sheet2: { id: "s2", ranges: { "A1:A3": newRowRange, "$A$1:$A$3": newRowRange } },
    },
    {
      TrainX: makeNamedItem("TrainX", trainXRange, "Workbook"),
      TrainY: makeNamedItem("TrainY", trainYRange, "Workbook"),
      NewRows: makeNamedItem("NewRows", newRowRange, "Workbook"),
    },
    "Sheet1"
  );

  const { context, elements } = bootTaskPane({ excelContext });
  const trainInput = await vm.runInContext('readTrainingData("TrainY", "TrainX")', context);
  const newInput = await vm.runInContext('readNewFeatureData("NewRows", true, ["F1"])', context);

  const mockResult = {
    model_id: "m-active-train",
    _source: trainInput.source,
    _activeThreshold: 0.5,
    _stale: false,
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold: { value: 0.5, source: "test" },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    parameters: {
      model_id: "m-active-train",
      feature_names: ["F1"],
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [{ name: "F1", coef: 1.0 }],
    inference: {},
  };

  const mockNewPrediction = {
    model_id: "m-active-train",
    _source: newInput.source,
    threshold: 0.5,
    feature_names: ["F1"],
    results: [{ prob: 0.8, pred: 1 }, { prob: 0.9, pred: 1 }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("LAST_NEW_PREDICTION = " + JSON.stringify(mockNewPrediction), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  elements["export-new-btn"].disabled = false;
  elements["export-new-btn"].classList.remove("hidden");

  assert.equal(elements["export-new-btn"].disabled, false);
  assert.equal(elements["writeback-btn"].disabled, false);
  assert.equal(elements["export-weights-btn"].disabled, false);

  // Modify Sheet2 new rows data
  newRowRange.values = [["F1"], [999.0], [4.0]];

  // Click export new predictions
  await vm.runInContext("exportNewPredictions()", context);

  // Toast displays actionable message: "The new-row data or named range changed. Score these rows again before exporting."
  assert.equal(elements["error-toast"].textContent, "Export failed: The new-row data or named range changed. Score these rows again before exporting.");

  // LAST_NEW_PREDICTION cleared and export-new-btn disabled
  assert.equal(vm.runInContext("LAST_NEW_PREDICTION", context), null);
  assert.equal(elements["export-new-btn"].disabled, true);

  // CRITICAL: Trained model on Sheet1 is STILL ACTIVE and NOT stale!
  assert.equal(vm.runInContext("LAST_RESULT._stale", context), false);
  assert.equal(elements["writeback-btn"].disabled, false);
  assert.equal(elements["export-weights-btn"].disabled, false);
});

test("renderResults displays exact zero loss, grad norm, and AUC as numbers instead of dashes", () => {
  const { context, elements } = bootTaskPane();
  const mockResult = {
    model_id: "m-zeroes",
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [{ name: "F1", coef: 0.0, odds_ratio: 1.0 }],
    parameters: {
      model_id: "m-zeroes",
      feature_names: ["F1"],
      weights_model_space: [0.0],
      intercept_model_space: 0.0,
      weights_original_units: [0.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    metrics: { accuracy: 0.5, precision: 0.0, recall: 0.0, f1: 0.0, auc: 0.0, baseline_accuracy: 0.5, accuracy_gain: 0.0, log_loss: 0.0, brier_score: 0.0 },
    diagnostics: { converged: true, iterations: 1, initial_loss: 0.693, final_loss: 0.0, gradient_norm: 0.0, stop_reason: "tolerance" },
    threshold_data: { y_true: [0, 1], prob: [0.5, 0.5] },
    inference: {},
  };

  vm.runInContext("renderResults(" + JSON.stringify(mockResult) + ")", context);

  assert.equal(elements["d-final-loss"].textContent, "0.0000");
  assert.equal(elements["d-grad-norm"].textContent, "0.00e+0");
  assert.equal(elements["m-auc"].textContent, "0.000");
});

test("renderResults and metadata report render training warnings and cross-validation warnings", () => {
  const { context, elements } = bootTaskPane();
  const mockResult = {
    model_id: "m-warn",
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [{ name: "F1", coef: 5.0, odds_ratio: 148.4 }],
    parameters: {
      model_id: "m-warn",
      feature_names: ["F1"],
      weights_model_space: [5.0],
      intercept_model_space: 0.0,
      weights_original_units: [5.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    training_warnings: ["Suspected complete or quasi-complete separation. Estimates may be unstable."],
    cross_validation: { warnings: ["Fold 2 failed to reach gradient tolerance."] },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    inference: {},
  };

  vm.runInContext("renderResults(" + JSON.stringify(mockResult) + ")", context);

  assert.equal(elements["eval-warning"].classList.contains("hidden"), false);
  assert.ok(elements["eval-warning"].textContent.includes("Suspected complete or quasi-complete separation"));
  assert.ok(elements["eval-warning"].textContent.includes("Fold 2 failed to reach gradient tolerance"));

  const rows = vm.runInContext("reportMetadataRows(" + JSON.stringify(mockResult) + ")", context);
  const trainWarnRow = rows.find((r) => r[0] === "Training Warnings");
  const cvWarnRow = rows.find((r) => r[0] === "Cross-Validation Warnings");
  assert.ok(trainWarnRow && trainWarnRow[1].includes("separation"));
  assert.ok(cvWarnRow && cvWarnRow[1].includes("Fold 2"));
});

test("reportMetadataRows reports requested split percentages 80/20 and 65/35 accurately", () => {
  const { context } = bootTaskPane();
  const res8020 = {
    model_id: "m-8020",
    split: { requested_train_percent: 80, requested_test_percent: 20, actual_train_percent: 80.0, actual_test_percent: 20.0, n_train: 80, n_test: 20 },
    n_samples: 100,
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    metrics_at_threshold: { accuracy: 1, precision: 1, recall: 1, f1: 1 },
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
  };
  const rows8020 = vm.runInContext("reportMetadataRows(" + JSON.stringify(res8020) + ")", context);
  const splitRow8020 = rows8020.find((r) => r[0] === "Requested Split");
  assert.equal(splitRow8020[1], "Train 80%, Test 20%");

  const res6535 = {
    ...res8020,
    split: { requested_train_percent: 65, requested_test_percent: 35, actual_train_percent: 65.0, actual_test_percent: 35.0, n_train: 65, n_test: 35 },
  };
  const rows6535 = vm.runInContext("reportMetadataRows(" + JSON.stringify(res6535) + ")", context);
  const splitRow6535 = rows6535.find((r) => r[0] === "Requested Split");
  assert.equal(splitRow6535[1], "Train 65%, Test 35%");
});

test("reportMetadataRows and export include implemented objective formula with no penalty on b", () => {
  const { context } = bootTaskPane();
  const mockResult = {
    model_id: "m-obj",
    split: { requested_train_percent: 70, requested_test_percent: 30, actual_train_percent: 70, n_train: 7, n_test: 3 },
    training_settings: { class_weight: "balanced", l2_lambda: 1.0 },
    n_samples: 10,
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    metrics_at_threshold: { accuracy: 1, precision: 1, recall: 1, f1: 1 },
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
  };
  const rows = vm.runInContext("reportMetadataRows(" + JSON.stringify(mockResult) + ")", context);
  const objRow = rows.find((r) => r[0] === "Objective Function");
  assert.ok(objRow, "Objective Function row must exist");
  assert.ok(objRow[1].includes("sum[s_i*loss_i]/sum[s_i] + (lambda/2)*sum[w_j^2] (no penalty on b)"));
});

test("exportModelWeights provides explicit standardized fallback grid when conversion_valid is false", async () => {
  const xValues = [["FeatureA", "FeatureB"], [10.0, 20.0], [15.0, 25.0]];
  const yValues = [["Churn"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$B$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$C$1:$C$3", yValues, 0, 2);

  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B3": xRange, "$A$1:$B$3": xRange, "C1:C3": yRange, "$C$1:$C$3": yRange } } },
    { Feats: makeNamedItem("Feats", xRange, "Workbook"), Target: makeNamedItem("Target", yRange, "Workbook") },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const input = await vm.runInContext('readTrainingData("Target", "Feats")', context);

  const mockResult = {
    model_id: "test-conversion-fail",
    _trainedAt: "2026-10-14T03:00:00Z",
    _source: input.source,
    _activeThreshold: 0.5,
    _stale: false,
    n_samples: 2,
    split: { n_train: 2, n_test: 0, actual_train_percent: 100, actual_test_percent: 0 },
    feature_names: ["FeatureA", "FeatureB"],
    class_labels: { positive: "Yes", negative: "No" },
    standardized: true,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    coefficients: [
      { name: "Intercept", coef: 0.1, odds_ratio: 1.1 },
      { name: "FeatureA", coef: 0.5, odds_ratio: 1.65 },
      { name: "FeatureB", coef: -0.3, odds_ratio: 0.74 },
    ],
    parameters: {
      model_id: "test-conversion-fail",
      feature_names: ["FeatureA", "FeatureB"],
      weights_model_space: [0.5, -0.3],
      intercept_model_space: 0.1,
      weights_original_units: null,
      intercept_original_units: null,
      feature_means: [10.0, 20.0],
      feature_scales: [2.0, 5.0],
      standardized: true,
      conversion_valid: false,
      conversion_reason: "Extreme offsets produced numerical score divergence",
      class_labels: { positive: "Yes", negative: "No" },
    },
    training_warnings: ["Extreme offsets produced numerical score divergence"],
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [1], prob: [0.7] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("exportModelWeights()", context);

  const createdSheet = excelContext.workbook.worksheets.items.find((s) => s.name && s.name.startsWith("Model Weights"));
  assert.ok(createdSheet);

  // Parameter table has "n/a" for original units
  const paramTableRange = createdSheet._ranges.find((r) => r.row === 15 && r.col === 0 && r.numCols === 7);
  assert.ok(paramTableRange);
  assert.equal(paramTableRange.values[1][2], "n/a"); // b orig
  assert.equal(paramTableRange.values[1][3], 0.1); // b model
  assert.equal(paramTableRange.values[2][2], "n/a"); // w1 orig
  assert.equal(paramTableRange.values[2][3], 0.5); // w1 model

  // Fallback formula grid has explicit standardization: x̂ = (x - μ) / σ
  const fallbackGridRange = createdSheet._ranges.find((r) => r.row === 31 && r.col === 0 && r.numCols === 3);
  assert.ok(fallbackGridRange);
  assert.equal(fallbackGridRange.values[1][0], "Raw Input (x_raw)");
  assert.equal(fallbackGridRange.values[2][0], "Training Mean (mu)");
  assert.equal(fallbackGridRange.values[3][0], "Training Scale (sigma)");
  assert.equal(fallbackGridRange.values[4][0], "Standardized Input (x_hat)");
  assert.equal(fallbackGridRange.values[5][0], "Model-Space Weight (w_model)");
  // Standardized input formula: =(B33-B34)/B35
  assert.equal(fallbackGridRange.values[4][1], "=(B33-B34)/B35");
  // Model-space weight links to column D of parameter table
  assert.equal(fallbackGridRange.values[5][1], "=D18");
});

test("literal text escaping protects formula-triggering characters in headers and labels", () => {
  const { context } = bootTaskPane();

  assert.equal(vm.runInContext("escapeLiteralText('=1+1')", context), "'=1+1");
  assert.equal(vm.runInContext("escapeLiteralText('+SUM(A1:A2)')", context), "'+SUM(A1:A2)");
  assert.equal(vm.runInContext("escapeLiteralText('-Negative')", context), "'-Negative");
  assert.equal(vm.runInContext("escapeLiteralText('@Risk')", context), "'@Risk");
  assert.equal(vm.runInContext("escapeLiteralText('RegularHeader')", context), "RegularHeader");
  assert.equal(vm.runInContext("escapeLiteralText(123.45)", context), 123.45);

  assert.equal(vm.runInContext('escapeExcelFormulaString(\'Quoted "Name"\')', context), 'Quoted ""Name""');
});

test("buildWhatIf disables manual what-if inputs and shows guidance note for models with >25 features", () => {
  const { context, elements } = bootTaskPane();
  const nFeats = 30;
  const names = Array.from({ length: nFeats }, (_, i) => `Feature_${i + 1}`);
  const weights = Array.from({ length: nFeats }, () => 0.1);

  const mockResult = {
    model_id: "m-30feat",
    n_samples: 50,
    split: { n_train: 40, n_test: 10, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: names,
    class_labels: { positive: "1", negative: "0" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    _activeThreshold: 0.5,
    coefficients: [{ name: "Intercept", coef: 0, odds_ratio: 1.0 }, ...names.map((n) => ({ name: n, coef: 0.1, odds_ratio: 1.1 }))],
    parameters: {
      model_id: "m-30feat",
      feature_names: names,
      weights_model_space: weights,
      intercept_model_space: 0,
      weights_original_units: weights,
      intercept_original_units: 0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    inference: {},
  };

  vm.runInContext("renderResults(" + JSON.stringify(mockResult) + ")", context);

  // Manual what-if inputs container displays limit note
  assert.ok(elements["whatif-inputs"].textContent.includes("Manual what-if inputs are limited to models with 25 or fewer features"));
  // Run button is disabled
  assert.equal(elements["whatif-btn"].disabled, true);
});

test("exportModelWeights omits horizontal formula example for models with >500 features while exporting full parameters", async () => {
  const nFeats = 505;
  const names = Array.from({ length: nFeats }, (_, i) => `Feature_${i + 1}`);
  const weights = Array.from({ length: nFeats }, () => 0.01);

  const xValues = [["F1", "F2"], [1.0, 2.0], [3.0, 4.0]];
  const yValues = [["Y"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$B$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$C$1:$C$3", yValues, 0, 2);

  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B3": xRange, "$A$1:$B$3": xRange, "C1:C3": yRange, "$C$1:$C$3": yRange } } },
    { Feats: makeNamedItem("Feats", xRange, "Workbook"), Target: makeNamedItem("Target", yRange, "Workbook") },
    "Sheet1"
  );

  const { context } = bootTaskPane({ excelContext });
  const input = await vm.runInContext('readTrainingData("Target", "Feats")', context);

  const mockResult = {
    model_id: "m-505feat",
    _trainedAt: "2026-10-14T04:00:00Z",
    _source: input.source,
    _activeThreshold: 0.5,
    _stale: false,
    n_samples: 10,
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    feature_names: names,
    class_labels: { positive: "1", negative: "0" },
    standardized: false,
    suggested_threshold: 0.5,
    threshold: { value: 0.5, source: "default" },
    coefficients: [{ name: "Intercept", coef: 0, odds_ratio: 1.0 }, ...names.map((n) => ({ name: n, coef: 0.01, odds_ratio: 1.0 }))],
    parameters: {
      model_id: "m-505feat",
      feature_names: names,
      weights_model_space: weights,
      intercept_model_space: 0,
      weights_original_units: weights,
      intercept_original_units: 0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    threshold_data: { y_true: [0, 1], prob: [0.1, 0.9] },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("exportModelWeights()", context);

  const createdSheet = excelContext.workbook.worksheets.items.find((s) => s.name && s.name.startsWith("Model Weights"));
  assert.ok(createdSheet);

  // Check that full parameters were written in chunks (507 total rows: 1 header + 1 intercept + 505 features)
  const chunk1 = createdSheet._ranges.find((r) => r.row === 14 && r.col === 0 && r.numCols === 7);
  assert.equal(chunk1.numRows, 250);
  const chunk2 = createdSheet._ranges.find((r) => r.row === 264 && r.col === 0 && r.numCols === 7);
  assert.equal(chunk2.numRows, 250);
  const chunk3 = createdSheet._ranges.find((r) => r.row === 514 && r.col === 0 && r.numCols === 7);
  assert.equal(chunk3.numRows, 7); // 507 - 500 = 7 rows

  // Recalculable formula example is omitted and note written
  const noteRange = createdSheet._ranges.find((r) => r.values && r.values[0] && r.values[0][0] === "Live Recalculable Formula Example");
  assert.ok(noteRange);
  assert.ok(noteRange.values[0][1].includes("omitted for models with > 500 features"));
});

test("readNewFeatureData rejects delimiter collisions in feature headers", async () => {
  // Delimiter collision: ["a::b", "c"].join("::") === "a::b::c" and ["a", "b::c"].join("::") === "a::b::c"
  const expectedFeatures = ["a::b", "c"];
  const receivedValues = [
    ["a", "b::c"], // Collides under join("::") but different features
    [1.0, 2.0],
  ];
  const newXRange = makeRange("Sheet1", "$A$1:$B$2", receivedValues, 0, 0);
  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B2": newXRange } } },
    {},
    "Sheet1"
  );
  const { context } = bootTaskPane({ excelContext });

  await assert.rejects(
    async () => {
      await vm.runInContext(
        `readNewFeatureData("A1:B2", true, ${JSON.stringify(expectedFeatures)})`,
        context
      );
    },
    /Feature header mismatch at column 1: expected "a::b", received "a"/
  );
});

test("readNewFeatureData rejects reordered feature headers identifying first differing column", async () => {
  const expectedFeatures = ["FeatureA", "FeatureB"];
  const receivedValues = [
    ["FeatureB", "FeatureA"],
    [1.0, 2.0],
  ];
  const newXRange = makeRange("Sheet1", "$A$1:$B$2", receivedValues, 0, 0);
  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B2": newXRange } } },
    {},
    "Sheet1"
  );
  const { context } = bootTaskPane({ excelContext });

  await assert.rejects(
    async () => {
      await vm.runInContext(
        `readNewFeatureData("A1:B2", true, ${JSON.stringify(expectedFeatures)})`,
        context
      );
    },
    /Feature header mismatch at column 1: expected "FeatureA", received "FeatureB"/
  );
});

test("readNewFeatureData rejects feature header count mismatch", async () => {
  const expectedFeatures = ["FeatureA", "FeatureB", "FeatureC"];
  const receivedValues = [
    ["FeatureA", "FeatureB"],
    [1.0, 2.0],
  ];
  const newXRange = makeRange("Sheet1", "$A$1:$B$2", receivedValues, 0, 0);
  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B2": newXRange } } },
    {},
    "Sheet1"
  );
  const { context } = bootTaskPane({ excelContext });

  await assert.rejects(
    async () => {
      await vm.runInContext(
        `readNewFeatureData("A1:B2", true, ${JSON.stringify(expectedFeatures)})`,
        context
      );
    },
    /New rows must have 3 features, got 2/
  );
});

test("reportMetadataRows bounds 12,288-feature metadata text cells well within 32,767 character limit", () => {
  const { context } = bootTaskPane();
  const nFeatures = 12288;
  const featureNames = Array.from({ length: nFeatures }, (_, i) => `Feature_${i + 1}`);
  const weights = Array.from({ length: nFeatures }, () => 0.01);

  const mockResult = {
    model_id: "mod-12k",
    feature_names: featureNames,
    coefficients: featureNames.map((name, i) => ({ name, coef: weights[i], odds_ratio: 1.01 })),
    parameters: {
      weights_model_space: weights,
      intercept_model_space: 0,
      weights_original_units: weights,
      intercept_original_units: 0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    class_labels: { positive: "1", negative: "0" },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1 },
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
    _source: {
      x: { kind: "address", absoluteAddress: "Sheet1!$A$1:$AAA$10" },
      y: { kind: "address", absoluteAddress: "Sheet1!$B$1:$B$10" },
    },
    split: { n_train: 8, n_test: 2, actual_train_percent: 80, actual_test_percent: 20 },
    n_samples: 10,
    training_settings: {},
    diagnostics: {},
  };

  const rows = vm.runInContext(`reportMetadataRows(${JSON.stringify(mockResult)})`, context);
  assert.ok(rows.length > 0);

  // Every single cell must be <= 32,000 characters
  for (const [label, val] of rows) {
    assert.ok(String(label).length <= 32000, `Label "${label}" exceeds 32,000 chars`);
    assert.ok(String(val).length <= 32000, `Value for "${label}" (${String(val).length} chars) exceeds 32,000 chars`);
  }

  // Features row contains bounded preview with total count
  const featRow = rows.find(([label]) => label === "Features");
  assert.ok(featRow);
  assert.ok(featRow[1].includes("Feature_1"));
  assert.ok(featRow[1].includes("... and 12278 more (12288 total; see Parameters table"));
  assert.ok(featRow[1].length < 500, `Feature preview string is ${featRow[1].length} chars, expected < 500`);
});

test("reportMetadataRows splits or truncates long warning lists exceeding cell limits", () => {
  const { context } = bootTaskPane();
  const longWarning = "Warning message with important information. ".repeat(1000); // ~44,000 chars

  const mockResult = {
    model_id: "mod-warn",
    feature_names: ["x1", "x2"],
    class_labels: { positive: "1", negative: "0" },
    metrics: {},
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
    training_warnings: [longWarning],
    split: { n_train: 10, n_test: 5, actual_train_percent: 67, actual_test_percent: 33 },
    n_samples: 15,
  };

  const rows = vm.runInContext(`reportMetadataRows(${JSON.stringify(mockResult)})`, context);
  for (const [label, val] of rows) {
    assert.ok(String(val).length <= 32000, `Cell "${label}" length ${String(val).length} exceeds 32,000 limit`);
  }
  const warnRows = rows.filter(([label]) => label.startsWith("Training Warnings"));
  assert.ok(warnRows.length >= 2, "Long warnings should be split across multiple rows");
});

test("pending scoring response is rejected when Use selection changes range before response arrives", async () => {
  const newX1 = makeRange("Sheet1", "$A$1:$B$3", [["F1", "F2"], [1.0, 2.0], [3.0, 4.0]], 0, 0);
  const newX2 = makeRange("Sheet1", "$C$1:$D$3", [["F1", "F2"], [5.0, 6.0], [7.0, 8.0]], 0, 2);

  const excelContext = createMockExcelContext(
    { Sheet1: { id: "s1", ranges: { "A1:B3": newX1, "C1:D3": newX2 } } },
    {},
    "Sheet1"
  );

  let resolveFetch;
  const pendingFetch = new Promise((resolve) => {
    resolveFetch = resolve;
  });

  const { context, elements } = bootTaskPane({
    excelContext,
    fetchMock: async () => pendingFetch,
  });

  // Setup active model
  vm.runInContext(
    `LAST_RESULT = {
      model_id: "m1",
      feature_names: ["F1", "F2"],
      class_labels: { positive: "1", negative: "0" },
      _activeThreshold: 0.5,
      _stale: false,
    };
    setModelActionsEnabled(true);`,
    context
  );

  elements["new-x-range"].value = "Sheet1!A1:B3";
  elements["new-has-header"].checked = true;

  // 1. Start scoring A1:B3 (held pending in fetch)
  const scorePromise = vm.runInContext("scoreNewRows()", context);

  // 2. While scoring is pending, user clicks "Use selection" which changes range to C1:D3
  excelContext.setSelectedRange("Sheet1!$C$1:$D$3");
  await vm.runInContext('useSelection("new-x-range")', context);
  assert.equal(elements["new-x-range"].value, "Sheet1!$C$1:$D$3");

  // 3. Resolve the earlier scoring response
  resolveFetch({
    ok: true,
    status: 200,
    json: async () => ({
      status: "ok",
      results: [{ prob: 0.8, pred: 1 }, { prob: 0.2, pred: 0 }],
      threshold: 0.5,
      class_labels: { positive: "1", negative: "0" },
    }),
  });

  await scorePromise;

  // Stale response must be rejected: LAST_NEW_PREDICTION remains null and export remains disabled
  const lastNewPred = vm.runInContext("LAST_NEW_PREDICTION", context);
  assert.equal(lastNewPred, null);
  assert.equal(elements["export-new-btn"].disabled, true);
});

test("pending selection read does not overwrite intervening typed input in New X", async () => {
  let resolveExcel;
  const excelBlocked = new Promise((resolve) => {
    resolveExcel = resolve;
  });

  const mockWorkbook = {
    getSelectedRange() {
      return {
        address: "Sheet1!$Z$100:$AA$200",
        load() {},
      };
    },
  };

  const customContext = {
    workbook: mockWorkbook,
    sync: async () => excelBlocked,
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });

  elements["new-x-range"].value = "OriginalRange!A1:B5";

  // 1. User clicks "Use selection" (selection read starts and blocks on Excel sync)
  const selectionPromise = vm.runInContext('useSelection("new-x-range")', context);

  // 2. Before Excel returns, user manually types a new range into the input
  elements["new-x-range"].value = "UserTypedSheet!X1:Y20";
  elements["new-x-range"].trigger("input");

  // 3. Excel selection read finishes late
  resolveExcel();
  await selectionPromise;

  // The typed input must be preserved, not overwritten by stale selection
  assert.equal(elements["new-x-range"].value, "UserTypedSheet!X1:Y20");
});

test("out-of-order selection reads preserve the newest selection entry", async () => {
  let resolveFirst;
  let resolveSecond;
  const firstPromise = new Promise((res) => { resolveFirst = res; });
  const secondPromise = new Promise((res) => { resolveSecond = res; });

  let callCount = 0;
  const mockWorkbook = {
    getSelectedRange() {
      callCount++;
      if (callCount === 1) {
        return { address: "Sheet1!$A$1:$B$10", load() {} };
      }
      return { address: "Sheet2!$C$1:$D$20", load() {} };
    },
  };

  const customContext = {
    workbook: mockWorkbook,
    sync: async () => {
      if (callCount === 1) return firstPromise;
      return secondPromise;
    },
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });

  // Start selection 1 (returns Sheet1!$A$1:$B$10, but hangs)
  const sel1 = vm.runInContext('useSelection("new-x-range")', context);

  // Start selection 2 (returns Sheet2!$C$1:$D$20)
  const sel2 = vm.runInContext('useSelection("new-x-range")', context);

  // Selection 2 completes first
  resolveSecond();
  await sel2;
  assert.equal(elements["new-x-range"].value, "Sheet2!$C$1:$D$20");

  // Selection 1 completes second (out of order)
  resolveFirst();
  await sel1;

  // Newest entry (Selection 2) must be preserved
  assert.equal(elements["new-x-range"].value, "Sheet2!$C$1:$D$20");
});

test("new-x-range edits preserve active trained model and weights/report buttons", () => {
  const { context, elements } = bootTaskPane();

  // Setup active model
  vm.runInContext(
    `LAST_RESULT = {
      model_id: "m_active",
      feature_names: ["F1"],
      class_labels: { positive: "1", negative: "0" },
      _activeThreshold: 0.5,
      _stale: false,
    };
    setModelActionsEnabled(true);`,
    context
  );

  assert.equal(elements["export-weights-btn"].disabled, false);
  assert.equal(elements["writeback-btn"].disabled, false);

  // Edit new-x-range
  elements["new-x-range"].value = "DifferentSheet!A1:B10";
  elements["new-x-range"].trigger("input");

  // Trained model must NOT be marked stale
  const lastResult = vm.runInContext("LAST_RESULT", context);
  assert.equal(lastResult._stale, false);
  assert.equal(elements["export-weights-btn"].disabled, false);
  assert.equal(elements["writeback-btn"].disabled, false);

  // Toggle new-has-header checkbox
  elements["new-has-header"].checked = false;
  elements["new-has-header"].trigger("change");

  // Still active!
  assert.equal(lastResult._stale, false);
  assert.equal(elements["export-weights-btn"].disabled, false);
});

test("obsolete selection read failure does not invalidate newer prediction or show error", async () => {
  let rejectExcel;
  const excelBlocked = new Promise((_, rej) => { rejectExcel = rej; });

  const mockWorkbook = {
    getSelectedRange() {
      return {
        address: "Sheet1!$A$1:$B$5",
        load() {},
      };
    },
  };

  const customContext = {
    workbook: mockWorkbook,
    sync: async () => excelBlocked,
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });

  // 1. User clicks "Use selection" (starts read and blocks)
  const selectionPromise = vm.runInContext('useSelection("new-x-range")', context);

  // 2. User types a new range and a valid new prediction is completed
  elements["new-x-range"].value = "Sheet2!$C$1:$D$10";
  elements["new-x-range"].trigger("input");

  const validPrediction = {
    model_id: "m_1",
    revision: 2,
    threshold: 0.5,
    results: [{ prob: 0.8, pred: 1, label: "1" }],
  };
  vm.runInContext("LAST_NEW_PREDICTION = " + JSON.stringify(validPrediction), context);
  elements["export-new-btn"].disabled = false;

  // 3. Old selection read fails late
  rejectExcel(new Error("Host connection lost"));
  await selectionPromise;

  // 4. Assert: new prediction preserved, range preserved, export button still enabled, no error toast shown
  const pred = vm.runInContext("LAST_NEW_PREDICTION", context);
  assert.ok(pred, "Valid prediction should not be cleared by obsolete failure");
  assert.equal(pred.model_id, "m_1");
  assert.equal(elements["new-x-range"].value, "Sheet2!$C$1:$D$10");
  assert.equal(elements["export-new-btn"].disabled, false);
  assert.equal(elements["error-toast"].textContent, "");
});

test("obsolete selection failure does not overwrite newer successful selection entry", async () => {
  let rejectFirst;
  let resolveSecond;
  const firstPromise = new Promise((_, rej) => { rejectFirst = rej; });
  const secondPromise = new Promise((res) => { resolveSecond = res; });

  let callCount = 0;
  const mockWorkbook = {
    getSelectedRange() {
      callCount++;
      if (callCount === 1) {
        return { address: "Sheet1!$A$1:$B$10", load() {} };
      }
      return { address: "Sheet2!$C$1:$D$20", load() {} };
    },
  };

  const customContext = {
    workbook: mockWorkbook,
    sync: async () => {
      if (callCount === 1) return firstPromise;
      return secondPromise;
    },
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });

  const sel1 = vm.runInContext('useSelection("new-x-range")', context);
  const sel2 = vm.runInContext('useSelection("new-x-range")', context);

  resolveSecond();
  await sel2;
  assert.equal(elements["new-x-range"].value, "Sheet2!$C$1:$D$20");

  rejectFirst(new Error("First read failed"));
  await sel1;

  assert.equal(elements["new-x-range"].value, "Sheet2!$C$1:$D$20");
  assert.equal(elements["error-toast"].textContent, "");
});

test("active selection failure displays error and leaves prediction export unavailable", async () => {
  const customContext = {
    workbook: {
      getSelectedRange() {
        return { address: "Sheet1!A1", load() {} };
      },
    },
    sync: async () => { throw new Error("Sync failed"); },
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });
  await vm.runInContext('useSelection("new-x-range")', context);

  assert.ok(elements["error-toast"].textContent.includes("Could not read the selected cells: Sync failed"));
  assert.equal(elements["export-new-btn"].disabled, true);
});

test("obsolete training-range selection failure does not disturb active trained model or display error", async () => {
  let rejectExcel;
  const excelBlocked = new Promise((_, rej) => { rejectExcel = rej; });

  const customContext = {
    workbook: {
      getSelectedRange() {
        return { address: "Sheet1!A1:B10", load() {} };
      },
    },
    sync: async () => excelBlocked,
  };

  const { context, elements } = bootTaskPane({ excelContext: customContext });

  // 1. User clicks "Use selection" on x-range
  const selectionPromise = vm.runInContext('useSelection("x-range")', context);

  // 2. In the meantime, user selects another range or types and successfully fits a model
  const mockResult = {
    model_id: "m_train_active",
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
  };
  vm.runInContext('SELECTION_REVISIONS["x-range"]++;', context);
  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  // 3. First selection read fails late
  rejectExcel(new Error("Old read failed"));
  await selectionPromise;

  // Active model must not be marked stale and error toast must not be shown
  const activeModel = vm.runInContext("LAST_RESULT", context);
  assert.equal(activeModel._stale, false);
  assert.equal(elements["error-toast"].textContent, "");
});

test("writePredictions aborts if settings change during sheet creation", async () => {
  const xValues = [["F1"], [1.0], [2.0]];
  const yValues = [["Y"], [0], [1]];
  const xRange = makeRange("Sheet1", "$A$1:$A$3", xValues, 0, 0);
  const yRange = makeRange("Sheet1", "$B$1:$B$3", yValues, 0, 1);

  let sheetAddCount = 0;
  const excelContext = createMockExcelContext(
    {
      Sheet1: {
        ranges: {
          "A1:A3": xRange,
          "$A$1:$A$3": xRange,
          "B1:B3": yRange,
          "$B$1:$B$3": yRange,
        },
      },
    },
    {},
    "Sheet1"
  );

  const { context, elements } = bootTaskPane({ excelContext });
  const input = await vm.runInContext('readTrainingData("Sheet1!$B$1:$B$3", "Sheet1!$A$1:$A$3")', context);

  const origAdd = excelContext.workbook.worksheets.add;
  excelContext.workbook.worksheets.add = function (name) {
    sheetAddCount++;
    // Simulate user editing training settings during sheet creation
    vm.runInContext("TRAIN_REVISION++; CURRENT_REQUEST_ID++;", context);
    return origAdd.call(this, name);
  };

  const mockResult = {
    model_id: "m_test_abort",
    _source: input.source,
    _activeThreshold: 0.5,
    _stale: false,
    feature_names: ["F1"],
    class_labels: { positive: "1", negative: "0" },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1 },
    threshold: { value: 0.5, source: "test" },
    predictions: { prob: [0.1, 0.9], partition: ["train", "test"] },
    coefficients: [{ name: "F1", coef: 1.0, odds_ratio: 2.7 }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("writePredictions()", context);

  assert.equal(sheetAddCount, 1);
  assert.ok(elements["error-toast"].textContent.includes("Settings or model changed during sheet creation. Export cancelled."));
});

test("exportModelWeights cancels and does not mark new model stale if old source check fails late", async () => {
  let resolveSourceCheck;
  const sourceCheckPromise = new Promise((resolve) => { resolveSourceCheck = resolve; });

  const { context } = bootTaskPane();

  const oldModel = {
    model_id: "m_old",
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
  };
  const newModel = {
    model_id: "m_new",
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
  };

  context.sourceCheckPromise = sourceCheckPromise;
  vm.runInContext("LAST_RESULT = " + JSON.stringify(oldModel), context);
  vm.runInContext("sourceStillMatches = async () => sourceCheckPromise", context);

  // 1. Export starts with oldModel
  const exportPromise = vm.runInContext("exportModelWeights()", context);

  // 2. User trains new model while source check is pending
  vm.runInContext("LAST_RESULT = " + JSON.stringify(newModel) + "; TRAIN_REVISION++;", context);

  // 3. Old source check finishes with false
  resolveSourceCheck(false);
  await exportPromise;

  // The NEW model must NOT be marked stale!
  const currentModel = vm.runInContext("LAST_RESULT", context);
  assert.equal(currentModel.model_id, "m_new");
  assert.equal(currentModel._stale, false);
});

test("exportNewPredictions cancels and does not clear new prediction if old source check fails late", async () => {
  let resolveSourceCheck;
  const sourceCheckPromise = new Promise((resolve) => { resolveSourceCheck = resolve; });

  const { context } = bootTaskPane();

  const model = {
    model_id: "m_1",
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
  };
  const oldPred = {
    model_id: "m_1",
    revision: 1,
    threshold: 0.5,
    _source: { kind: "address" },
    class_labels: { positive: "1", negative: "0" },
    results: [{ prob: 0.8, pred: 1, label: "1" }],
  };
  const newPred = {
    model_id: "m_1",
    revision: 2,
    threshold: 0.5,
    _source: { kind: "address" },
    class_labels: { positive: "1", negative: "0" },
    results: [{ prob: 0.2, pred: 0, label: "0" }],
  };

  context.sourceCheckPromise = sourceCheckPromise;
  vm.runInContext("LAST_RESULT = " + JSON.stringify(model), context);
  vm.runInContext("LAST_NEW_PREDICTION = " + JSON.stringify(oldPred) + "; NEW_PRED_REVISION = 1;", context);
  vm.runInContext("newSourceStillMatches = async () => sourceCheckPromise", context);

  // 1. Export starts with oldPred
  const exportPromise = vm.runInContext("exportNewPredictions()", context);

  // 2. User scores newer predictions while source check is pending
  vm.runInContext("LAST_NEW_PREDICTION = " + JSON.stringify(newPred) + "; NEW_PRED_REVISION = 2;", context);

  // 3. Old source check finishes with false
  resolveSourceCheck(false);
  await exportPromise;

  // The NEW prediction must NOT be cleared!
  const currentPred = vm.runInContext("LAST_NEW_PREDICTION", context);
  assert.ok(currentPred);
  assert.equal(currentPred.revision, 2);
});

test("writeTableChunks bounds queued batches to 250 rows and synchronizes each chunk", async () => {
  const syncBatches = [];
  let currentBatchRanges = [];

  const mockSheet = {
    getRangeByIndexes(row, col, numRows, numCols) {
      const r = { row, col, numRows, numCols, values: null, format: { font: {} } };
      currentBatchRanges.push(r);
      return r;
    },
  };

  const mockContext = {
    sync: async () => {
      syncBatches.push([...currentBatchRanges]);
      currentBatchRanges = [];
    },
  };

  const totalRows = 600;
  const rows = Array.from({ length: totalRows }, (_, i) => [`Row_${i + 1}`, i * 1.5]);

  const { context } = bootTaskPane();
  context.mockContext = mockContext;
  context.mockSheet = mockSheet;
  context.rows = rows;
  await vm.runInContext(
    `writeTableChunks(mockContext, mockSheet, 0, 0, rows, { chunkSize: 250 })`,
    context
  );

  // 600 rows with chunkSize 250 requires exactly 3 syncs: 250, 250, 100
  assert.equal(syncBatches.length, 3);
  assert.equal(syncBatches[0][0].numRows, 250);
  assert.equal(syncBatches[1][0].numRows, 250);
  assert.equal(syncBatches[2][0].numRows, 100);

  // All 600 rows accounted for without gaps or overlaps
  assert.equal(syncBatches[0][0].values[0][0], "Row_1");
  assert.equal(syncBatches[0][0].values[249][0], "Row_250");
  assert.equal(syncBatches[1][0].values[0][0], "Row_251");
  assert.equal(syncBatches[1][0].values[249][0], "Row_500");
  assert.equal(syncBatches[2][0].values[0][0], "Row_501");
  assert.equal(syncBatches[2][0].values[99][0], "Row_600");
});

test("writeTableChunks aborts mid-export when token invalidated", async () => {
  let syncCount = 0;
  const createdSheet = {
    name: "LR Report",
    _a1Values: null,
    getRange(addr) {
      if (addr === "A1") {
        return {
          set values(val) { createdSheet._a1Values = val; },
          get values() { return createdSheet._a1Values; },
        };
      }
      return { values: null };
    },
    getRangeByIndexes(row, col, numRows, numCols) {
      return { row, col, numRows, numCols, values: null, format: { font: {} } };
    },
    getUsedRange() { return { format: { autofitColumns() {} } }; },
    freezePanes: { freezeRows() {} },
    activate() {},
  };

  const mockExcelContext = {
    sync: async () => {
      syncCount++;
      if (syncCount === 1) {
        // Invalidate token after chunk 1 is committed
        vm.runInContext("LAST_RESULT._stale = true;", context);
      }
    },
  };

  const { context } = bootTaskPane();
  vm.runInContext("LAST_RESULT = { model_id: 'm1', _stale: false, _activeThreshold: 0.5 };", context);
  const token = vm.runInContext("createExportToken('report', LAST_RESULT)", context);
  const rows = Array.from({ length: 500 }, (_, i) => [`R_${i}`, i]);

  context.mockExcelContext = mockExcelContext;
  context.createdSheet = createdSheet;
  context.rows = rows;
  context.token = token;

  let thrown = null;
  try {
    await vm.runInContext(
      `writeTableChunks(mockExcelContext, createdSheet, 0, 0, rows, { chunkSize: 250, token })`,
      context
    );
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown);
  assert.ok(thrown.message.includes("Export cancelled"));
  // Sync was called for chunk 1, but stopped before chunk 2
  assert.equal(syncCount, 1);
});

test("renderParametersTable provides pagination and search across 101 features preserving true feature indices", () => {
  const { context, elements, paramsTbody } = bootTaskPane();

  const nFeatures = 101;
  const featureNames = Array.from({ length: nFeatures }, (_, i) => `Feature_${i + 1}`);
  const weightsModel = Array.from({ length: nFeatures }, (_, i) => (i + 1) * 0.1);
  const weightsOrig = Array.from({ length: nFeatures }, (_, i) => (i + 1) * 0.05);

  const mockResult = {
    model_id: "mod-101",
    feature_names: featureNames,
    coefficients: featureNames.map((name, i) => ({ name, coef: weightsModel[i], odds_ratio: 1.1 })),
    parameters: {
      weights_model_space: weightsModel,
      intercept_model_space: 0.42,
      weights_original_units: weightsOrig,
      intercept_original_units: 0.21,
      standardized: true,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    class_labels: { positive: "1", negative: "0" },
    metrics: { accuracy: 1, precision: 1, recall: 1, f1: 1, auc: 1 },
    threshold: { value: 0.5, source: "test" },
    _activeThreshold: 0.5,
    split: { n_train: 10, n_test: 5, actual_train_percent: 67, actual_test_percent: 33 },
    n_samples: 15,
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);

  // Render table
  vm.runInContext("renderParametersTable(LAST_RESULT)", context);

  // --- Page 1 ---
  // Page 1 has 1 intercept row + 50 feature rows = 51 rows total
  assert.equal(paramsTbody.children.length, 51);
  assert.equal(elements["params-page-info"].textContent, "Page 1 of 3 (101 features)");
  assert.equal(elements["params-prev-btn"].disabled, true);
  assert.equal(elements["params-next-btn"].disabled, false);

  // First row is intercept
  assert.equal(paramsTbody.children[0].children[0].textContent, "b");
  assert.equal(paramsTbody.children[0].children[1].textContent, "Intercept (Bias)");
  // Second row is w1 (Feature_1)
  assert.equal(paramsTbody.children[1].children[0].textContent, "w1");
  assert.equal(paramsTbody.children[1].children[1].textContent, "Feature_1");
  // Last row of Page 1 is w50 (Feature_50)
  assert.equal(paramsTbody.children[50].children[0].textContent, "w50");
  assert.equal(paramsTbody.children[50].children[1].textContent, "Feature_50");

  // --- Navigate to Page 2 ---
  elements["params-next-btn"].trigger("click");
  assert.equal(paramsTbody.children.length, 50); // w51..w100 (no intercept on page 2)
  assert.equal(elements["params-page-info"].textContent, "Page 2 of 3 (101 features)");
  assert.equal(elements["params-prev-btn"].disabled, false);
  assert.equal(elements["params-next-btn"].disabled, false);
  // First row on page 2 preserves true index w51!
  assert.equal(paramsTbody.children[0].children[0].textContent, "w51");
  assert.equal(paramsTbody.children[0].children[1].textContent, "Feature_51");
  // Last row on page 2 is w100
  assert.equal(paramsTbody.children[49].children[0].textContent, "w100");
  assert.equal(paramsTbody.children[49].children[1].textContent, "Feature_100");

  // --- Navigate to Page 3 ---
  elements["params-next-btn"].trigger("click");
  assert.equal(paramsTbody.children.length, 1); // w101
  assert.equal(elements["params-page-info"].textContent, "Page 3 of 3 (101 features)");
  assert.equal(elements["params-prev-btn"].disabled, false);
  assert.equal(elements["params-next-btn"].disabled, true);
  assert.equal(paramsTbody.children[0].children[0].textContent, "w101");
  assert.equal(paramsTbody.children[0].children[1].textContent, "Feature_101");

  // --- Search filter ---
  elements["params-search"].value = "Feature_77";
  elements["params-search"].trigger("input");

  // Filtered table shows 1 row with true index w77!
  assert.equal(paramsTbody.children.length, 1);
  assert.equal(paramsTbody.children[0].children[0].textContent, "w77");
  assert.equal(paramsTbody.children[0].children[1].textContent, "Feature_77");
  assert.equal(elements["params-page-info"].textContent, "Page 1 of 1 (1 features)");

  // Clear search
  elements["params-search"].value = "";
  elements["params-search"].trigger("input");
  assert.equal(paramsTbody.children.length, 51);
  assert.equal(elements["params-page-info"].textContent, "Page 1 of 3 (101 features)");
});

// ============================================================================
// REGRESSIONS: REPAIRS 2, 3, AND 4
// ============================================================================

test("exportModelWeights preserves 32,500-character feature name completely intact without truncation", async () => {
  const longName = "Feature_" + "X".repeat(32488) + "_END";
  assert.equal(longName.length, 32500);

  const excelContext = createMockExcelContext();
  const { context } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_long_name",
    feature_names: [longName],
    class_labels: { positive: "Yes", negative: "No" },
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [1.234567],
      intercept_model_space: 0.5,
      weights_original_units: [1.234567],
      intercept_original_units: 0.5,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "Yes", negative: "No" },
    },
    coefficients: [{ name: longName, coef: 1.234567, odds_ratio: 3.44 }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  await vm.runInContext("exportModelWeights()", context);

  const createdSheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("Model Weights"));
  assert.ok(createdSheet, "Model Weights sheet was created");

  // Find the parameter table row containing longName
  const paramRange = createdSheet._ranges.find((r) => r.values && r.values.some((row) => row.includes(longName)));
  assert.ok(paramRange, "Found range containing exact 32,500-char feature name");
  const row = paramRange.values.find((r) => r.includes(longName));
  const nameCell = row.find((c) => c === longName);
  assert.equal(nameCell.length, 32500);
  assert.equal(nameCell, longName);
});

test("writeTableChunks and prepareIdentityText reject text exceeding 32,767 chars with explicit error", async () => {
  const { context } = bootTaskPane();

  // 1. prepareIdentityText throws explicit limit error
  assert.throws(
    () => vm.runInContext('prepareIdentityText("a".repeat(32768))', context),
    /Identity text exceeds Excel cell limit of 32767 characters/
  );

  // 2. writeTableChunks throws explicit limit error if oversized string is passed
  const mockSheet = { getRangeByIndexes() { return { values: null, format: { font: {} } }; } };
  const mockContext = { sync: async () => {} };
  context.mockSheet = mockSheet;
  context.mockContext = mockContext;
  context.oversizedRows = [["Valid", "b".repeat(32768)]];

  await assert.rejects(
    async () => vm.runInContext("writeTableChunks(mockContext, mockSheet, 0, 0, oversizedRows)", context),
    /Cell content exceeds Excel's 32767 character limit \(32768 characters\)/
  );
});

test("exportModelWeights preserves literal text escaping for formula-triggering characters and quotes", async () => {
  const trickyNames = ["=SUM(A1:B2)", "+Delta", "-10%", "@Home", '"DoubleQuoted"'];
  const excelContext = createMockExcelContext();
  const { context } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "=MOD-1",
    feature_names: trickyNames,
    class_labels: { positive: "+Positive", negative: "-Negative" },
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [0.1, 0.2, 0.3, 0.4, 0.5],
      intercept_model_space: 0.0,
      weights_original_units: [0.1, 0.2, 0.3, 0.4, 0.5],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "+Positive", negative: "-Negative" },
    },
    coefficients: trickyNames.map((name, i) => ({ name, coef: 0.1 * (i + 1), odds_ratio: 1.1 })),
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  await vm.runInContext("exportModelWeights()", context);

  const sheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("Model Weights"));
  assert.ok(sheet);

  // In parameter table, feature names with =, +, -, @ are escaped with leading apostrophe
  const paramRange = sheet._ranges.find((r) => r.values && r.values.some((row) => row[0] === "w1"));
  assert.ok(paramRange);
  const w1Row = paramRange.values.find((r) => r[0] === "w1");
  const w2Row = paramRange.values.find((r) => r[0] === "w2");
  const w3Row = paramRange.values.find((r) => r[0] === "w3");
  const w4Row = paramRange.values.find((r) => r[0] === "w4");
  const w5Row = paramRange.values.find((r) => r[0] === "w5");
  assert.equal(w1Row[1], "'=SUM(A1:B2)");
  assert.equal(w2Row[1], "'+Delta");
  assert.equal(w3Row[1], "'-10%");
  assert.equal(w4Row[1], "'@Home");
  assert.equal(w5Row[1], '"DoubleQuoted"');
});

test("estimateUtf8Bytes computes exact UTF-8 byte lengths including Unicode and surrogate pairs", () => {
  const { context } = bootTaskPane();

  // ASCII: 1 byte per char
  assert.equal(vm.runInContext('estimateUtf8Bytes("hello")', context), 5);
  // 2-byte UTF-8: Greek/Cyrillic (e.g. "αβγδε" -> 5 chars * 2 = 10 bytes)
  assert.equal(vm.runInContext('estimateUtf8Bytes("αβγδε")', context), 10);
  // 3-byte UTF-8: CJK / Chinese (e.g. "中文测试" -> 4 chars * 3 = 12 bytes)
  assert.equal(vm.runInContext('estimateUtf8Bytes("中文测试")', context), 12);
  // 4-byte UTF-8: Emoji / Surrogate pair (e.g. "😀" has .length == 2 in JS, but 4 UTF-8 bytes)
  assert.equal(vm.runInContext('estimateUtf8Bytes("😀")', context), 4);
  assert.equal(vm.runInContext('estimateUtf8Bytes("😀🚀🎉")', context), 12);
});

test("writeTableChunks bounds batch size by bytes (1 MiB budget) dividing long-text rows across multiple syncs", async () => {
  const syncBatches = [];
  const mockSheet = {
    getRangeByIndexes(row, col, numRows, numCols) {
      const r = { row, col, numRows, numCols, values: null, format: { font: {} } };
      return r;
    },
  };
  const mockContext = {
    sync: async () => {
      syncBatches.push(true);
    },
  };

  // 250 rows, each with 5 columns of 1500 chars = 7500 chars per row.
  // 250 * 7500 chars ≈ 1.875 MB content.
  // With 1 MiB byte budget, 250 rows cannot fit in 1 batch.
  const rowCount = 250;
  const longStr = "x".repeat(1500);
  const rows = Array.from({ length: rowCount }, (_, i) => [
    `Row_${i}`,
    longStr,
    longStr,
    longStr,
    longStr,
  ]);

  const { context } = bootTaskPane();
  context.mockSheet = mockSheet;
  context.mockContext = mockContext;
  context.rows = rows;

  await vm.runInContext(
    "writeTableChunks(mockContext, mockSheet, 0, 0, rows)",
    context
  );

  // Must be divided into multiple smaller batches (at least 2 syncs for ~1.875 MB with 1 MiB budget)
  assert.ok(syncBatches.length >= 2, `Expected at least 2 sync batches, got ${syncBatches.length}`);
});

test("writeTableChunks bounds batch size by cells (10,000 max) even when row count is well under 250", async () => {
  const syncBatchSizes = [];
  const mockSheet = {
    getRangeByIndexes(row, col, numRows, numCols) {
      const r = { row, col, numRows, numCols, values: null, format: { font: {} } };
      return r;
    },
  };
  let currentChunkCells = 0;
  const mockContext = {
    sync: async () => {
      syncBatchSizes.push(currentChunkCells);
      currentChunkCells = 0;
    },
  };

  // 100 rows, each with 150 short cells = 15,000 cells total.
  // 100 rows <= 250 rows, but 15,000 cells > 10,000 cells max.
  const cols = 150;
  const rows = Array.from({ length: 100 }, (_, r) =>
    Array.from({ length: cols }, (_, c) => `r${r}c${c}`)
  );

  const { context } = bootTaskPane();
  context.mockSheet = mockSheet;
  context.mockContext = mockContext;
  context.rows = rows;

  await vm.runInContext(
    "writeTableChunks(mockContext, mockSheet, 0, 0, rows)",
    context
  );

  // Must be split across multiple syncs because 15,000 cells > 10,000 max cells per batch
  assert.ok(syncBatchSizes.length >= 2, `Expected at least 2 sync batches, got ${syncBatchSizes.length}`);
});

test("writeTableChunks segments wide row exceeding cell budget into column chunks without corruption", async () => {
  const syncSegments = [];
  const mockSheet = {
    getRangeByIndexes(row, col, numRows, numCols) {
      const r = { row, col, numRows, numCols, values: null, format: { font: {} } };
      return r;
    },
  };
  const mockContext = {
    sync: async () => {
      syncSegments.push(true);
    },
  };

  // Single wide row with 15,000 columns (exceeds 10,000 maxCells)
  const wideRow = [Array.from({ length: 15000 }, (_, i) => `Col_${i}`)];

  const { context } = bootTaskPane();
  context.mockSheet = mockSheet;
  context.mockContext = mockContext;
  context.wideRow = wideRow;

  await vm.runInContext(
    "writeTableChunks(mockContext, mockSheet, 0, 0, wideRow)",
    context
  );

  // Must be segmented into at least 2 batches
  assert.ok(syncSegments.length >= 2, `Expected at least 2 segments for 15,000-cell row, got ${syncSegments.length}`);
});

test("writePredictions handles invalidation during final sync by writing stale marker to A1 and surfacing error", async () => {
  const excelContext = createMockExcelContext();
  const { context, elements } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_final_sync",
    feature_names: ["X1"],
    class_labels: { positive: "1", negative: "0" },
    _source: { x: { kind: "address" }, y: { kind: "address" }, firstDataRow: 2 },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      weights_original_units: [1.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [{ name: "X1", coef: 1.0, odds_ratio: 2.7 }],
    predictions: { prob: [0.8], partition: ["test"] },
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  const origAdd = excelContext.workbook.worksheets.add;
  let activeSheet = null;
  excelContext.workbook.worksheets.add = function (name) {
    const s = origAdd.call(this, name);
    const origActivate = s.activate;
    s.activate = function () {
      s._activated = true;
      if (origActivate) origActivate.call(this);
    };
    activeSheet = s;
    return s;
  };

  const originalSync = excelContext.sync;
  excelContext.sync = async function () {
    if (activeSheet && activeSheet._activated) {
      vm.runInContext("TRAIN_REVISION++;", context);
    }
    return originalSync.apply(this, arguments);
  };

  await vm.runInContext("writePredictions()", context);

  // 1. Error toast must display actionable error
  assert.ok(elements["error-toast"].textContent.includes("Export failed: Settings or model changed during final export synchronization. Export cancelled."));

  // 2. Button must not flash success
  assert.notEqual(elements["writeback-btn"].textContent, "Report exported ✓");

  // 3. New sheet must have stale marker at A1
  const sheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("LR Report"));
  assert.ok(sheet, "Report sheet was created");
  assert.ok(sheet._a1Range, "A1 range was set");
  assert.ok(sheet._a1Range.values[0][0].includes("[STALE EXPORT - CANCELLED: Settings or model changed during final export synchronization. Export cancelled.]"));
});

test("exportModelWeights handles invalidation during final sync by writing stale marker to A1 and surfacing error", async () => {
  const excelContext = createMockExcelContext();
  const { context, elements } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_weights_sync",
    feature_names: ["X1"],
    class_labels: { positive: "1", negative: "0" },
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      weights_original_units: [1.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [{ name: "X1", coef: 1.0, odds_ratio: 2.7 }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  const origAdd = excelContext.workbook.worksheets.add;
  let activeSheet = null;
  excelContext.workbook.worksheets.add = function (name) {
    const s = origAdd.call(this, name);
    const origActivate = s.activate;
    s.activate = function () {
      s._activated = true;
      if (origActivate) origActivate.call(this);
    };
    activeSheet = s;
    return s;
  };

  const originalSync = excelContext.sync;
  excelContext.sync = async function () {
    if (activeSheet && activeSheet._activated) {
      vm.runInContext("LAST_RESULT._stale = true;", context);
    }
    return originalSync.apply(this, arguments);
  };

  await vm.runInContext("exportModelWeights()", context);

  // 1. Error toast must display actionable error
  assert.ok(elements["error-toast"].textContent.includes("Export model weights failed: Settings or model changed during final export synchronization. Export cancelled."));

  // 2. Button must not flash success
  assert.notEqual(elements["export-weights-btn"].textContent, "Weights exported ✓");

  // 3. New sheet must have stale marker at A1
  const sheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("Model Weights"));
  assert.ok(sheet, "Model Weights sheet was created");
  assert.ok(sheet._a1Range, "A1 range was set");
  assert.ok(sheet._a1Range.values[0][0].includes("[STALE EXPORT - CANCELLED: Settings or model changed during final export synchronization. Export cancelled.]"));
});

test("exportNewPredictions handles invalidation during final sync by writing stale marker to A1 and surfacing error", async () => {
  const excelContext = createMockExcelContext();
  const { context, elements } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_newpred_sync",
    feature_names: ["X1"],
    class_labels: { positive: "1", negative: "0" },
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
  };
  const mockPred = {
    model_id: "m_newpred_sync",
    revision: 1,
    threshold: 0.5,
    _source: { kind: "address", firstDataRow: 2 },
    class_labels: { positive: "1", negative: "0" },
    results: [{ prob: 0.8, pred: 1, label: "1" }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("LAST_NEW_PREDICTION = " + JSON.stringify(mockPred), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("newSourceStillMatches = async () => true", context);

  const origAdd = excelContext.workbook.worksheets.add;
  let activeSheet = null;
  excelContext.workbook.worksheets.add = function (name) {
    const s = origAdd.call(this, name);
    const origActivate = s.activate;
    s.activate = function () {
      s._activated = true;
      if (origActivate) origActivate.call(this);
    };
    activeSheet = s;
    return s;
  };

  const originalSync = excelContext.sync;
  excelContext.sync = async function () {
    if (activeSheet && activeSheet._activated) {
      vm.runInContext("invalidateNewPredictionInputs();", context);
    }
    return originalSync.apply(this, arguments);
  };

  await vm.runInContext("exportNewPredictions()", context);

  // 1. Error toast must display actionable error
  assert.ok(elements["error-toast"].textContent.includes("Export failed: Settings or prediction changed during final export synchronization. Export cancelled."));

  // 2. Button must not flash success
  assert.notEqual(elements["export-new-btn"].textContent, "Predictions exported ✓");

  // 3. New sheet must have stale marker at A1
  const sheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("New Predictions"));
  assert.ok(sheet, "New Predictions sheet was created");
  assert.ok(sheet._a1Range, "A1 range was set");
  assert.ok(sheet._a1Range.values[0][0].includes("[STALE EXPORT - CANCELLED: Settings or prediction changed during final export synchronization. Export cancelled.]"));
});

test("writePredictions middle-batch failure stops later writes and marks partial sheet incomplete at A1", async () => {
  const excelContext = createMockExcelContext();
  const { context, elements } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_mid_fail",
    feature_names: ["X1"],
    class_labels: { positive: "1", negative: "0" },
    _source: { x: { kind: "address" }, y: { kind: "address" }, firstDataRow: 2 },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0, baseline_accuracy: 0.5, accuracy_gain: 0.5 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      weights_original_units: [1.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [{ name: "X1", coef: 1.0, odds_ratio: 2.7 }],
    predictions: { prob: [0.8], partition: ["test"] },
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  let syncCount = 0;
  const originalSync = excelContext.sync;
  excelContext.sync = async function () {
    syncCount++;
    // Sync 1: addUniqueWorksheet
    // Sync 2: metadata (commits batch 1)
    // Sync 3: parameters write -> fails!
    if (syncCount === 3) {
      throw new Error("Simulated network timeout during parameter chunk write");
    }
    return originalSync.apply(this, arguments);
  };

  await vm.runInContext("writePredictions()", context);

  // 1. Error displayed
  assert.ok(elements["error-toast"].textContent.includes("Simulated network timeout during parameter chunk write"));

  // 2. Sheet marked incomplete at A1
  const sheet = excelContext.workbook.worksheets.items.find((s) => s.name.startsWith("LR Report"));
  assert.ok(sheet, "Report sheet was created");
  assert.ok(sheet._a1Range, "A1 range was set");
  assert.ok(sheet._a1Range.values[0][0].includes("[INCOMPLETE EXPORT - CANCELLED: Simulated network timeout during parameter chunk write]"));
});

test("export failure when marker synchronization also fails warns user without swallowing root cause", async () => {
  const excelContext = createMockExcelContext();
  const { context, elements } = bootTaskPane({ excelContext });

  const mockResult = {
    model_id: "m_marker_fail",
    feature_names: ["X1"],
    class_labels: { positive: "1", negative: "0" },
    _source: { x: { kind: "address" }, y: { kind: "address" } },
    _activeThreshold: 0.5,
    _stale: false,
    threshold: { value: 0.5, source: "test" },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0 },
    split: { n_train: 1, n_test: 1, actual_train_percent: 50, actual_test_percent: 50 },
    n_samples: 2,
    parameters: {
      weights_model_space: [1.0],
      intercept_model_space: 0.0,
      weights_original_units: [1.0],
      intercept_original_units: 0.0,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [{ name: "X1", coef: 1.0, odds_ratio: 2.7 }],
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockResult), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("sourceStillMatches = async () => true", context);

  let syncCount = 0;
  const originalSync = excelContext.sync;
  excelContext.sync = async function () {
    syncCount++;
    // Sync 1: addUniqueWorksheet
    // Sync 2: metadata (commits batch 1)
    // Sync 3: parameters write -> fails!
    if (syncCount === 3) {
      throw new Error("Primary host error during parameters write");
    }
    // Sync 4: status marker write -> fails too!
    if (syncCount === 4) {
      throw new Error("Secondary host error during status marker sync");
    }
    return originalSync.apply(this, arguments);
  };

  await vm.runInContext("exportModelWeights()", context);

  // Both errors must be surfaced in toast: root cause AND warning that status marker could not be updated
  const msg = elements["error-toast"].textContent;
  assert.ok(msg.includes("Primary host error during parameters write"), "Contains root error");
  assert.ok(msg.includes("Warning: Could not update sheet status marker: Secondary host error during status marker sync"), "Contains marker failure warning");
});

test("mode toggle switches between Table Mode and Numeric Mode", () => {
  const { context, elements } = bootTaskPane();
  // Default is Table Mode
  assert.equal(vm.runInContext("CURRENT_MODE", context), "table");
  assert.equal(elements["table-mode-container"].classList.contains("hidden"), false);
  assert.equal(elements["numeric-mode-container"].classList.contains("hidden"), true);

  // Switch to numeric mode
  elements["mode-numeric-btn"].trigger("click");
  assert.equal(vm.runInContext("CURRENT_MODE", context), "numeric");
  assert.equal(elements["table-mode-container"].classList.contains("hidden"), true);
  assert.equal(elements["numeric-mode-container"].classList.contains("hidden"), false);

  // Switch back to table mode
  elements["mode-table-btn"].trigger("click");
  assert.equal(vm.runInContext("CURRENT_MODE", context), "table");
  assert.equal(elements["table-mode-container"].classList.contains("hidden"), false);
  assert.equal(elements["numeric-mode-container"].classList.contains("hidden"), true);
});

test("table profiling displays columns, detects leakage candidate, and sets up Y selector", async () => {
  const profileResponse = {
    ok: true,
    worksheet_name: "titanic",
    table_range: "titanic!$A$1:$G$3",
    total_rows: 2,
    total_columns: 7,
    columns: [
      { index: 0, excel_col: "A", header: "survived", detected_type: "boolean", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [0, 1], is_leakage_candidate: false, suggested_use: "use" },
      { index: 1, excel_col: "B", header: "pclass", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [1, 3], is_leakage_candidate: false, suggested_use: "use" },
      { index: 2, excel_col: "C", header: "sex", detected_type: "categorical", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: ["female", "male"], is_leakage_candidate: false, suggested_use: "use" },
      { index: 3, excel_col: "D", header: "age", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [22, 38], is_leakage_candidate: false, suggested_use: "use" },
      { index: 4, excel_col: "E", header: "fare", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [7.25, 71.28], is_leakage_candidate: false, suggested_use: "use" },
      { index: 5, excel_col: "F", header: "embarked", detected_type: "categorical", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: ["S", "C"], is_leakage_candidate: false, suggested_use: "use" },
      { index: 6, excel_col: "G", header: "alive", detected_type: "categorical", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: ["no", "yes"], is_leakage_candidate: true, suggested_use: "exclude" },
    ],
    suggested_y: "survived",
    suggested_x: [1, 2, 3, 4, 5],
    warnings: ["'alive' appears directly derived from or identical to outcome 'survived'"],
  };

  const fetchMock = async (url) => {
    if (url.endsWith("/profile-table")) {
      return { ok: true, status: 200, json: async () => profileResponse };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const titanicRange = makeRange(
    "titanic",
    "$A$1:$G$3",
    [
      ["survived", "pclass", "sex", "age", "fare", "embarked", "alive"],
      [0, 3, "male", 22, 7.25, "S", "no"],
      [1, 1, "female", 38, 71.28, "C", "yes"],
    ],
    0,
    0
  );
  const excelContext = createMockExcelContext(
    {
      titanic: {
        id: "t1",
        ranges: {
          "A1:G3": titanicRange,
          "$A$1:$G$3": titanicRange,
        },
      },
    },
    {},
    "titanic"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["table-range"].value = "titanic!A1:G3";

  await vm.runInContext("profileTable()", context);

  assert.equal(elements["table-profile-card"].classList.contains("hidden"), false);
  assert.equal(elements["table-y-select"].children.length, 7);
  assert.equal(elements["table-columns-list"].children.length, 7);

  // Column alive (index 6) must have leakage warning and unchecked by default
  const aliveRow = elements["table-columns-list"].children[6];
  assert.ok(aliveRow.textContent.includes("alive"));
  assert.ok(aliveRow.textContent.includes("Leakage"));
  const aliveCheck = aliveRow.children[0];
  assert.equal(aliveCheck.checked, false);

  // Column sex (index 2) should be checked by default
  const sexRow = elements["table-columns-list"].children[2];
  const sexCheck = sexRow.children[0];
  assert.equal(sexCheck.checked, true);
});

test("table training calls /train-table and renders table results summary", async () => {
  const profileResponse = {
    ok: true,
    worksheet_name: "titanic",
    table_range: "titanic!$A$1:$F$4",
    total_rows: 3,
    total_columns: 6,
    columns: [
      { index: 0, excel_col: "A", header: "survived", detected_type: "boolean", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [0, 1], is_leakage_candidate: false, suggested_use: "use" },
      { index: 1, excel_col: "B", header: "pclass", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [1, 3], is_leakage_candidate: false, suggested_use: "use" },
      { index: 2, excel_col: "C", header: "sex", detected_type: "categorical", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: ["female", "male"], is_leakage_candidate: false, suggested_use: "use" },
      { index: 3, excel_col: "D", header: "age", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 3, sample_values: [22, 38], is_leakage_candidate: false, suggested_use: "use" },
      { index: 4, excel_col: "E", header: "fare", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 3, sample_values: [7.25, 71.28], is_leakage_candidate: false, suggested_use: "use" },
      { index: 5, excel_col: "F", header: "embarked", detected_type: "categorical", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: ["S", "C"], is_leakage_candidate: false, suggested_use: "use" },
    ],
    suggested_y: "survived",
    suggested_x: [1, 2, 3, 4, 5],
    warnings: [],
  };

  const trainResponse = {
    ok: true,
    table_mode: true,
    model_id: "m_table_123",
    table_metadata: {
      source_headers: ["survived", "pclass", "sex", "age", "fare", "embarked"],
      selected_indices: [1, 2, 3, 4, 5],
      y_column_name: "survived",
      y_column_index: 0,
      missing_policy: "impute",
      impute_numeric: "median",
      total_rows: 891,
      usable_rows: 891,
      excluded_missing_y_rows: [],
      excluded_missing_x_rows: [],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female", "age", "fare", "embarked=C", "embarked=Q"],
    },
    feature_names: ["pclass", "sex=female", "age", "fare", "embarked=C", "embarked=Q"],
    class_labels: { positive: "1", negative: "0" },
    class_balance: { positive: 342, negative: 549 },
    split: { n_train: 668, n_test: 223, actual_train_percent: 75, actual_test_percent: 25 },
    metrics: { accuracy: 0.81, precision: 0.78, recall: 0.72, f1: 0.75, auc: 0.86, log_loss: 0.44 },
    threshold: { value: 0.5, source: "default" },
    diagnostics: { converged: true, iterations: 120, final_loss: 0.44 },
    parameters: {
      weights_model_space: [-0.8, 2.5, -0.03, 0.002, 0.4, -0.1],
      intercept_model_space: 0.1,
      standardized: false,
      conversion_valid: true,
      class_labels: { positive: "1", negative: "0" },
    },
    coefficients: [
      { name: "pclass", coef: -0.8, odds_ratio: 0.45 },
      { name: "sex=female", coef: 2.5, odds_ratio: 12.18 },
    ],
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  const fetchMock = async (url) => {
    if (url.endsWith("/profile-table")) {
      return { ok: true, status: 200, json: async () => profileResponse };
    }
    if (url.endsWith("/train-table")) {
      return { ok: true, status: 200, json: async () => trainResponse };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const titanicRange = makeRange(
    "titanic",
    "$A$1:$F$4",
    [
      ["survived", "pclass", "sex", "age", "fare", "embarked"],
      [0, 3, "male", 22, 7.25, "S"],
      [1, 1, "female", 38, 71.28, "C"],
      [1, 3, "female", 26, 7.92, "S"],
    ],
    0,
    0
  );
  const excelContext = createMockExcelContext(
    {
      titanic: {
        id: "t1",
        ranges: {
          "A1:F4": titanicRange,
          "$A$1:$F$4": titanicRange,
        },
      },
    },
    {},
    "titanic"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["table-range"].value = "titanic!A1:F4";

  await vm.runInContext("profileTable()", context);
  await vm.runInContext("runTableTraining()", context);

  // Table results summary must be visible
  assert.equal(elements["table-results-summary"].classList.contains("hidden"), false);
  assert.ok(elements["table-results-rows-info"].textContent.includes("891"));
  assert.ok(elements["table-results-encodings-info"].textContent.includes("Saved preparation rules"));
  assert.ok(elements["table-results-encodings-info"].textContent.includes("reference level"));
  assert.equal(elements["export-weights-btn"].disabled, false);
});

test("scoreNewRows in table mode calls /predict-table and enables export", async () => {
  const predictResponse = {
    ok: true,
    model_id: "m_table_123",
    threshold: 0.5,
    warnings: ["Unseen category 'Z' encountered in column 'embarked'"],
    class_labels: { positive: "1", negative: "0" },
    results: [
      { score: 1.2, prob: 0.7685, pred: 1 },
      { score: -0.5, prob: 0.3775, pred: 0 },
    ],
  };

  let calledUrl = null;
  let calledBody = null;
  const fetchMock = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    if (url.endsWith("/predict-table")) {
      return { ok: true, status: 200, json: async () => predictResponse };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const newPassengers = makeRange(
    "NewPassengers",
    "$A$1:$E$3",
    [
      ["fare", "embarked", "sex", "pclass", "age"],
      [71.28, "C", "female", 1, 38],
      [8.05, "Z", "male", 3, 22],
    ],
    0,
    0
  );
  const excelContext = createMockExcelContext(
    {
      NewPassengers: {
        id: "np1",
        ranges: {
          "A1:E3": newPassengers,
          "$A$1:$E$3": newPassengers,
        },
      },
    },
    {},
    "NewPassengers"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["new-x-range"].value = "NewPassengers!A1:E3";
  elements["new-has-header"].checked = true;

  const mockModel = {
    table_mode: true,
    model_id: "m_table_123",
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["pclass", "sex", "age", "fare", "embarked"],
      selected_indices: [0, 1, 2, 3, 4],
    },
    feature_names: ["pclass", "sex=female", "age", "fare", "embarked=C"],
    class_labels: { positive: "Survived", negative: "Died" },
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("scoreNewRows()", context);

  assert.ok(calledUrl.endsWith("/predict-table"));
  assert.equal(calledBody.model_id, "m_table_123");
  assert.equal(calledBody.rows.length, 2);
  assert.equal(elements["export-new-btn"].classList.contains("hidden"), false);
  assert.ok(elements["new-score-note"].textContent.includes("Scored 2 new rows"));
  assert.ok(elements["new-score-note"].textContent.includes("Unseen category"));
});

test("table mode What-If renders form inputs, updates payload with mapped source_index, and calls /predict-table", async () => {
  let calledUrl = null;
  let calledBody = null;
  const fetchMock = async (url, opts) => {
    calledUrl = url;
    calledBody = JSON.parse(opts.body);
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "m_table_456",
          results: [{ score: 0.85, prob: 0.7006, pred: 1 }],
          warnings: [],
          class_labels: { positive: "1", negative: "0" },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });

  const mockModel = {
    table_mode: true,
    model_id: "m_table_456",
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex", "age"],
      selected_indices: [1, 2, 3],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
        { source_index: 3, source_header: "age", col_type: "numeric", impute_value: 28.0, categories: [], generated_features: ["age"] },
      ],
      generated_feature_names: ["pclass", "sex=female", "age"],
    },
    feature_names: ["pclass", "sex=female", "age"],
    class_labels: { positive: "1", negative: "0" },
    parameters: {
      weights_model_space: [-0.5, 2.0, -0.02],
      intercept_model_space: 0.1,
      conversion_valid: true,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);

  // Verify inputs were created for the 3 selected features
  const inputs = context.document.querySelectorAll("#whatif-inputs input, #whatif-inputs select");
  assert.equal(inputs.length, 3);
  assert.equal(inputs[0].dataset.feature, "pclass");
  assert.equal(inputs[1].dataset.feature, "sex");
  assert.equal(inputs[2].dataset.feature, "age");

  // User enters values
  inputs[0].value = "1";
  inputs[1].value = "female";
  inputs[2].value = "35";

  await vm.runInContext("runWhatIf()", context);

  assert.ok(calledUrl.endsWith("/predict-table"));
  assert.equal(calledBody.model_id, "m_table_456");
  assert.deepEqual(calledBody.headers, ["survived", "pclass", "sex", "age"]);
  // Positional rawRow must have null for index 0 (survived), and values at 1, 2, 3
  assert.equal(calledBody.rows.length, 1);
  assert.equal(calledBody.rows[0][0], null);
  assert.equal(calledBody.rows[0][1], 1);
  assert.equal(calledBody.rows[0][2], "female");
  assert.equal(calledBody.rows[0][3], 35);

  // Result UI updated
  assert.equal(elements["whatif-result"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-summary"].textContent.includes("70.06%"));
});

test("editing table range or picking range invalidates table profile and blocks training", async () => {
  const profileResponse = {
    ok: true,
    worksheet_name: "titanic",
    table_range: "titanic!$A$1:$C$4",
    total_rows: 3,
    total_columns: 3,
    columns: [
      { index: 0, excel_col: "A", header: "survived", detected_type: "boolean", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [0, 1], is_leakage_candidate: false, suggested_use: "use" },
      { index: 1, excel_col: "B", header: "pclass", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [1, 3], is_leakage_candidate: false, suggested_use: "use" },
      { index: 2, excel_col: "C", header: "fare", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [10, 50], is_leakage_candidate: false, suggested_use: "use" },
    ],
    suggested_y: "survived",
    suggested_x: [1, 2],
    warnings: [],
  };

  const titanicRange = makeRange(
    "titanic",
    "$A$1:$C$4",
    [
      ["survived", "pclass", "fare"],
      [0, 3, 10],
      [1, 1, 50],
      [1, 2, 25],
    ],
    0,
    0
  );
  const excelContext = createMockExcelContext(
    {
      titanic: {
        id: "t1",
        ranges: {
          "A1:C4": titanicRange,
          "$A$1:$C$4": titanicRange,
        },
      },
    },
    {},
    "titanic"
  );

  const fetchMock = async (url) => {
    if (url.endsWith("/profile-table")) {
      return { ok: true, status: 200, json: async () => profileResponse };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["table-range"].value = "titanic!A1:C4";

  await vm.runInContext("profileTable()", context);
  assert.equal(elements["table-profile-card"].classList.contains("hidden"), false);
  assert.ok(vm.runInContext("TABLE_FINGERPRINT", context) !== null);

  // User edits table range
  elements["table-range"].value = "titanic!A1:D10";
  elements["table-range"].trigger("input");

  // Profile card must be hidden and fingerprint cleared
  assert.equal(elements["table-profile-card"].classList.contains("hidden"), true);
  assert.equal(vm.runInContext("TABLE_FINGERPRINT", context), "");
  assert.equal(vm.runInContext("TABLE_PROFILE_DATA", context), null);

  // Training attempt must now fail
  await vm.runInContext("runTableTraining()", context);
  assert.equal(elements["error-toast"].textContent, "Please click 'Inspect table columns' to profile the table before fitting.");
});

test("table training blocks with error if Excel headers changed after inspection", async () => {
  const profileResponse = {
    ok: true,
    worksheet_name: "titanic",
    table_range: "titanic!$A$1:$B$4",
    total_rows: 3,
    total_columns: 2,
    columns: [
      { index: 0, excel_col: "A", header: "survived", detected_type: "boolean", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [0, 1], is_leakage_candidate: false, suggested_use: "use" },
      { index: 1, excel_col: "B", header: "pclass", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [1, 3], is_leakage_candidate: false, suggested_use: "use" },
    ],
    suggested_y: "survived",
    suggested_x: [1],
    warnings: [],
  };

  let trainCalled = false;
  const fetchMock = async (url) => {
    if (url.endsWith("/profile-table")) {
      return { ok: true, status: 200, json: async () => profileResponse };
    }
    if (url.endsWith("/train-table")) {
      trainCalled = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const initialRange = makeRange(
    "titanic",
    "$A$1:$B$4",
    [
      ["survived", "pclass"],
      [0, 3],
      [1, 1],
      [1, 2],
    ],
    0,
    0
  );

  const excelContext = createMockExcelContext(
    {
      titanic: {
        id: "t1",
        ranges: {
          "A1:B4": initialRange,
          "$A$1:$B$4": initialRange,
        },
      },
    },
    {},
    "titanic"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["table-range"].value = "titanic!A1:B4";

  await vm.runInContext("profileTable()", context);
  assert.equal(elements["table-profile-card"].classList.contains("hidden"), false);

  // Now someone renames column B in Excel to "passenger_class"
  initialRange.values[0] = ["survived", "passenger_class"];

  await vm.runInContext("runTableTraining()", context);
  assert.equal(trainCalled, false);
  assert.ok(elements["error-toast"].textContent.includes("Table headers or columns have changed since inspection"));
});

test("table profiling and training send start_row and start_col from range address", async () => {
  let profileBody = null;
  let trainBody = null;

  const profileResponse = {
    ok: true,
    worksheet_name: "Sheet1",
    table_range: "Sheet1!$D$10:$F$15",
    total_rows: 5,
    total_columns: 3,
    columns: [
      { index: 0, excel_col: "D", header: "target", detected_type: "boolean", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 2, sample_values: [0, 1], is_leakage_candidate: false, suggested_use: "use" },
      { index: 1, excel_col: "E", header: "feat1", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 3, sample_values: [10, 20], is_leakage_candidate: false, suggested_use: "use" },
      { index: 2, excel_col: "F", header: "feat2", detected_type: "numeric", is_constant: false, is_all_missing: false, missing_count: 0, distinct_count: 3, sample_values: [1, 2], is_leakage_candidate: false, suggested_use: "use" },
    ],
    suggested_y: "target",
    suggested_x: [1, 2],
    warnings: [],
  };

  const trainResponse = {
    ok: true,
    table_mode: true,
    model_id: "m_offset",
    table_metadata: {
      source_headers: ["target", "feat1", "feat2"],
      selected_indices: [1, 2],
      y_column_name: "target",
      y_column_index: 0,
      missing_policy: "impute",
      impute_numeric: "median",
      total_rows: 5,
      usable_rows: 5,
      excluded_missing_y_rows: [],
      excluded_missing_x_rows: [],
      column_specs: [
        { source_index: 1, source_header: "feat1", col_type: "numeric", impute_value: 10, categories: [], generated_features: ["feat1"] },
        { source_index: 2, source_header: "feat2", col_type: "numeric", impute_value: 1, categories: [], generated_features: ["feat2"] },
      ],
      generated_feature_names: ["feat1", "feat2"],
    },
    feature_names: ["feat1", "feat2"],
    class_labels: { positive: "1", negative: "0" },
    split: { n_train: 4, n_test: 1, actual_train_percent: 80, actual_test_percent: 20 },
    metrics: { accuracy: 1.0, precision: 1.0, recall: 1.0, f1: 1.0, auc: 1.0, log_loss: 0.1 },
    threshold: { value: 0.5, source: "default" },
    diagnostics: { converged: true, iterations: 10, final_loss: 0.1 },
    parameters: {
      weights_model_space: [0.5, 0.5],
      intercept_model_space: 0.0,
      standardized: false,
      conversion_valid: true,
    },
    coefficients: [
      { name: "feat1", coef: 0.5, odds_ratio: 1.65 },
      { name: "feat2", coef: 0.5, odds_ratio: 1.65 },
    ],
    threshold_data: { y_true: [0, 1], prob: [0.2, 0.8] },
    inference: {},
  };

  const fetchMock = async (url, opts) => {
    if (url.endsWith("/profile-table")) {
      profileBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => profileResponse };
    }
    if (url.endsWith("/train-table")) {
      trainBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => trainResponse };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const offsetRange = makeRange(
    "Sheet1",
    "$D$10:$F$15",
    [
      ["target", "feat1", "feat2"],
      [0, 10, 1],
      [1, 20, 2],
      [0, 15, 1],
      [1, 25, 3],
      [0, 12, 2],
    ],
    9,
    3
  );

  const excelContext = createMockExcelContext(
    {
      Sheet1: {
        id: "s1",
        ranges: {
          "D10:F15": offsetRange,
          "$D$10:$F$15": offsetRange,
        },
      },
    },
    {},
    "Sheet1"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["table-range"].value = "Sheet1!D10:F15";

  await vm.runInContext("profileTable()", context);
  assert.equal(profileBody.start_row, 10);
  assert.equal(profileBody.start_col, 4);

  await vm.runInContext("runTableTraining()", context);
  assert.equal(trainBody.start_row, 10);
  assert.equal(trainBody.start_col, 4);
});

test("table mode with 14 source columns expanding to >25 features keeps what-if enabled before and after calculation", async () => {
  const nCols = 14;
  const colSpecs = Array.from({ length: nCols }, (_, i) => ({
    source_index: i + 1,
    source_header: `col_${i + 1}`,
    col_type: i < 5 ? "categorical" : "numeric",
    impute_value: i < 5 ? null : 10.0,
    categories: i < 5 ? ["catA", "catB", "catC", "catD", "_missing_"] : [],
    all_train_categories: i < 5 ? ["ref", "catA", "catB", "catC", "catD", "_missing_"] : [],
    reference_category: i < 5 ? "ref" : null,
    generated_features: i < 5 ? [`col_${i+1}=catA`, `col_${i+1}=catB`, `col_${i+1}=catC`, `col_${i+1}=catD`, `col_${i+1}=_missing_`] : [`col_${i+1}`],
  }));
  const genFeatureNames = colSpecs.flatMap((s) => s.generated_features);

  let predictCalled = false;
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      predictCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "1", negative: "0" },
          results: [
            {
              score: 0.5,
              prob: 0.6225,
              pred: 1,
              explanation: {
                math_valid: true,
                intercept: 0.0,
                standardized: false,
                sum_contributions: 0.5,
                linear_score: 0.5,
                probability: 0.6225,
                features: genFeatureNames.map((name) => ({
                  feature: name,
                  raw_value: 0.0,
                  scaled_value: 0.0,
                  weight: 0.1,
                  contribution: 0.0,
                })),
                preparation_notes: ["Column 'col_1': value 'ref' is reference level"],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });

  const mockModel = {
    model_id: "m_wide_table",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["target", ...colSpecs.map((s) => s.source_header)],
      selected_indices: colSpecs.map((s) => s.source_index),
      column_specs: colSpecs,
      generated_feature_names: genFeatureNames,
    },
    feature_names: genFeatureNames,
    class_labels: { positive: "1", negative: "0" },
    parameters: {
      weights_model_space: genFeatureNames.map(() => 0.1),
      intercept_model_space: 0.0,
      standardized: false,
      conversion_valid: true,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  // Exactly 14 controls rendered
  const inputs = context.document.querySelectorAll("#whatif-inputs input, #whatif-inputs select");
  assert.equal(inputs.length, 14);

  // What-if button must be ENABLED despite >25 generated features
  assert.equal(elements["whatif-btn"].disabled, false);

  // Run calculation
  await vm.runInContext("runWhatIf()", context);
  assert.equal(predictCalled, true);

  // After calculation finishes, button must REMAIN enabled
  assert.equal(elements["whatif-btn"].disabled, false);
});

test("table mode with 26 source columns disables what-if with guidance note while score-new-btn remains enabled", async () => {
  const nCols = 26;
  const colSpecs = Array.from({ length: nCols }, (_, i) => ({
    source_index: i + 1,
    source_header: `feature_${i + 1}`,
    col_type: "numeric",
    impute_value: 0.0,
    categories: [],
    generated_features: [`feature_${i + 1}`],
  }));

  const { context, elements } = bootTaskPane();

  const mockModel = {
    model_id: "m_26_cols",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["target", ...colSpecs.map((s) => s.source_header)],
      selected_indices: colSpecs.map((s) => s.source_index),
      column_specs: colSpecs,
      generated_feature_names: colSpecs.map((s) => s.source_header),
    },
    feature_names: colSpecs.map((s) => s.source_header),
    class_labels: { positive: "1", negative: "0" },
    parameters: {
      weights_model_space: colSpecs.map(() => 0.1),
      intercept_model_space: 0.0,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  // Button disabled
  assert.equal(elements["whatif-btn"].disabled, true);
  // Guidance message directs user to "Score new rows" and specifies source columns
  assert.ok(elements["whatif-inputs"].textContent.includes("25 or fewer source columns"));
  assert.ok(elements["whatif-inputs"].textContent.includes("Score new rows"));
  // Batch scoring button remains enabled
  assert.equal(elements["score-new-btn"].disabled, false);
});

test("table mode What-If renders truthful feature contributions, scaled values, weights, intercept, and prep notes", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          results: [
            {
              score: 0.85,
              prob: 0.700567,
              pred: 1,
              explanation: {
                math_valid: true,
                intercept: 0.1,
                standardized: true,
                sum_contributions: 0.75,
                linear_score: 0.85,
                probability: 0.700567,
                features: [
                  { feature: "pclass", raw_value: 1.0, scaled_value: -0.8, weight: -0.5, contribution: 0.4 },
                  { feature: "sex=female", raw_value: 1.0, scaled_value: 1.0, weight: 0.35, contribution: 0.35 },
                ],
                preparation_notes: [
                  "Column 'age': missing value → imputed with training median (28.0)",
                  "Column 'sex': value 'female' → active dummy 'sex=female' = 1.0",
                ],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });

  const mockModel = {
    model_id: "m_truthful_whatif",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
      standardized: true,
      conversion_valid: true,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  // Result card visible
  assert.equal(elements["whatif-result"].classList.contains("hidden"), false);

  // Truthful table rows
  assert.equal(whatifTbody.children.length, 2);
  const row0 = whatifTbody.children[0];
  assert.equal(row0.children[0].textContent, "pclass");
  assert.equal(row0.children[1].textContent, "1.0000");
  assert.equal(row0.children[2].textContent, "-0.8000");
  assert.equal(row0.children[3].textContent, "-0.5000");
  assert.equal(row0.children[4].textContent, "+0.4000");

  const row1 = whatifTbody.children[1];
  assert.equal(row1.children[0].textContent, "sex=female");
  assert.equal(row1.children[1].textContent, "1.0000");
  assert.equal(row1.children[2].textContent, "1.0000");
  assert.equal(row1.children[3].textContent, "0.3500");
  assert.equal(row1.children[4].textContent, "+0.3500");

  // Steps
  const steps = elements["whatif-calculation-steps"].children;
  assert.ok(steps[0].textContent.includes("0.7500"));
  assert.ok(steps[1].textContent.includes("0.1000"));
  assert.ok(steps[2].textContent.includes("0.8500"));

  // Prep notes
  assert.ok(elements["whatif-prep-notes"].textContent.includes("missing value → imputed with training median"));
  assert.ok(elements["whatif-prep-notes"].textContent.includes("active dummy"));
});

test("numeric mode limits manual what-if to 25 features and stale model stays disabled in either mode", () => {
  const { context, elements } = bootTaskPane();

  // 25 numeric features: enabled
  const model25 = {
    model_id: "m_25",
    table_mode: false,
    _stale: false,
    feature_names: Array.from({ length: 25 }, (_, i) => `f_${i}`),
    parameters: { weights_model_space: Array(25).fill(0.1), intercept_model_space: 0 },
    class_labels: { positive: "1", negative: "0" },
  };
  vm.runInContext("LAST_RESULT = " + JSON.stringify(model25), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  assert.equal(elements["whatif-btn"].disabled, false);

  // 26 numeric features: disabled
  const model26 = {
    model_id: "m_26",
    table_mode: false,
    _stale: false,
    feature_names: Array.from({ length: 26 }, (_, i) => `f_${i}`),
    parameters: { weights_model_space: Array(26).fill(0.1), intercept_model_space: 0 },
    class_labels: { positive: "1", negative: "0" },
  };
  vm.runInContext("LAST_RESULT = " + JSON.stringify(model26), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  assert.equal(elements["whatif-btn"].disabled, true);
  assert.ok(elements["whatif-inputs"].textContent.includes("25 or fewer features"));

  // Stale model in table mode
  const staleTable = {
    model_id: "m_stale_table",
    table_mode: true,
    _stale: true,
    table_metadata: {
      column_specs: [{ source_index: 1, source_header: "c1", col_type: "numeric" }],
    },
    feature_names: ["c1"],
  };
  vm.runInContext("LAST_RESULT = " + JSON.stringify(staleTable), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  assert.equal(elements["whatif-btn"].disabled, true);
});

test("table mode What-If with missing explanation hides breakdown and displays explanation unavailable", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          results: [{ score: 0.85, prob: 0.700567, pred: 1 }],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockModel = {
    model_id: "m_missing_exp",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  // Result box is visible and shows probability
  assert.equal(elements["whatif-result"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-summary"].textContent.includes("70.06%"));

  // Worked card, table, steps, and prep notes are hidden/empty (no false breakdown or Σ=0)
  assert.equal(elements["whatif-worked-card"].classList.contains("hidden"), true);
  assert.equal(whatifTbody.children.length, 0);
  assert.equal(elements["whatif-calculation-steps"].textContent, "");
  assert.equal(elements["whatif-prep-notes"].textContent, "");

  // Explanation unavailable message is shown
  assert.equal(elements["whatif-unavailable-msg"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-unavailable-msg"].textContent.includes("Explanation unavailable"));
});

test("table mode What-If with backend explanation exception displays explanation unavailable with cause", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          explanation_unavailable: "Explanation unavailable: Matrix singular in preprocessing",
          results: [
            {
              score: 0.85,
              prob: 0.700567,
              pred: 1,
              explanation_unavailable: "Explanation unavailable: Matrix singular in preprocessing",
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockModel = {
    model_id: "m_exp_err",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  // Worked card is hidden, no fake math
  assert.equal(elements["whatif-worked-card"].classList.contains("hidden"), true);
  assert.equal(whatifTbody.children.length, 0);
  assert.equal(elements["whatif-calculation-steps"].textContent, "");

  // Explanation unavailable displays the backend cause
  assert.equal(elements["whatif-unavailable-msg"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-unavailable-msg"].textContent.includes("Matrix singular in preprocessing"));
});

test("table mode What-If with math_valid false hides breakdown and displays explanation unavailable", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          results: [
            {
              score: 0.85,
              prob: 0.700567,
              pred: 1,
              explanation: {
                math_valid: false,
                intercept: 0.1,
                sum_contributions: 0.75,
                features: [
                  { feature: "pclass", raw_value: 1.0, scaled_value: -0.8, weight: -0.5, contribution: 0.4 },
                  { feature: "sex=female", raw_value: 1.0, scaled_value: 1.0, weight: 0.35, contribution: 0.35 },
                ],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockModel = {
    model_id: "m_math_invalid",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  assert.equal(elements["whatif-worked-card"].classList.contains("hidden"), true);
  assert.equal(whatifTbody.children.length, 0);
  assert.equal(elements["whatif-calculation-steps"].textContent, "");
  assert.equal(elements["whatif-unavailable-msg"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-unavailable-msg"].textContent.includes("mathematical validity as false"));
});

test("table mode What-If with score mismatch hides breakdown and displays explanation unavailable", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          results: [
            {
              score: 1.50, // Mismatched score: sum(0.75) + b(0.1) = 0.85 !== 1.50
              prob: 0.817574,
              pred: 1,
              explanation: {
                math_valid: true,
                intercept: 0.1,
                sum_contributions: 0.75,
                features: [
                  { feature: "pclass", raw_value: 1.0, scaled_value: -0.8, weight: -0.5, contribution: 0.4 },
                  { feature: "sex=female", raw_value: 1.0, scaled_value: 1.0, weight: 0.35, contribution: 0.35 },
                ],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockModel = {
    model_id: "m_score_mismatch",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  assert.equal(elements["whatif-worked-card"].classList.contains("hidden"), true);
  assert.equal(whatifTbody.children.length, 0);
  assert.equal(elements["whatif-calculation-steps"].textContent, "");
  assert.equal(elements["whatif-unavailable-msg"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-unavailable-msg"].textContent.includes("does not match returned score"));
});

test("table mode What-If with probability mismatch hides breakdown and displays explanation unavailable", async () => {
  const fetchMock = async (url) => {
    if (url.endsWith("/predict-table")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          class_labels: { positive: "Survived", negative: "Perished" },
          results: [
            {
              score: 0.85,
              prob: 0.999999, // Mismatched probability: sigmoid(0.85) ~ 0.700567 != 0.999999
              pred: 1,
              explanation: {
                math_valid: true,
                intercept: 0.1,
                sum_contributions: 0.75,
                features: [
                  { feature: "pclass", raw_value: 1.0, scaled_value: -0.8, weight: -0.5, contribution: 0.4 },
                  { feature: "sex=female", raw_value: 1.0, scaled_value: 1.0, weight: 0.35, contribution: 0.35 },
                ],
              },
            },
          ],
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  };

  const { context, elements, whatifTbody } = bootTaskPane({ fetchMock });
  const mockModel = {
    model_id: "m_prob_mismatch",
    table_mode: true,
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["survived", "pclass", "sex"],
      selected_indices: [1, 2],
      column_specs: [
        { source_index: 1, source_header: "pclass", col_type: "numeric", impute_value: 3.0, categories: [], generated_features: ["pclass"] },
        { source_index: 2, source_header: "sex", col_type: "categorical", reference_category: "male", categories: ["female"], all_train_categories: ["female", "male"], generated_features: ["sex=female"] },
      ],
      generated_feature_names: ["pclass", "sex=female"],
    },
    feature_names: ["pclass", "sex=female"],
    class_labels: { positive: "Survived", negative: "Perished" },
    parameters: {
      weights_model_space: [-0.5, 0.35],
      intercept_model_space: 0.1,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  await vm.runInContext("runWhatIf()", context);

  assert.equal(elements["whatif-worked-card"].classList.contains("hidden"), true);
  assert.equal(whatifTbody.children.length, 0);
  assert.equal(elements["whatif-calculation-steps"].textContent, "");
  assert.equal(elements["whatif-unavailable-msg"].classList.contains("hidden"), false);
  assert.ok(elements["whatif-unavailable-msg"].textContent.includes("does not match returned probability"));
});

test("validateHeaderRow rejects duplicate, case-variant, and whitespace-variant headers", () => {
  const { context } = bootTaskPane();

  // Distinct headers accepted
  const valid = vm.runInContext("validateHeaderRow(['Age', 'Fare', 'Pclass'])", context);
  assert.deepEqual(Array.from(valid), ["Age", "Fare", "Pclass"]);

  // Exact duplicate rejected
  assert.throws(
    () => vm.runInContext("validateHeaderRow(['Age', 'Fare', 'Age'])", context),
    /Feature headers must be unique/
  );

  // Case variant rejected
  assert.throws(
    () => vm.runInContext("validateHeaderRow(['Age', 'Fare', 'age'])", context),
    /Feature headers must be unique/
  );

  // Whitespace-collapsed variant rejected
  assert.throws(
    () => vm.runInContext("validateHeaderRow(['First Name', '  first   name  '])", context),
    /Feature headers must be unique/
  );

  // Blank header rejected
  assert.throws(
    () => vm.runInContext("validateHeaderRow(['Age', '   ', 'Fare'])", context),
    /Feature headers cannot be blank/
  );
});

test("runTableTraining rejects selected features differing only by case or whitespace", async () => {
  let trainCalled = false;
  const fetchMock = async (url) => {
    if (url.endsWith("/train-table")) {
      trainCalled = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });

  elements["table-range"].value = "Sheet1!A1:C10";
  vm.runInContext("TABLE_HEADERS = ['survived', 'Age', 'age'];", context);
  vm.runInContext("TABLE_ROWS = [[1, 20, 20], [0, 30, 30]];", context);
  vm.runInContext("TABLE_DESCRIPTOR = { rowIndex: 0, columnIndex: 0, values: [] };", context);
  vm.runInContext("TABLE_PROFILE_DATA = { suggested_y_index: 0 };", context);

  // Set outcome column to survived
  elements["table-y-select"].value = "0";

  // Simulate checkboxes for both feature columns (index 1 and index 2)
  const cb1 = element("col-1", "input", "checkbox");
  cb1.className = "table-col-checkbox";
  cb1.checked = true;
  cb1.dataset.colIndex = "1";

  const cb2 = element("col-2", "input", "checkbox");
  cb2.className = "table-col-checkbox";
  cb2.checked = true;
  cb2.dataset.colIndex = "2";

  elements["table-columns-list"].children = [cb1, cb2];

  await vm.runInContext("runTableTraining()", context);

  assert.equal(trainCalled, false, "Training must not be called when ambiguous headers are selected");
  assert.equal(elements["error-toast"].classList.contains("hidden"), false);
  assert.ok(elements["error-toast"].textContent.includes("ambiguous or duplicate header"));
});

test("runTableTraining rejects outcome column colliding with selected feature header", async () => {
  let trainCalled = false;
  const fetchMock = async (url) => {
    if (url.endsWith("/train-table")) {
      trainCalled = true;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });

  elements["table-range"].value = "Sheet1!A1:C10";
  // Outcome "Survived", feature column has "survived" (differing only by case/whitespace)
  vm.runInContext("TABLE_HEADERS = ['Survived', '  survived  ', 'fare'];", context);
  vm.runInContext("TABLE_ROWS = [[1, 1, 10], [0, 0, 20]];", context);
  vm.runInContext("TABLE_DESCRIPTOR = { rowIndex: 0, columnIndex: 0, values: [] };", context);
  vm.runInContext("TABLE_PROFILE_DATA = { suggested_y_index: 0 };", context);

  elements["table-y-select"].value = "0";

  // Select feature column 1 ("  survived  ")
  const cb1 = element("col-1", "input", "checkbox");
  cb1.className = "table-col-checkbox";
  cb1.checked = true;
  cb1.dataset.colIndex = "1";

  elements["table-columns-list"].children = [cb1];

  await vm.runInContext("runTableTraining()", context);

  assert.equal(trainCalled, false, "Training must not be called when outcome collides with selected feature");
  assert.equal(elements["error-toast"].classList.contains("hidden"), false);
  assert.ok(elements["error-toast"].textContent.includes("cannot also be selected as an input feature"));
});

test("table mode What-If renders literal _missing_ and \\_missing\\_ categories and submits blank as null", async () => {
  let lastRequestBody = null;
  const fetchMock = async (url, opts) => {
    if (url.endsWith("/predict-table")) {
      lastRequestBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          model_id: "m_cat_test",
          results: [{ score: 0.25, prob: 0.562, pred: 1 }],
          warnings: [],
          class_labels: { positive: "1", negative: "0" },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const { context, elements } = bootTaskPane({ fetchMock });

  const mockModel = {
    table_mode: true,
    model_id: "m_cat_test",
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["target", "status"],
      selected_indices: [1],
      column_specs: [
        {
          source_index: 1,
          source_header: "status",
          col_type: "categorical",
          reference_category: "active",
          categories: ["pending", "_missing_", "\\_missing\\_"],
          all_train_categories: ["active", "pending", "_missing_", "\\_missing\\_"],
          has_missing_indicator: true,
          missing_indicator_offset: 3,
          missing_feature_name: "status=_missing_",
          generated_features: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
        },
      ],
      generated_feature_names: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
    },
    feature_names: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
    class_labels: { positive: "1", negative: "0" },
    parameters: {
      weights_model_space: [0.5, -0.3, 0.8],
      intercept_model_space: 0.0,
      conversion_valid: true,
    },
    inference: {},
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("setModelActionsEnabled(true)", context);
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);

  const inputs = context.document.querySelectorAll("#whatif-inputs input, #whatif-inputs select");
  assert.equal(inputs.length, 1);
  const select = inputs[0];
  const optionValues = select.children.map((opt) => opt.value);
  const optionTexts = select.children.map((opt) => opt.textContent);

  // 1. Verify separate blank option for true missingness
  assert.equal(optionValues[0], "");
  assert.equal(optionTexts[0], "(Missing / Blank)");

  // 2. Verify reference category has (Ref) label
  assert.equal(optionValues[1], "active");
  assert.equal(optionTexts[1], "active (Ref)");

  // 3. Verify real category "pending"
  assert.equal(optionValues[2], "pending");
  assert.equal(optionTexts[2], "pending");

  // 4. Verify literal "_missing_" is preserved and selectable
  assert.equal(optionValues[3], "_missing_");
  assert.equal(optionTexts[3], "_missing_");

  // 5. Verify literal "\\_missing\\_" is preserved and selectable
  assert.equal(optionValues[4], "\\_missing\\_");
  assert.equal(optionTexts[4], "\\_missing\\_");

  // Test submitting blank -> payload has null
  select.value = "";
  await vm.runInContext("runWhatIf()", context);
  assert.equal(lastRequestBody.rows[0][1], null);

  // Test submitting literal "_missing_" -> payload has "_missing_"
  select.value = "_missing_";
  await vm.runInContext("runWhatIf()", context);
  assert.equal(lastRequestBody.rows[0][1], "_missing_");

  // Test submitting literal "\\_missing\\_" -> payload has "\\_missing\\_"
  select.value = "\\_missing\\_";
  await vm.runInContext("runWhatIf()", context);
  assert.equal(lastRequestBody.rows[0][1], "\\_missing\\_");

  // Test submitting reference category -> payload has "active"
  select.value = "active";
  await vm.runInContext("runWhatIf()", context);
  assert.equal(lastRequestBody.rows[0][1], "active");
});

test("what-if and batch predictions agree on payload representation for blank, literal _missing_, and reference categories", async () => {
  let batchRequestBody = null;
  let whatifRequests = [];

  const fetchMock = async (url, opts) => {
    if (url.endsWith("/predict-table")) {
      const parsedBody = JSON.parse(opts.body);
      if (parsedBody.explain) {
        whatifRequests.push(parsedBody);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            model_id: "m_agree_test",
            results: [{ score: 0.1, prob: 0.525, pred: 1 }],
            warnings: [],
            class_labels: { positive: "1", negative: "0" },
          }),
        };
      } else {
        batchRequestBody = parsedBody;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            model_id: "m_agree_test",
            results: [
              { score: 0.1, prob: 0.525, pred: 1 },
              { score: 0.2, prob: 0.550, pred: 1 },
              { score: 0.3, prob: 0.574, pred: 1 },
              { score: 0.0, prob: 0.500, pred: 1 },
            ],
            warnings: [],
            class_labels: { positive: "1", negative: "0" },
          }),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const newRowsRange = makeRange(
    "NewData",
    "$A$1:$A$5",
    [
      ["status"],
      [""],
      ["_missing_"],
      ["\\_missing\\_"],
      ["active"],
    ],
    0,
    0
  );

  const excelContext = createMockExcelContext(
    {
      NewData: {
        id: "nd1",
        ranges: {
          "A1:A5": newRowsRange,
          "$A$1:$A$5": newRowsRange,
        },
      },
    },
    {},
    "NewData"
  );

  const { context, elements } = bootTaskPane({ excelContext, fetchMock });
  elements["new-x-range"].value = "NewData!A1:A5";
  elements["new-has-header"].checked = true;

  const mockModel = {
    table_mode: true,
    model_id: "m_agree_test",
    _activeThreshold: 0.5,
    _stale: false,
    table_metadata: {
      source_headers: ["status"],
      selected_indices: [0],
      column_specs: [
        {
          source_index: 0,
          source_header: "status",
          col_type: "categorical",
          reference_category: "active",
          categories: ["pending", "_missing_", "\\_missing\\_"],
          all_train_categories: ["active", "pending", "_missing_", "\\_missing\\_"],
          has_missing_indicator: true,
          generated_features: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
        },
      ],
      generated_feature_names: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
    },
    feature_names: ["status=pending", "status=_missing_", "status=\\_missing\\_"],
    class_labels: { positive: "1", negative: "0" },
  };

  vm.runInContext("LAST_RESULT = " + JSON.stringify(mockModel), context);
  vm.runInContext("setModelActionsEnabled(true)", context);

  // 1. Run batch scoring
  await vm.runInContext("scoreNewRows()", context);
  assert.equal(batchRequestBody.rows.length, 4);

  // 2. Run What-If for each input row
  vm.runInContext("buildWhatIf(LAST_RESULT.feature_names)", context);
  const inputs = context.document.querySelectorAll("#whatif-inputs input, #whatif-inputs select");
  const select = inputs[0];

  const testInputs = ["", "_missing_", "\\_missing\\_", "active"];
  for (const inp of testInputs) {
    select.value = inp;
    await vm.runInContext("runWhatIf()", context);
  }

  assert.equal(whatifRequests.length, 4);

  // Verify What-If representation aligns with batch prediction row representation:
  // Row 0: blank in batch is "" -> whatif is null (both are treated as missing cell in backend)
  assert.equal(batchRequestBody.rows[0][0], "");
  assert.equal(whatifRequests[0].rows[0][0], null);

  // Row 1: literal "_missing_" in batch matches whatif
  assert.equal(batchRequestBody.rows[1][0], "_missing_");
  assert.equal(whatifRequests[1].rows[0][0], "_missing_");

  // Row 2: literal "\\_missing\\_" in batch matches whatif
  assert.equal(batchRequestBody.rows[2][0], "\\_missing\\_");
  assert.equal(whatifRequests[2].rows[0][0], "\\_missing\\_");

  // Row 3: reference category in batch matches whatif
  assert.equal(batchRequestBody.rows[3][0], "active");
  assert.equal(whatifRequests[3].rows[0][0], "active");
});

