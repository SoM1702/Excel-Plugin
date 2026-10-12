/*
 * Excel task-pane client. A trained result is tied to a checked worksheet
 * snapshot. Changing model inputs marks it stale until the user trains again.
 */

const DEFAULT_BACKEND = "https://localhost:8000";
const REQUEST_TIMEOUT_MS = 30000;

let BACKEND_URL = localStorage.getItem("lr_backend_url") || DEFAULT_BACKEND;
let LAST_RESULT = null;
let LAST_NEW_PREDICTION = null;
let rocChart = null;
let coefChart = null;

Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) return;

  document.querySelectorAll("button[data-target]").forEach((button) => {
    button.addEventListener("click", () => useSelection(button.dataset.target));
  });
  document.getElementById("run-btn").addEventListener("click", runModel);
  document.getElementById("writeback-btn").addEventListener("click", writePredictions);
  document.getElementById("whatif-btn").addEventListener("click", runWhatIf);
  document.getElementById("score-new-btn").addEventListener("click", scoreNewRows);
  document.getElementById("export-new-btn").addEventListener("click", exportNewPredictions);

  const testSize = document.getElementById("test-size");
  testSize.addEventListener("input", () => {
    document.getElementById("test-size-out").textContent =
      Math.round(Number(testSize.value) * 100) + "%";
    markRunStale();
  });
  document.getElementById("threshold").addEventListener("input", (event) => {
    const threshold = Number(event.target.value);
    document.getElementById("threshold-out").textContent = threshold.toFixed(2);
    if (LAST_RESULT && !LAST_RESULT._stale) updateConfusion(threshold);
  });

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
    clearActiveModel("Backend changed. Train a model on the selected backend.");
    checkBackend();
  });

  ["y-range", "x-range", "has-header", "standardize", "reg-c", "balance", "cv"].forEach((id) => {
    const element = document.getElementById(id);
    element.addEventListener("change", markRunStale);
    if (element.tagName === "INPUT" && element.type !== "checkbox") {
      element.addEventListener("input", markRunStale);
    }
  });
  ["new-x-range", "new-has-header"].forEach((id) => {
    document.getElementById(id).addEventListener("change", clearNewPrediction);
  });

  setModelActionsEnabled(false);
  checkBackend();
});

async function fetchJson(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(BACKEND_URL + path, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // A malformed server response is handled below.
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
    await fetchJson("/health", {}, 5000);
    banner.textContent = "Backend connected ✓";
    banner.className = "banner banner-ok";
  } catch {
    banner.textContent =
      "Backend not reachable at " + BACKEND_URL + ". Start the HTTPS Python service, then save its URL here.";
    banner.className = "banner banner-err";
  }
}

async function useSelection(targetId) {
  try {
    await Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load("address");
      await context.sync();
      document.getElementById(targetId).value = range.address;
    });
    if (targetId === "new-x-range") clearNewPrediction();
    else markRunStale();
  } catch (error) {
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
  return value === "" || value === null || value === undefined;
}

function classifyProbability(probability, threshold) {
  return probability >= threshold ? 1 : 0;
}

function valuesFingerprint(values) {
  return JSON.stringify(values);
}

function sourceLabel(sheetName, address) {
  return address.includes("!") ? address : sheetName + "!" + address;
}

function isOverlap(first, second) {
  return (
    first.rowIndex < second.rowIndex + second.rowCount &&
    second.rowIndex < first.rowIndex + first.rowCount &&
    first.columnIndex < second.columnIndex + second.columnCount &&
    second.columnIndex < first.columnIndex + first.columnCount
  );
}

function validateHeaderRow(headerRow) {
  const names = headerRow.map((value) => String(value).trim());
  if (names.some((name) => !name)) throw new Error("Feature headers cannot be blank.");
  if (new Set(names).size !== names.length) throw new Error("Feature headers must be unique.");
  return names;
}

function validateNumericRows(rows, featureNames, firstDataRow) {
  if (!rows.length) throw new Error("Select at least one feature data row.");
  const features = rows.map((row, rowOffset) => {
    if (row.length !== featureNames.length) {
      throw new Error("Each selected feature row must have the same number of columns.");
    }
    return row.map((cell, columnOffset) => {
      const number = Number(cell);
      if (isBlank(cell) || !Number.isFinite(number)) {
        throw new Error(
          "Feature " + featureNames[columnOffset] + " at Excel row " +
          (firstDataRow + rowOffset) + " must be a finite number."
        );
      }
      return number;
    });
  });
  const constantFeatures = featureNames.filter((_, index) =>
    features.every((row) => row[index] === features[0][index])
  );
  return { features, constantFeatures };
}

function validateLabels(labels, firstDataRow) {
  const unique = new Map();
  labels.forEach((value, index) => {
    if (isBlank(value)) throw new Error("Outcome at Excel row " + (firstDataRow + index) + " is blank.");
    unique.set(typeof value + ":" + String(value), value);
  });
  if (unique.size !== 2) {
    throw new Error("The outcome must contain exactly two classes; found " + unique.size + ".");
  }
  return { labels, classLabels: [...unique.values()].map((value) => String(value)) };
}

function renderPreview(data) {
  const preview = document.getElementById("data-preview");
  const counts = data.classLabels.map((label) =>
    label + ": " + data.labels.filter((value) => String(value) === label).length
  );
  const details = [
    data.labels.length + " rows · " + data.featureNames.length + " features",
    "Features: " + data.featureNames.join(", "),
    "Classes: " + counts.join(", "),
    "Sample row: " + data.sample.join(", "),
  ];
  if (data.constantFeatures.length) {
    details.push("Constant feature warning: " + data.constantFeatures.join(", "));
  }
  preview.textContent = details.join(" | ");
  preview.classList.remove("hidden");
}

async function readTrainingData(yAddress, xAddress) {
  const hasHeader = document.getElementById("has-header").checked;
  let xValues;
  let yValues;
  let xMeta;
  let yMeta;

  await Excel.run(async (context) => {
    const xRange = getRangeByAddress(context, xAddress);
    const yRange = getRangeByAddress(context, yAddress);
    xRange.load("values,address,rowIndex,columnIndex,rowCount,columnCount");
    yRange.load("values,address,rowIndex,columnIndex,rowCount,columnCount");
    xRange.worksheet.load("name");
    yRange.worksheet.load("name");
    await context.sync();
    xValues = xRange.values;
    yValues = yRange.values;
    xMeta = {
      address: xRange.address, sheetName: xRange.worksheet.name,
      rowIndex: xRange.rowIndex, columnIndex: xRange.columnIndex,
      rowCount: xRange.rowCount, columnCount: xRange.columnCount,
    };
    yMeta = {
      address: yRange.address, sheetName: yRange.worksheet.name,
      rowIndex: yRange.rowIndex, columnIndex: yRange.columnIndex,
      rowCount: yRange.rowCount, columnCount: yRange.columnCount,
    };
  });

  if (xMeta.sheetName !== yMeta.sheetName) throw new Error("For this version, X and Y must be on the same worksheet.");
  if (yMeta.columnCount !== 1) throw new Error("Select exactly one outcome (Y) column.");
  if (xMeta.rowIndex !== yMeta.rowIndex || xMeta.rowCount !== yMeta.rowCount) {
    throw new Error("X and Y must start on the same row and contain the same number of rows.");
  }
  if (isOverlap(xMeta, yMeta)) throw new Error("The outcome column cannot also be used as a feature.");
  if (!xValues.length || !yValues.length) throw new Error("The selected ranges are empty.");

  const headerOffset = hasHeader ? 1 : 0;
  let featureNames;
  let rows;
  let labels;
  let outcomeName = "Outcome";
  if (hasHeader) {
    if (xValues.length < 2) throw new Error("A header row requires at least one data row.");
    featureNames = validateHeaderRow(xValues[0]);
    if (isBlank(yValues[0][0])) throw new Error("The outcome header cannot be blank.");
    outcomeName = String(yValues[0][0]).trim();
    rows = xValues.slice(1);
    labels = yValues.slice(1).map((row) => row[0]);
  } else {
    featureNames = Array.from({ length: xMeta.columnCount }, (_, index) => "X" + (index + 1));
    rows = xValues;
    labels = yValues.map((row) => row[0]);
  }

  const firstDataRow = xMeta.rowIndex + headerOffset + 1;
  const numeric = validateNumericRows(rows, featureNames, firstDataRow);
  const labelInfo = validateLabels(labels, firstDataRow);
  renderPreview({
    featureNames, labels: labelInfo.labels, classLabels: labelInfo.classLabels,
    constantFeatures: numeric.constantFeatures, sample: numeric.features[0],
  });

  return {
    features: numeric.features,
    labels: labelInfo.labels,
    featureNames,
    source: {
      x: { ...xMeta, fingerprint: valuesFingerprint(xValues) },
      y: { ...yMeta, fingerprint: valuesFingerprint(yValues) },
      hasHeader, firstDataRow, featureNames, outcomeName, createdAt: new Date().toISOString(),
    },
  };
}

async function runModel() {
  const yAddress = document.getElementById("y-range").value;
  const xAddress = document.getElementById("x-range").value;
  if (!yAddress || !xAddress) {
    showError("Select both an outcome Y range and feature X range.");
    return;
  }

  const button = document.getElementById("run-btn");
  button.disabled = true;
  button.textContent = "Running…";
  setModelActionsEnabled(false);
  try {
    const input = await readTrainingData(yAddress, xAddress);
    const result = await fetchJson("/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features: input.features,
        labels: input.labels,
        feature_names: input.featureNames,
        standardize: document.getElementById("standardize").checked,
        test_size: Number(document.getElementById("test-size").value),
        C: Number(document.getElementById("reg-c").value),
        class_weight: document.getElementById("balance").checked ? "balanced" : null,
        cv_folds: document.getElementById("cv").checked ? 5 : 0,
      }),
    });
    LAST_RESULT = {
      ...result, _source: input.source, _activeThreshold: Number(result.threshold.value), _stale: false,
    };
    clearNewPrediction();
    renderResults(LAST_RESULT);
    setModelActionsEnabled(true);
  } catch (error) {
    clearActiveModel();
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Run model";
  }
}

function setMetric(id, value) {
  document.getElementById(id).textContent =
    value === null || value === undefined ? "n/a" : Number(value).toFixed(3);
}

function renderResults(result) {
  document.getElementById("results").classList.remove("hidden");
  const evaluation = result.evaluation;
  document.getElementById("eval-note").textContent =
    "· " + result.n_samples + " rows; " + evaluation.mode +
    "; train " + evaluation.n_train + ", test " + evaluation.n_test;

  const metrics = result.metrics;
  setMetric("m-acc", metrics.accuracy);
  setMetric("m-auc", metrics.auc);
  setMetric("m-prec", metrics.precision);
  setMetric("m-rec", metrics.recall);

  const warning = document.getElementById("eval-warning");
  if (evaluation.notice) {
    warning.textContent = evaluation.notice;
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
  const gain = metrics.accuracy_gain;
  document.getElementById("quality-note").textContent =
    "Majority-class baseline accuracy: " + metrics.baseline_accuracy.toFixed(3) +
    "; accuracy change at 0.50: " + (gain >= 0 ? "+" : "") + gain.toFixed(3) +
    ". AUC measures ranking and does not depend on the class threshold.";

  const cvNote = document.getElementById("cv-note");
  if (result.cross_validation && result.cross_validation.available) {
    const cv = result.cross_validation;
    cvNote.textContent =
      cv.actual_folds + "-fold training CV (requested " + cv.requested_folds + ") — AUC " +
      cv.auc_mean.toFixed(3) + " ± " + cv.auc_std.toFixed(3) +
      ", accuracy @ 0.50 " + cv.accuracy_mean.toFixed(3) + " ± " + cv.accuracy_std.toFixed(3) + ".";
    cvNote.classList.remove("hidden");
  } else if (result.cross_validation) {
    cvNote.textContent = "Cross-validation unavailable: " + result.cross_validation.reason;
    cvNote.classList.remove("hidden");
  } else {
    cvNote.classList.add("hidden");
  }

  renderCoefficientTable(result.coefficients);
  renderCoefficientChart(result.coefficients);
  renderRoc(result.roc, metrics.auc);
  renderInference(result.inference, result.standardized);

  const threshold = Number(result.threshold.value);
  document.getElementById("threshold").value = threshold;
  document.getElementById("threshold-out").textContent = threshold.toFixed(2);
  document.getElementById("thr-suggest").textContent =
    result.threshold.source === "training_cross_validation"
      ? "Suggested threshold " + threshold.toFixed(2) + " maximises F1 on training-side cross-validation. Test-set slider changes are exploratory."
      : "Using the normal 0.50 threshold because training-side cross-validation was not available.";
  updateConfusion(threshold);
  buildWhatIf(result.feature_names);
}

function renderInference(inference, standardized) {
  const unit = standardized
    ? "Features were standardised, so coefficients represent roughly a one-standard-deviation change."
    : "Features were not standardised, so coefficients represent one original feature unit.";
  const note = document.getElementById("inference-note");
  if (inference.available) {
    note.textContent = inference.method + " " + inference.reason +
      " Odds ratios describe associations while other features are held constant; they do not prove causation. " + unit;
  } else {
    note.textContent = (inference.reason || "P-values are unavailable.") + " " + unit;
  }
}

function makeCell(tag, text, className = "") {
  const cell = document.createElement(tag);
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function formatPValue(value) {
  if (value === null || value === undefined) return "n/a";
  if (value < 0.001) return "<0.001";
  return Number(value).toFixed(3);
}

function renderCoefficientTable(coefficients) {
  const body = document.querySelector("#coef-table tbody");
  body.textContent = "";
  coefficients.forEach((coefficient) => {
    const row = document.createElement("tr");
    if (coefficient.significant) row.className = "sig";
    row.appendChild(makeCell("td", coefficient.name));
    row.appendChild(makeCell("td", (coefficient.coef >= 0 ? "+" : "") + Number(coefficient.coef).toFixed(3), "num"));
    row.appendChild(makeCell("td", Number(coefficient.odds_ratio).toFixed(2), "num"));
    row.appendChild(makeCell("td", formatPValue(coefficient.p_value), "num p"));
    body.appendChild(row);
  });
}

function renderCoefficientChart(coefficients) {
  const features = coefficients.filter((coefficient) => coefficient.name !== "Intercept");
  const values = features.map((coefficient) => coefficient.coef);
  if (coefChart) coefChart.destroy();
  coefChart = new Chart(document.getElementById("coef-chart"), {
    type: "bar",
    data: {
      labels: features.map((coefficient) => coefficient.name),
      datasets: [{ data: values, backgroundColor: values.map((value) => value >= 0 ? "#1d9e75" : "#d85a30") }],
    },
    options: {
      indexAxis: "y", responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { title: { display: true, text: "coefficient (log-odds)" } } },
    },
  });
}

function renderRoc(roc, auc) {
  document.getElementById("auc-inline").textContent =
    auc === null || auc === undefined ? "" : "· AUC " + Number(auc).toFixed(3);
  const points = (roc.fpr || []).map((fpr, index) => ({ x: fpr, y: roc.tpr[index] }));
  if (rocChart) rocChart.destroy();
  rocChart = new Chart(document.getElementById("roc-chart"), {
    type: "line",
    data: {
      datasets: [
        { label: "Model", data: points, borderColor: "#185fa5", backgroundColor: "rgba(24,95,165,.1)", fill: true, stepped: true, pointRadius: 0, borderWidth: 2 },
        { label: "Random", data: [{ x: 0, y: 0 }, { x: 1, y: 1 }], borderColor: "#b4b2a9", borderDash: [5, 4], pointRadius: 0, borderWidth: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } },
      scales: {
        x: { type: "linear", min: 0, max: 1, title: { display: true, text: "false positive rate" } },
        y: { min: 0, max: 1, title: { display: true, text: "true positive rate" } },
      },
    },
  });
}

function updateConfusion(threshold) {
  if (!LAST_RESULT) return;
  LAST_RESULT._activeThreshold = threshold;
  const trueLabels = LAST_RESULT.threshold_data.y_true;
  const probabilities = LAST_RESULT.threshold_data.prob;
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let index = 0; index < trueLabels.length; index += 1) {
    const prediction = classifyProbability(probabilities[index], threshold);
    if (prediction === 1 && trueLabels[index] === 1) tp += 1;
    else if (prediction === 1 && trueLabels[index] === 0) fp += 1;
    else if (prediction === 0 && trueLabels[index] === 1) fn += 1;
    else tn += 1;
  }
  document.getElementById("confusion").innerHTML =
    '<div class="cell head"></div><div class="cell head">Pred 0</div><div class="cell head">Pred 1</div>' +
    '<div class="cell head">Actual 0</div><div class="cell tn"><span class="big">' + tn + '</span>TN</div><div class="cell fp"><span class="big">' + fp + '</span>FP</div>' +
    '<div class="cell head">Actual 1</div><div class="cell fn"><span class="big">' + fn + '</span>FN</div><div class="cell tp"><span class="big">' + tp + '</span>TP</div>';
  const total = tp + tn + fp + fn || 1;
  const accuracy = (tp + tn) / total;
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = 2 * precision * recall / (precision + recall || 1);
  LAST_RESULT._currentThresholdMetrics = {
    threshold, accuracy, precision, recall, f1, confusion: { tn, fp, fn, tp },
  };
  document.getElementById("t-acc").textContent = accuracy.toFixed(3);
  document.getElementById("t-prec").textContent = precision.toFixed(3);
  document.getElementById("t-rec").textContent = recall.toFixed(3);
  document.getElementById("t-f1").textContent = f1.toFixed(3);
}

function buildWhatIf(featureNames) {
  const box = document.getElementById("whatif-inputs");
  box.textContent = "";
  featureNames.forEach((name) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    const input = document.createElement("input");
    caption.textContent = name;
    input.type = "number";
    input.step = "any";
    input.placeholder = "Enter value";
    input.dataset.feature = name;
    label.appendChild(caption);
    label.appendChild(input);
    box.appendChild(label);
  });
  document.getElementById("whatif-result").classList.add("hidden");
}

function readWhatIfRow() {
  return Array.from(document.querySelectorAll("#whatif-inputs input")).map((input) => {
    if (input.value.trim() === "") throw new Error("Enter a value for " + input.dataset.feature + ".");
    const value = Number(input.value);
    if (!Number.isFinite(value)) throw new Error(input.dataset.feature + " must be a finite number.");
    return value;
  });
}

async function runWhatIf() {
  if (!ensureActiveModel()) return;
  try {
    const data = await fetchJson("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: LAST_RESULT.model_id,
        features: [readWhatIfRow()],
        threshold: LAST_RESULT._activeThreshold,
      }),
    });
    const result = data.results[0];
    const classLabel = result.pred === 1 ? data.class_labels.positive : data.class_labels.negative;
    const box = document.getElementById("whatif-result");
    box.textContent = "Probability of " + data.class_labels.positive + ": " +
      (result.prob * 100).toFixed(1) + "%. Predicted class at " +
      data.threshold.toFixed(2) + ": " + classLabel + ".";
    box.classList.remove("hidden");
  } catch (error) {
    showError(error.message);
  }
}

async function sourceStillMatches(source) {
  try {
    return await Excel.run(async (context) => {
      const xRange = getRangeByAddress(context, source.x.address);
      const yRange = getRangeByAddress(context, source.y.address);
      xRange.load("values");
      yRange.load("values");
      await context.sync();
      return valuesFingerprint(xRange.values) === source.x.fingerprint &&
        valuesFingerprint(yRange.values) === source.y.fingerprint;
    });
  } catch {
    return false;
  }
}

async function featureSourceStillMatches(source) {
  try {
    return await Excel.run(async (context) => {
      const range = getRangeByAddress(context, source.address);
      range.load("values");
      await context.sync();
      return valuesFingerprint(range.values) === source.fingerprint;
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

function reportMetadataRows(result) {
  const source = result._source;
  const evaluation = result.evaluation;
  const selected = result._currentThresholdMetrics || result.metrics_at_threshold;
  return [
    ["Logistic Regression Report", ""],
    ["Created", new Date().toISOString()],
    ["Model ID", result.model_id],
    ["Source X", sourceLabel(source.x.sheetName, source.x.address)],
    ["Source Y", sourceLabel(source.y.sheetName, source.y.address)],
    ["Features", result.feature_names.join(", ")],
    ["Class mapping", "0 = " + result.class_labels.negative + "; 1 = " + result.class_labels.positive],
    ["Rows / class balance", result.n_samples + "; positive " + result.class_balance.positive + ", negative " + result.class_balance.negative],
    ["Evaluation", evaluation.mode + "; train " + evaluation.n_train + ", test " + evaluation.n_test],
    ["Source-row prediction note", "This list includes both training and held-out rows; do not use it as a fresh generalisation score."],
    ["Preprocessing", result.standardized ? "Standardised using training-set means and scales" : "Not standardised"],
    ["Regularisation C / class weighting", result.regularisation_C + " / " + (result.class_weight || "none")],
    ["Software", "Python " + result.software.python + "; scikit-learn " + result.software.scikit_learn + "; NumPy " + result.software.numpy + "; SciPy " + result.software.scipy],
    ["Threshold", "Active " + result._activeThreshold.toFixed(2) + "; suggested " + result.threshold.value.toFixed(2) + " from " + result.threshold.source],
    ["0.50 metrics", "Accuracy " + result.metrics.accuracy.toFixed(3) + ", Precision " + result.metrics.precision.toFixed(3) + ", Recall " + result.metrics.recall.toFixed(3) + ", F1 " + result.metrics.f1.toFixed(3) + ", AUC " + formatPValue(result.metrics.auc)],
    ["Selected-threshold metrics", "Accuracy " + selected.accuracy.toFixed(3) + ", Precision " + selected.precision.toFixed(3) + ", Recall " + selected.recall.toFixed(3) + ", F1 " + selected.f1.toFixed(3)],
    ["Cross-validation", result.cross_validation && result.cross_validation.available ? result.cross_validation.actual_folds + "-fold training CV" : (result.cross_validation && result.cross_validation.reason) || "Disabled"],
    ["Inference", result.inference.reason || "Unavailable"],
  ];
}

async function writePredictions() {
  if (!ensureActiveModel()) return;
  const button = document.getElementById("writeback-btn");
  button.disabled = true;
  try {
    if (!await sourceStillMatches(LAST_RESULT._source)) {
      markRunStale();
      throw new Error("The training data changed after this model ran. Train again before exporting.");
    }
    await Excel.run(async (context) => {
      const sheet = await addUniqueWorksheet(context, "LR Report");
      const metadata = reportMetadataRows(LAST_RESULT);
      sheet.getRangeByIndexes(0, 0, metadata.length, 2).values = metadata;
      sheet.getRangeByIndexes(0, 0, 1, 2).format.font.bold = true;
      sheet.getRangeByIndexes(0, 0, metadata.length, 1).format.font.bold = true;

      const coefficientStart = metadata.length + 2;
      const coefficientRows = [
        ["Coefficient", "Log-odds", "Odds ratio", "Std. error", "z", "p-value"],
        ...LAST_RESULT.coefficients.map((coefficient) => [
          coefficient.name, coefficient.coef, coefficient.odds_ratio,
          coefficient.std_error ?? "", coefficient.z ?? "", coefficient.p_value ?? "",
        ]),
      ];
      sheet.getRangeByIndexes(coefficientStart, 0, coefficientRows.length, 6).values = coefficientRows;
      sheet.getRangeByIndexes(coefficientStart, 0, 1, 6).format.font.bold = true;

      const scalingRows = LAST_RESULT.preprocessing.standardized
        ? [
          ["Feature scaling fitted on training rows", "Mean", "Scale"],
          ...LAST_RESULT.feature_names.map((name, index) => [
            name,
            LAST_RESULT.preprocessing.feature_means[index],
            LAST_RESULT.preprocessing.feature_scales[index],
          ]),
        ]
        : [];
      const scalingStart = coefficientStart + coefficientRows.length + 2;
      if (scalingRows.length) {
        sheet.getRangeByIndexes(scalingStart, 0, scalingRows.length, 3).values = scalingRows;
        sheet.getRangeByIndexes(scalingStart, 0, 1, 3).format.font.bold = true;
      }

      const predictionStart = scalingRows.length
        ? scalingStart + scalingRows.length + 2
        : coefficientStart + coefficientRows.length + 2;
      const source = LAST_RESULT._source;
      const probabilities = LAST_RESULT.predictions.prob;
      const threshold = LAST_RESULT._activeThreshold;
      const predictionRows = [
        ["Source row", "Probability", "Predicted code", "Predicted label"],
        ...probabilities.map((probability, index) => {
          const prediction = classifyProbability(probability, threshold);
          return [
            source.firstDataRow + index, probability, prediction,
            prediction === 1 ? LAST_RESULT.class_labels.positive : LAST_RESULT.class_labels.negative,
          ];
        }),
      ];
      sheet.getRangeByIndexes(predictionStart, 0, predictionRows.length, 4).values = predictionRows;
      sheet.getRangeByIndexes(predictionStart, 0, 1, 4).format.font.bold = true;
      sheet.getRangeByIndexes(predictionStart + 1, 1, predictionRows.length - 1, 1).numberFormat =
        Array.from({ length: predictionRows.length - 1 }, () => ["0.000000"]);
      sheet.getUsedRange().format.autofitColumns();
      sheet.freezePanes.freezeRows(1);
      sheet.activate();
      await context.sync();
    });
    flash("writeback-btn", "Report exported ✓");
  } catch (error) {
    showError("Export failed: " + error.message);
  } finally {
    button.disabled = !LAST_RESULT || LAST_RESULT._stale;
  }
}

async function readNewFeatureData(address, hasHeader, expectedFeatures) {
  let values;
  let meta;
  await Excel.run(async (context) => {
    const range = getRangeByAddress(context, address);
    range.load("values,address,rowIndex,columnIndex,rowCount,columnCount");
    range.worksheet.load("name");
    await context.sync();
    values = range.values;
    meta = {
      address: range.address, sheetName: range.worksheet.name,
      rowIndex: range.rowIndex, columnIndex: range.columnIndex,
      rowCount: range.rowCount, columnCount: range.columnCount,
    };
  });
  if (!values.length) throw new Error("The new-row range is empty.");
  let rows = values;
  let firstDataRow = meta.rowIndex + 1;
  if (hasHeader) {
    if (values.length < 2) throw new Error("New rows need a header and at least one data row.");
    const headers = validateHeaderRow(values[0]);
    if (headers.length !== expectedFeatures.length || headers.some((header, index) => header !== expectedFeatures[index])) {
      throw new Error("New-row headers must exactly match the trained order: " + expectedFeatures.join(", ") + ".");
    }
    rows = values.slice(1);
    firstDataRow += 1;
  } else if (meta.columnCount !== expectedFeatures.length) {
    throw new Error("New rows need exactly " + expectedFeatures.length + " columns in this order: " + expectedFeatures.join(", ") + ".");
  }
  const numeric = validateNumericRows(rows, expectedFeatures, firstDataRow);
  return {
    features: numeric.features,
    source: { ...meta, fingerprint: valuesFingerprint(values), hasHeader, firstDataRow },
  };
}

async function scoreNewRows() {
  if (!ensureActiveModel()) return;
  const address = document.getElementById("new-x-range").value;
  if (!address) {
    showError("Select a feature range for the new rows.");
    return;
  }
  const button = document.getElementById("score-new-btn");
  button.disabled = true;
  button.textContent = "Scoring…";
  try {
    const newRows = await readNewFeatureData(
      address, document.getElementById("new-has-header").checked, LAST_RESULT.feature_names
    );
    const data = await fetchJson("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model_id: LAST_RESULT.model_id, features: newRows.features, threshold: LAST_RESULT._activeThreshold,
      }),
    });
    LAST_NEW_PREDICTION = { ...data, _source: newRows.source };
    document.getElementById("new-score-note").textContent =
      data.results.length + " rows scored at threshold " + data.threshold.toFixed(2) + ". Export is ready.";
    document.getElementById("export-new-btn").classList.remove("hidden");
    document.getElementById("export-new-btn").disabled = false;
  } catch (error) {
    clearNewPrediction();
    showError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Score new rows";
  }
}

async function exportNewPredictions() {
  if (!LAST_NEW_PREDICTION || !ensureActiveModel()) return;
  const button = document.getElementById("export-new-btn");
  button.disabled = true;
  try {
    if (!await featureSourceStillMatches(LAST_NEW_PREDICTION._source)) {
      clearNewPrediction();
      throw new Error("The new-row data changed after scoring. Score it again before exporting.");
    }
    await Excel.run(async (context) => {
      const sheet = await addUniqueWorksheet(context, "LR New Scores");
      const source = LAST_NEW_PREDICTION._source;
      const metadata = [
        ["Logistic Regression New-row Predictions", ""],
        ["Created", new Date().toISOString()],
        ["Model ID", LAST_NEW_PREDICTION.model_id],
        ["Source", sourceLabel(source.sheetName, source.address)],
        ["Feature order", LAST_NEW_PREDICTION.feature_names.join(", ")],
        ["Threshold", LAST_NEW_PREDICTION.threshold.toFixed(2)],
        ["Class mapping", "0 = " + LAST_NEW_PREDICTION.class_labels.negative + "; 1 = " + LAST_NEW_PREDICTION.class_labels.positive],
      ];
      sheet.getRangeByIndexes(0, 0, metadata.length, 2).values = metadata;
      sheet.getRangeByIndexes(0, 0, 1, 2).format.font.bold = true;
      sheet.getRangeByIndexes(0, 0, metadata.length, 1).format.font.bold = true;
      const start = metadata.length + 2;
      const rows = [
        ["Source row", "Probability", "Predicted code", "Predicted label"],
        ...LAST_NEW_PREDICTION.results.map((result, index) => [
          source.firstDataRow + index, result.prob, result.pred,
          result.pred === 1 ? LAST_NEW_PREDICTION.class_labels.positive : LAST_NEW_PREDICTION.class_labels.negative,
        ]),
      ];
      sheet.getRangeByIndexes(start, 0, rows.length, 4).values = rows;
      sheet.getRangeByIndexes(start, 0, 1, 4).format.font.bold = true;
      sheet.getRangeByIndexes(start + 1, 1, rows.length - 1, 1).numberFormat =
        Array.from({ length: rows.length - 1 }, () => ["0.000000"]);
      sheet.getUsedRange().format.autofitColumns();
      sheet.freezePanes.freezeRows(1);
      sheet.activate();
      await context.sync();
    });
    flash("export-new-btn", "Predictions exported ✓");
  } catch (error) {
    showError("New-row export failed: " + error.message);
  } finally {
    button.disabled = !LAST_NEW_PREDICTION || !LAST_RESULT || LAST_RESULT._stale;
  }
}

function ensureActiveModel() {
  if (!LAST_RESULT) {
    showError("Train a model first.");
    return false;
  }
  if (LAST_RESULT._stale) {
    showError("The selected data or settings changed. Train again before predicting or exporting.");
    return false;
  }
  return true;
}

function setModelActionsEnabled(enabled) {
  document.getElementById("writeback-btn").disabled = !enabled;
  document.getElementById("whatif-btn").disabled = !enabled;
  document.getElementById("score-new-btn").disabled = !enabled;
}

function markRunStale() {
  if (!LAST_RESULT || LAST_RESULT._stale) return;
  LAST_RESULT._stale = true;
  setModelActionsEnabled(false);
  clearNewPrediction();
  const warning = document.getElementById("eval-warning");
  warning.textContent = "Selections or model settings changed. Train again before predicting or exporting.";
  warning.classList.remove("hidden");
}

function clearActiveModel(message = "") {
  LAST_RESULT = null;
  setModelActionsEnabled(false);
  clearNewPrediction();
  if (message) {
    const warning = document.getElementById("eval-warning");
    warning.textContent = message;
    warning.classList.remove("hidden");
  }
}

function clearNewPrediction() {
  LAST_NEW_PREDICTION = null;
  const button = document.getElementById("export-new-btn");
  button.classList.add("hidden");
  button.disabled = true;
  document.getElementById("new-score-note").textContent = "";
}

function showError(message) {
  const toast = document.getElementById("error-toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 6000);
}

function flash(buttonId, text) {
  const button = document.getElementById(buttonId);
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1800);
}
