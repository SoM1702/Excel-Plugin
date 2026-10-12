const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function element(id, type = "button") {
  return {
    id,
    tagName: type === "button" ? "BUTTON" : "INPUT",
    type,
    value: "",
    textContent: "",
    className: "",
    dataset: {},
    disabled: false,
    listeners: {},
    classList: { add() {}, remove() {} },
    addEventListener(event, listener) {
      this.listeners[event] = this.listeners[event] || [];
      this.listeners[event].push(listener);
    },
  };
}

function bootTaskPane() {
  const ids = [
    "run-btn", "writeback-btn", "whatif-btn", "score-new-btn", "export-new-btn",
    "test-size", "test-size-out", "threshold", "threshold-out", "backend-url",
    "save-url", "backend-status", "y-range", "x-range", "has-header", "standardize",
    "reg-c", "balance", "cv", "new-x-range", "new-has-header", "new-score-note",
    "eval-warning", "error-toast", "t-acc", "t-prec", "t-rec", "t-f1", "confusion",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, element(id)]));
  elements["test-size"].type = "range";
  elements.threshold.type = "range";
  elements["backend-url"].type = "text";
  elements["y-range"].type = "text";
  elements["x-range"].type = "text";
  elements["new-x-range"].type = "text";
  elements["has-header"].type = "checkbox";
  elements.standardize.type = "checkbox";
  elements.balance.type = "checkbox";
  elements.cv.type = "checkbox";
  elements["new-has-header"].type = "checkbox";
  const rangePick = element("range-pick");
  rangePick.dataset.target = "x-range";

  const document = {
    getElementById(id) {
      return elements[id];
    },
    querySelectorAll(selector) {
      if (selector === "button[data-target]") return [rangePick];
      return [];
    },
  };
  const context = {
    AbortController,
    Chart() {},
    Excel: { run: async () => {} },
    Office: {
      HostType: { Excel: "Excel" },
      onReady(listener) { listener({ host: "Excel" }); },
    },
    clearTimeout,
    console,
    document,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: "ok" }) }),
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout,
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "taskpane", "taskpane.js"), "utf8");
  vm.runInContext(source, context);
  return { context, elements, rangePick };
}

test("backend Save binds only its own action", () => {
  const { elements, rangePick } = bootTaskPane();
  assert.equal(elements["save-url"].listeners.click.length, 1);
  assert.equal(rangePick.listeners.click.length, 1);
});

test("selected threshold drives live classification metrics", () => {
  const { context, elements } = bootTaskPane();
  vm.runInContext(
    "LAST_RESULT = { _stale: false, threshold_data: { y_true: [1, 0], prob: [0.4, 0.2] } }; updateConfusion(0.3);",
    context
  );
  assert.equal(elements["t-acc"].textContent, "1.000");
  assert.equal(elements["t-prec"].textContent, "1.000");
  assert.equal(elements["t-rec"].textContent, "1.000");
  assert.equal(vm.runInContext("LAST_RESULT._activeThreshold", context), 0.3);
  assert.equal(vm.runInContext("LAST_RESULT._currentThresholdMetrics.confusion.tp", context), 1);
  assert.equal(vm.runInContext("classifyProbability(0.4, 0.3)", context), 1);
  assert.equal(vm.runInContext("classifyProbability(0.4, 0.5)", context), 0);
});
