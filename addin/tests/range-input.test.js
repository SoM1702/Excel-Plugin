const assert = require("node:assert/strict");
const test = require("node:test");
const {
  parseInputQualifier,
  isA1Address,
  formatAbsoluteAddress,
  deepEqualValues,
  checkNamedRangeRequirementSupport,
  formatDescriptorSummary,
  resolveRangeInput,
  verifySourceDescriptor,
} = require("../src/taskpane/range-input.js");

function createMockRange({
  address = "Sheet1!$A$1:$B$2",
  values = [[1, 2], [3, 4]],
  rowIndex = 0,
  columnIndex = 0,
  rowCount = 2,
  columnCount = 2,
  sheetId = "{sheet-1}",
  sheetName = "Sheet1",
} = {}) {
  const range = {
    address,
    values,
    rowIndex,
    columnIndex,
    rowCount,
    columnCount,
    worksheet: {
      id: sheetId,
      name: sheetName,
      load() {},
    },
    load() {},
  };
  return range;
}

function createMockNamedItem({
  name = "MyName",
  type = "Range",
  scope = "Workbook",
  range = null,
} = {}) {
  return {
    name,
    type,
    scope,
    isNullObject: false,
    load() {},
    getRange() {
      if (type !== "Range") throw new Error("Named item is not a range");
      return range || createMockRange();
    },
  };
}

function createMockContext({
  sheets = {},
  workbookNames = {},
  activeSheetName = "Sheet1",
} = {}) {
  const worksheetObjects = {};

  for (const [name, config] of Object.entries(sheets)) {
    const localNames = config.names || {};
    const ranges = config.ranges || {};

    worksheetObjects[name] = {
      id: config.id || `{id-${name}}`,
      name,
      isNullObject: false,
      load() {},
      names: {
        getItemOrNullObject(itemName) {
          const lower = itemName.toLowerCase();
          const matchKey = Object.keys(localNames).find((k) => k.toLowerCase() === lower);
          if (matchKey) {
            return localNames[matchKey];
          }
          return { isNullObject: true, load() {} };
        },
      },
      getRange(addr) {
        if (ranges[addr]) return ranges[addr];
        // Default range generator if address not explicitly mocked
        return createMockRange({
          address: `${name}!$${addr.replace(/:/g, ":$")}`,
          values: [[10, 20]],
          rowCount: 1,
          columnCount: 2,
          sheetId: config.id || `{id-${name}}`,
          sheetName: name,
        });
      },
    };
  }

  const worksheetsList = Object.values(worksheetObjects);

  const context = {
    workbook: {
      worksheets: {
        items: worksheetsList,
        load() {},
        getActiveWorksheet() {
          return worksheetObjects[activeSheetName];
        },
        getItemOrNullObject(name) {
          if (worksheetObjects[name]) return worksheetObjects[name];
          return { isNullObject: true, load() {} };
        },
      },
      names: {
        getItemOrNullObject(itemName) {
          const lower = itemName.toLowerCase();
          const matchKey = Object.keys(workbookNames).find((k) => k.toLowerCase() === lower);
          if (matchKey) {
            return workbookNames[matchKey];
          }
          return { isNullObject: true, load() {} };
        },
      },
    },
    sync: async () => {},
  };

  return { context, worksheetObjects };
}

test("parseInputQualifier parses unqualified, unquoted and single-quoted qualifiers", () => {
  assert.deepEqual(parseInputQualifier("A1:B10"), { sheetName: null, rest: "A1:B10" });
  assert.deepEqual(parseInputQualifier("  CustomerFeatures  "), { sheetName: null, rest: "CustomerFeatures" });
  assert.deepEqual(parseInputQualifier("Sheet1!A1:B10"), { sheetName: "Sheet1", rest: "A1:B10" });
  assert.deepEqual(parseInputQualifier("'Customer Data'!LocalFeatures"), {
    sheetName: "Customer Data",
    rest: "LocalFeatures",
  });
  assert.deepEqual(parseInputQualifier("'John''s Data'!A1:B10"), {
    sheetName: "John's Data",
    rest: "A1:B10",
  });
});

test("isA1Address distinguishes cell addresses from defined names", () => {
  assert.equal(isA1Address("A1:I401"), true);
  assert.equal(isA1Address("$A$1:$I$401"), true);
  assert.equal(isA1Address("A1"), true);
  assert.equal(isA1Address("$J$1"), true);
  assert.equal(isA1Address("XFD1048576"), true);
  assert.equal(isA1Address("CustomerFeatures"), false);
  assert.equal(isA1Address("Matrix"), false);
  assert.equal(isA1Address("LocalFeatures"), false);
});

test("formatAbsoluteAddress formats sheet name and dollar signs", () => {
  assert.equal(formatAbsoluteAddress("churn_data", "A1:I401"), "churn_data!$A$1:$I$401");
  assert.equal(formatAbsoluteAddress("Customer Data", "A1:B2"), "'Customer Data'!$A$1:$B$2");
  assert.equal(formatAbsoluteAddress("Sheet1", "Sheet1!$A$1:$B$2"), "Sheet1!$A$1:$B$2");
});

test("deepEqualValues checks 2D array equality", () => {
  assert.equal(deepEqualValues([[1, 2], [3, 4]], [[1, 2], [3, 4]]), true);
  assert.equal(deepEqualValues([[1, 2]], [[1, 3]]), false);
  assert.equal(deepEqualValues([[1, 2]], [[1]]), false);
  assert.equal(deepEqualValues([[1]], [[1], [2]]), false);
});

test("resolveRangeInput resolves unqualified and qualified A1 addresses", async () => {
  const rangeA = createMockRange({
    address: "Sheet1!$A$1:$B$10",
    values: Array.from({ length: 10 }, (_, i) => [i, i * 2]),
    rowCount: 10,
    columnCount: 2,
    sheetName: "Sheet1",
  });
  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1", ranges: { "A1:B10": rangeA } },
    },
    activeSheetName: "Sheet1",
  });

  const res = await resolveRangeInput(context, "A1:B10", { fieldName: "X" });
  assert.equal(res.descriptor.kind, "address");
  assert.equal(res.descriptor.resolvedWorksheetName, "Sheet1");
  assert.equal(res.descriptor.rowCount, 10);
  assert.equal(res.descriptor.columnCount, 2);
  assert.equal(res.descriptor.absoluteAddress, "Sheet1!$A$1:$B$10");
});

test("resolveRangeInput resolves workbook-scoped defined names even if another worksheet is active", async () => {
  const rangeFeat = createMockRange({
    address: "DataSheet!$A$1:$I$401",
    values: Array.from({ length: 401 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    rowCount: 401,
    columnCount: 9,
    sheetId: "s-data",
    sheetName: "DataSheet",
  });

  const { context } = createMockContext({
    sheets: {
      Sheet2: { id: "s2" },
      DataSheet: { id: "s-data" },
    },
    workbookNames: {
      CustomerFeatures: createMockNamedItem({
        name: "CustomerFeatures",
        scope: "Workbook",
        range: rangeFeat,
      }),
    },
    activeSheetName: "Sheet2", // Sheet2 is active, but name points to DataSheet
  });

  const res = await resolveRangeInput(context, "CustomerFeatures", { fieldName: "X" });
  assert.equal(res.descriptor.kind, "name");
  assert.equal(res.descriptor.canonicalName, "CustomerFeatures");
  assert.equal(res.descriptor.scope, "Workbook");
  assert.equal(res.descriptor.resolvedWorksheetName, "DataSheet");
  assert.equal(res.descriptor.rowCount, 401);
  assert.equal(res.descriptor.columnCount, 9);
});

test("resolveRangeInput gives active worksheet local name precedence over workbook name (shadowing)", async () => {
  const localRange = createMockRange({
    address: "Sheet1!$B$1:$C$10",
    values: Array.from({ length: 10 }, () => [10, 20]),
    rowCount: 10,
    columnCount: 2,
    sheetId: "s1",
    sheetName: "Sheet1",
  });
  const wbRange = createMockRange({
    address: "Sheet2!$A$1:$B$10",
    values: Array.from({ length: 10 }, () => [1, 2]),
    rowCount: 10,
    columnCount: 2,
    sheetId: "s2",
    sheetName: "Sheet2",
  });

  const { context } = createMockContext({
    sheets: {
      Sheet1: {
        id: "s1",
        names: {
          SharedName: createMockNamedItem({ name: "SharedName", scope: "Worksheet", range: localRange }),
        },
      },
      Sheet2: { id: "s2" },
    },
    workbookNames: {
      SharedName: createMockNamedItem({ name: "SharedName", scope: "Workbook", range: wbRange }),
    },
    activeSheetName: "Sheet1",
  });

  const res = await resolveRangeInput(context, "SharedName", { fieldName: "X" });
  assert.equal(res.descriptor.scope, "Worksheet");
  assert.equal(res.descriptor.canonicalName, "SharedName");
  assert.equal(res.descriptor.resolvedWorksheetName, "Sheet1");
});

test("resolveRangeInput resolves explicit qualified local name", async () => {
  const localRange = createMockRange({
    address: "Sheet2!$A$1:$D$5",
    values: Array.from({ length: 5 }, () => [1, 2, 3, 4]),
    rowCount: 5,
    columnCount: 4,
    sheetId: "s2",
    sheetName: "Sheet2",
  });

  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1" },
      Sheet2: {
        id: "s2",
        names: {
          LocalFeat: createMockNamedItem({ name: "LocalFeat", scope: "Worksheet", range: localRange }),
        },
      },
    },
    activeSheetName: "Sheet1",
  });

  const res = await resolveRangeInput(context, "Sheet2!LocalFeat", { fieldName: "X" });
  assert.equal(res.descriptor.kind, "name");
  assert.equal(res.descriptor.canonicalName, "LocalFeat");
  assert.equal(res.descriptor.scope, "Worksheet");
  assert.equal(res.descriptor.resolvedWorksheetName, "Sheet2");
});

test("resolveRangeInput resolves case-insensitively according to Excel rules", async () => {
  const range = createMockRange({
    address: "Sheet1!$A$1:$A$10",
    values: Array.from({ length: 10 }, () => [1]),
    rowCount: 10,
    columnCount: 1,
    sheetName: "Sheet1",
  });

  const { context } = createMockContext({
    sheets: { Sheet1: { id: "s1" } },
    workbookNames: {
      ChurnOutcome: createMockNamedItem({ name: "ChurnOutcome", scope: "Workbook", range }),
    },
    activeSheetName: "Sheet1",
  });

  const res = await resolveRangeInput(context, "churnoutcome", { fieldName: "Y" });
  assert.equal(res.descriptor.canonicalName, "ChurnOutcome");
  assert.equal(res.descriptor.kind, "name");
});

test("resolveRangeInput suggests qualifier when unqualified name exists on another sheet", async () => {
  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1" },
      Sheet2: {
        id: "s2",
        names: {
          OtherFeat: createMockNamedItem({ name: "OtherFeat", scope: "Worksheet" }),
        },
      },
    },
    workbookNames: {},
    activeSheetName: "Sheet1",
  });

  await assert.rejects(
    () => resolveRangeInput(context, "OtherFeat", { fieldName: "X" }),
    /It is defined locally on worksheet "Sheet2"; qualify it as "'Sheet2'!OtherFeat"/
  );
});

test("resolveRangeInput rejects unsupported inputs: unions, external refs, formulas, literals", async () => {
  const { context } = createMockContext({
    sheets: { Sheet1: { id: "s1" } },
    activeSheetName: "Sheet1",
  });

  await assert.rejects(
    () => resolveRangeInput(context, "Sheet1!A1:B10,Sheet1!C1:D10", { fieldName: "X" }),
    /Range unions with multiple areas are not supported for X/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "[Budget.xlsx]Sheet1!A1:B10", { fieldName: "X" }),
    /External workbook references are not supported for X/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "=OFFSET(A1,0,0,10,2)", { fieldName: "X" }),
    /Formulas cannot be typed directly as inputs for X/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "{1, 2, 3}", { fieldName: "X" }),
    /Array literals are not supported for X/
  );
});

test("resolveRangeInput rejects named constants, scalar formulas, and broken references (#REF!)", async () => {
  const { context } = createMockContext({
    sheets: { Sheet1: { id: "s1" } },
    workbookNames: {
      ConstantRate: createMockNamedItem({ name: "ConstantRate", type: "Double" }),
      BrokenRef: createMockNamedItem({ name: "BrokenRef", type: "Error" }),
      ArrayConst: createMockNamedItem({ name: "ArrayConst", type: "Array" }),
    },
    activeSheetName: "Sheet1",
  });

  await assert.rejects(
    () => resolveRangeInput(context, "ConstantRate", { fieldName: "X" }),
    /refers to a named constant or scalar formula, not a worksheet range/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "BrokenRef", { fieldName: "X" }),
    /has a broken reference \(#REF!\)/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "ArrayConst", { fieldName: "X" }),
    /refers to an array constant, not a worksheet range/
  );
});

test("verifySourceDescriptor re-verifies valid snapshot and detects alterations", async () => {
  const range = createMockRange({
    address: "Data!$A$1:$B$2",
    values: [[1, 2], [3, 4]],
    rowCount: 2,
    columnCount: 2,
    sheetId: "s-data",
    sheetName: "Data",
  });

  const namedItem = createMockNamedItem({
    name: "CustomerFeatures",
    scope: "Workbook",
    range,
  });

  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1" },
      Data: { id: "s-data" },
    },
    workbookNames: { CustomerFeatures: namedItem },
    activeSheetName: "Sheet1", // active sheet is Sheet1, but descriptor points to Data
  });

  const { descriptor } = await resolveRangeInput(context, "CustomerFeatures", { fieldName: "X" });

  // 1. Snapshot matches originally
  assert.equal(await verifySourceDescriptor(context, descriptor), true);

  // 2. Switching active sheet does not affect verification
  context.workbook.worksheets.getActiveWorksheet = () => context.workbook.worksheets.getItemOrNullObject("Sheet1");
  assert.equal(await verifySourceDescriptor(context, descriptor), true);

  // 3. Values edited in Excel
  range.values = [[999, 2], [3, 4]];
  assert.equal(await verifySourceDescriptor(context, descriptor), false);
  range.values = [[1, 2], [3, 4]]; // restore

  // 4. Range resized / retargeted
  range.rowCount = 3;
  assert.equal(await verifySourceDescriptor(context, descriptor), false);
  range.rowCount = 2; // restore

  // 5. Name deleted
  delete context.workbook.names;
  assert.equal(await verifySourceDescriptor(context, descriptor), false);
});

test("resolveRangeInput supports single-quoted worksheet qualifiers containing commas without union error", async () => {
  const range = createMockRange({
    address: "'Sales, 2026'!$A$1:$B$2",
    sheetName: "Sales, 2026",
    sheetId: "s-comma",
  });
  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1" },
      "Sales, 2026": { id: "s-comma", ranges: { "A1:B2": range } },
    },
    activeSheetName: "Sheet1",
  });

  const res = await resolveRangeInput(context, "'Sales, 2026'!A1:B2", { fieldName: "X" });
  assert.equal(res.descriptor.resolvedWorksheetName, "Sales, 2026");
  assert.equal(res.descriptor.absoluteAddress, "'Sales, 2026'!$A$1:$B$2");
});

test("resolveRangeInput rejects selections exceeding maximum cell limits", async () => {
  const largeRange = createMockRange({
    rowCount: 1000,
    columnCount: 600, // 600,000 cells > 500,000
    values: Array.from({ length: 1000 }, () => Array(600).fill(1)),
  });
  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1", ranges: { "A1:ZZ1000": largeRange } },
    },
  });

  await assert.rejects(
    () => resolveRangeInput(context, "A1:ZZ1000", { fieldName: "LargeX" }),
    /Selection for LargeX contains 600,000 cells, which exceeds the supported limit/
  );
});

test("resolveRangeInput falls back to worksheet.getRange when named item getRange is unsupported on host", async () => {
  const fallbackRange = createMockRange({
    address: "Sheet1!$A$1:$B$2",
    sheetName: "Sheet1",
  });
  let fallbackCalled = false;
  const namedItemWithThrowingGetRange = {
    name: "LocalFeats",
    type: "Range",
    scope: "Worksheet",
    isNullObject: false,
    load() {},
    getRange() {
      throw new Error("getRange is only supported for Workbook-scoped items on this host.");
    },
  };

  const { context } = createMockContext({
    sheets: {
      Sheet1: {
        id: "s1",
        names: { LocalFeats: namedItemWithThrowingGetRange },
        ranges: {},
      },
    },
    activeSheetName: "Sheet1",
  });

  const sheet = context.workbook.worksheets.getItemOrNullObject("Sheet1");
  sheet.getRange = (name) => {
    if (name === "LocalFeats") {
      fallbackCalled = true;
      return fallbackRange;
    }
    throw new Error("Unknown name: " + name);
  };

  const res = await resolveRangeInput(context, "LocalFeats", { fieldName: "Features" });
  assert.equal(fallbackCalled, true);
  assert.equal(res.descriptor.canonicalName, "LocalFeats");
});

test("resolveRangeInput preflights dimensions and never requests values for oversized ranges (>500,000 cells)", async () => {
  const loadedProps = [];
  const oversizedRange = {
    address: "Sheet1!$A$1:$ZZ$1000",
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 1000,
    columnCount: 600, // 600,000 cells
    values: [[1]],
    worksheet: { id: "s1", name: "Sheet1", load() {} },
    load(props) {
      loadedProps.push(props);
    },
  };

  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1", ranges: { "A1:ZZ1000": oversizedRange } },
    },
  });

  await assert.rejects(
    () => resolveRangeInput(context, "A1:ZZ1000", { fieldName: "LargeX" }),
    /exceeds the supported limit of 500,000 cells/
  );

  // Assert values was NEVER requested
  assert.equal(loadedProps.some((p) => p.includes("values")), false);
  assert.equal(loadedProps.some((p) => p.includes("rowCount")), true);
});

test("resolveRangeInput handles boundary cell limits (500,000 cells accepted, 500,001 cells rejected)", async () => {
  const atLimitRange = {
    address: "Sheet1!$A$1:$ZZ$500",
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 1000,
    columnCount: 500, // 500,000 cells exactly
    values: [[1, 2]],
    worksheet: { id: "s1", name: "Sheet1", load() {} },
    load() {},
  };
  const overLimitRange = {
    address: "Sheet1!$A$1:$ZZ$501",
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 1000,
    columnCount: 501, // 501,000 cells
    values: [[1, 2]],
    worksheet: { id: "s1", name: "Sheet1", load() {} },
    load() {},
  };

  const { context } = createMockContext({
    sheets: {
      Sheet1: {
        id: "s1",
        ranges: {
          "A1:ZZ500": atLimitRange,
          "A1:ZZ501": overLimitRange,
        },
      },
    },
  });

  const res = await resolveRangeInput(context, "A1:ZZ500", { fieldName: "LimitX" });
  assert.equal(res.descriptor.rowCount, 1000);
  assert.equal(res.descriptor.columnCount, 500);

  await assert.rejects(
    () => resolveRangeInput(context, "A1:ZZ501", { fieldName: "OverLimitX" }),
    /501,000 cells, which exceeds the supported limit/
  );
});

test("verifySourceDescriptor preflights dimensions and returns false without loading values when retargeted to oversized range", async () => {
  const descriptor = {
    originalText: "Sheet1!A1:B2",
    kind: "address",
    resolvedWorksheetId: "s1",
    resolvedWorksheetName: "Sheet1",
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 2,
    columnCount: 2,
    values: [[1, 2], [3, 4]],
  };

  const loadedProps = [];
  const retargetedRange = {
    address: "Sheet1!$A$1:$ZZ$1000",
    rowIndex: 0,
    columnIndex: 0,
    rowCount: 1000,
    columnCount: 600, // 600,000 cells
    values: [[1]],
    worksheet: { id: "s1", name: "Sheet1", load() {} },
    load(props) {
      loadedProps.push(props);
    },
  };

  const { context } = createMockContext({
    sheets: {
      Sheet1: { id: "s1", ranges: { "A1:B2": retargetedRange } },
    },
  });

  const matches = await verifySourceDescriptor(context, descriptor);
  assert.equal(matches, false);
  // Values must NOT be loaded for preflight failure
  assert.equal(loadedProps.some((p) => p.includes("values")), false);
});

test("resolveRangeInput falls back to worksheet.getRange when item.getRange() queues an error on sync", async () => {
  let failingRangeSynced = false;
  let fallbackCalled = false;
  let failingRangeBeingLoaded = false;
  const failingRange = {
    address: "Sheet1!$A$1:$B$2",
    worksheet: { id: "s1", name: "Sheet1", load() {} },
    load() {
      failingRangeBeingLoaded = true;
    },
  };
  const healthyFallbackRange = createMockRange({
    address: "Sheet1!$A$1:$B$2",
    sheetName: "Sheet1",
    values: [[42, 43]],
  });

  const namedItem = {
    name: "LocalFeatsQueuedErr",
    type: "Range",
    scope: "Worksheet",
    isNullObject: false,
    load() {},
    getRange() {
      return failingRange;
    },
  };

  const { context } = createMockContext({
    sheets: {
      Sheet1: {
        id: "s1",
        names: { LocalFeatsQueuedErr: namedItem },
      },
    },
    activeSheetName: "Sheet1",
  });

  const origSync = context.sync;
  context.sync = async () => {
    if (failingRangeBeingLoaded && !failingRangeSynced) {
      failingRangeSynced = true;
      throw new Error("Queued host error: NamedItem.getRange is not supported on this worksheet scope.");
    }
    return origSync();
  };

  const sheet = context.workbook.worksheets.getItemOrNullObject("Sheet1");
  sheet.getRange = (name) => {
    if (name === "LocalFeatsQueuedErr") {
      fallbackCalled = true;
      return healthyFallbackRange;
    }
    throw new Error("Unknown name: " + name);
  };

  const res = await resolveRangeInput(context, "LocalFeatsQueuedErr", { fieldName: "QueuedFallbackTest" });
  assert.equal(fallbackCalled, true);
  assert.deepEqual(res.descriptor.values, [[42, 43]]);
});

test("resolveRangeInput rejects named items of type Array, Error, or non-Range before reading range", async () => {
  const arrayItem = createMockNamedItem({ name: "ArrayConstant", type: "Array" });
  const errorItem = createMockNamedItem({ name: "BrokenRef", type: "Error" });
  const stringItem = createMockNamedItem({ name: "ScalarConst", type: "String" });

  const { context } = createMockContext({
    sheets: { Sheet1: { id: "s1" } },
    workbookNames: {
      ArrayConstant: arrayItem,
      BrokenRef: errorItem,
      ScalarConst: stringItem,
    },
  });

  await assert.rejects(
    () => resolveRangeInput(context, "ArrayConstant", { fieldName: "Arr" }),
    /refers to an array constant/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "BrokenRef", { fieldName: "Err" }),
    /has a broken reference \(#REF!\)/
  );
  await assert.rejects(
    () => resolveRangeInput(context, "ScalarConst", { fieldName: "Str" }),
    /refers to a named constant or scalar formula/
  );
});


