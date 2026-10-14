/*
 * Excel Range Input Resolver
 *
 * Implements deterministic resolution for cell addresses (qualified, unqualified,
 * absolute, relative) and Excel defined named ranges (Workbook scope, active
 * Worksheet scope, explicit Sheet!Name scope) according to NAMED_RANGE_IMPLEMENTATION_PLAN.md.
 */

function parseInputQualifier(rawInput) {
  const input = (rawInput || "").trim();
  if (!input) return { sheetName: null, rest: "" };

  if (input.startsWith("'")) {
    let i = 1;
    let sheetName = "";
    while (i < input.length) {
      if (input[i] === "'") {
        if (i + 1 < input.length && input[i + 1] === "'") {
          sheetName += "'";
          i += 2;
        } else if (i + 1 < input.length && input[i + 1] === "!") {
          const rest = input.slice(i + 2).trim();
          return { sheetName, rest };
        } else {
          break;
        }
      } else {
        sheetName += input[i];
        i += 1;
      }
    }
  }

  const bangIdx = input.indexOf("!");
  if (bangIdx !== -1) {
    const sheetName = input.slice(0, bangIdx).trim();
    const rest = input.slice(bangIdx + 1).trim();
    return { sheetName, rest };
  }

  return { sheetName: null, rest: input };
}

function isA1Address(text) {
  const t = (text || "").trim();
  if (!t) return false;
  // Matches cell or range address: e.g. A1, $A$1, A1:B10, $A$1:$I$401, A:B, 1:10
  const cellOrRangeRegex = /^(\$?[A-Za-z]{1,3}\$?[1-9][0-9]*|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?[1-9][0-9]*:\$?[1-9][0-9]*)(?::\$?[A-Za-z]{1,3}\$?[1-9][0-9]*)?$/i;
  return cellOrRangeRegex.test(t);
}

function formatAbsoluteAddress(sheetName, address) {
  if (!address) return "";
  let addr = address.trim();
  let sheetPart = "";
  const bang = addr.lastIndexOf("!");
  if (bang >= 0) {
    sheetPart = addr.slice(0, bang);
    addr = addr.slice(bang + 1);
  } else if (sheetName) {
    sheetPart = sheetName;
  }
  const absAddr = addr.replace(/\b([A-Za-z]+)(\d+)\b/g, "$$$1$$$2");
  if (sheetPart) {
    const rawSheet = sheetPart.replace(/^'|'$/g, "").replace(/''/g, "'");
    const needsQuotes = /[^A-Za-z0-9_]/.test(rawSheet);
    const formattedSheet = needsQuotes ? `'${rawSheet.replace(/'/g, "''")}'` : rawSheet;
    return `${formattedSheet}!${absAddr}`;
  }
  return absAddr;
}

function deepEqualValues(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r += 1) {
    const rowA = a[r];
    const rowB = b[r];
    if (!Array.isArray(rowA) || !Array.isArray(rowB)) return false;
    if (rowA.length !== rowB.length) return false;
    for (let c = 0; c < rowA.length; c += 1) {
      if (rowA[c] !== rowB[c]) return false;
    }
  }
  return true;
}

function checkNamedRangeRequirementSupport() {
  if (typeof Office !== "undefined" && Office.context && Office.context.requirements) {
    if (Office.context.requirements.isSetSupported) {
      return Office.context.requirements.isSetSupported("ExcelApi", "1.4");
    }
  }
  return true;
}

function formatDescriptorSummary(descriptor, rowCount, featureCount, label = "features") {
  if (!descriptor) return "";
  if (descriptor.kind === "name") {
    return `${descriptor.canonicalName} (${descriptor.scope}) -> ${descriptor.absoluteAddress}; ${rowCount} data rows, ${featureCount} ${label}`;
  }
  return `${descriptor.absoluteAddress}; ${rowCount} data rows, ${featureCount} ${label}`;
}

const MAX_SUPPORTED_CELLS = 500000;

async function preflightAndLoadRangeValues(context, range, fieldName, nameLabel = null) {
  // Stage 1: Load dimensions and metadata only - DO NOT request values
  range.load("address,rowIndex,columnIndex,rowCount,columnCount");
  if (range.worksheet && typeof range.worksheet.load === "function") {
    range.worksheet.load("id,name");
  }
  await context.sync();

  const totalCells = range.rowCount * range.columnCount;
  if (totalCells > MAX_SUPPORTED_CELLS) {
    const label = nameLabel ? `defined name "${nameLabel}"` : fieldName;
    throw new Error(
      `Selection for ${label} contains ${totalCells.toLocaleString()} cells, which exceeds the supported limit of ${MAX_SUPPORTED_CELLS.toLocaleString()} cells. Select a smaller range to avoid freezing Excel.`
    );
  }

  if (range.address && range.address.includes("#REF!")) {
    const label = nameLabel ? `Defined name "${nameLabel}"` : `Range for ${fieldName}`;
    throw new Error(`${label} has a broken reference (#REF!) for ${fieldName}.`);
  }

  let cellPart = range.address || "";
  const bang = cellPart.lastIndexOf("!");
  if (bang >= 0) cellPart = cellPart.slice(bang + 1);
  if (cellPart.includes(",")) {
    throw new Error(`Range unions with multiple areas are not supported for ${fieldName}.`);
  }

  if (range.rowCount === 0 || range.columnCount === 0) {
    const label = nameLabel ? `for defined name "${nameLabel}" ` : "";
    throw new Error(`The range ${label}is empty for ${fieldName}.`);
  }

  // Stage 2: Load values only after preflight passes
  range.load("values");
  await context.sync();

  if (!range.values || range.values.length === 0) {
    const label = nameLabel ? `for defined name "${nameLabel}" ` : "";
    throw new Error(`The range ${label}is empty for ${fieldName}.`);
  }

  return range;
}

async function verifyRangeDescriptorPreflightAndValues(context, range, descriptor) {
  // Stage 1: Preflight dimensions, cell limit, and worksheet ID without requesting values
  range.load("address,rowIndex,columnIndex,rowCount,columnCount");
  if (range.worksheet && typeof range.worksheet.load === "function") {
    range.worksheet.load("id,name");
  }
  await context.sync();

  const totalCells = range.rowCount * range.columnCount;
  if (totalCells > MAX_SUPPORTED_CELLS) return false;
  if (range.worksheet && descriptor.resolvedWorksheetId && range.worksheet.id !== descriptor.resolvedWorksheetId) return false;
  if (range.rowIndex !== descriptor.rowIndex || range.columnIndex !== descriptor.columnIndex) return false;
  if (range.rowCount !== descriptor.rowCount || range.columnCount !== descriptor.columnCount) return false;

  // Stage 2: Load values only if dimensions match
  range.load("values");
  await context.sync();

  if (!deepEqualValues(range.values, descriptor.values)) return false;
  return true;
}

async function resolveRangeInput(context, rawInput, options = {}) {
  const fieldName = options.fieldName || "Range";
  const trimmed = (rawInput || "").trim();

  if (!trimmed) {
    throw new Error(`Select a range or enter a valid defined name for ${fieldName}.`);
  }

  const { sheetName, rest } = parseInputQualifier(trimmed);
  if (!rest) {
    throw new Error(`Invalid range input "${rawInput}" for ${fieldName}.`);
  }

  // Syntax and unsupported input validations
  if (trimmed.includes("[") || trimmed.includes("]")) {
    throw new Error(`External workbook references are not supported for ${fieldName}.`);
  }
  if (trimmed.startsWith("=")) {
    throw new Error(`Formulas cannot be typed directly as inputs for ${fieldName}.`);
  }
  if (trimmed.startsWith("{") || trimmed.endsWith("}")) {
    throw new Error(`Array literals are not supported for ${fieldName}.`);
  }
  if (rest.includes(",")) {
    throw new Error(`Range unions with multiple areas are not supported for ${fieldName}.`);
  }

  const activeWorksheet = options.activeWorksheet || context.workbook.worksheets.getActiveWorksheet();
  if (!options.activeWorksheet) {
    activeWorksheet.load("id,name");
    await context.sync();
  }

  // 1. Cell address resolution
  if (isA1Address(rest)) {
    let targetSheet;
    if (sheetName) {
      targetSheet = context.workbook.worksheets.getItemOrNullObject
        ? context.workbook.worksheets.getItemOrNullObject(sheetName)
        : context.workbook.worksheets.getItem(sheetName);
      targetSheet.load("id,name");
      await context.sync();
      if (targetSheet.isNullObject) {
        throw new Error(`Worksheet "${sheetName}" was not found for ${fieldName}.`);
      }
    } else {
      targetSheet = activeWorksheet;
    }

    const range = targetSheet.getRange(rest);
    await preflightAndLoadRangeValues(context, range, fieldName);

    const descriptor = {
      originalText: trimmed,
      kind: "address",
      canonicalName: null,
      scope: null,
      scopeWorksheetId: null,
      scopeWorksheetName: null,
      resolvedWorksheetId: range.worksheet.id,
      resolvedWorksheetName: range.worksheet.name,
      absoluteAddress: formatAbsoluteAddress(range.worksheet.name, range.address),
      rowIndex: range.rowIndex,
      columnIndex: range.columnIndex,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
    };

    return { range, descriptor };
  }

  // 2. Defined Name resolution
  let item = null;
  let scope = null;
  let scopeWorksheet = null;

  if (sheetName) {
    // Explicit worksheet qualified name: search that worksheet's local collection
    const targetSheet = context.workbook.worksheets.getItemOrNullObject
      ? context.workbook.worksheets.getItemOrNullObject(sheetName)
      : context.workbook.worksheets.getItem(sheetName);
    targetSheet.load("id,name");
    await context.sync();
    if (targetSheet.isNullObject) {
      throw new Error(`Worksheet "${sheetName}" was not found for ${fieldName}.`);
    }

    if (targetSheet.names) {
      const localItem = targetSheet.names.getItemOrNullObject
        ? targetSheet.names.getItemOrNullObject(rest)
        : null;
      if (localItem) {
        localItem.load("name,type,scope");
        await context.sync();
        if (!localItem.isNullObject) {
          item = localItem;
          scope = "Worksheet";
          scopeWorksheet = targetSheet;
        }
      }
    }

    if (!item) {
      // Check if it exists as a workbook-scoped name to guide the user
      if (context.workbook.names && context.workbook.names.getItemOrNullObject) {
        const wbItem = context.workbook.names.getItemOrNullObject(rest);
        wbItem.load("name,type,scope");
        await context.sync();
        if (!wbItem.isNullObject) {
          throw new Error(
            `Defined name "${rest}" was not found on worksheet "${sheetName}" for ${fieldName}. ` +
            `"${rest}" is defined at Workbook scope; enter it without a worksheet qualifier.`
          );
        }
      }
      throw new Error(`Defined name "${rest}" was not found on worksheet "${sheetName}" for ${fieldName}.`);
    }
  } else {
    // Unqualified name: use active worksheet local name first, then workbook name
    if (activeWorksheet && activeWorksheet.names) {
      const localItem = activeWorksheet.names.getItemOrNullObject
        ? activeWorksheet.names.getItemOrNullObject(rest)
        : null;
      if (localItem) {
        localItem.load("name,type,scope");
        await context.sync();
        if (!localItem.isNullObject) {
          item = localItem;
          scope = "Worksheet";
          scopeWorksheet = activeWorksheet;
        }
      }
    }

    if (!item && context.workbook.names) {
      const wbItem = context.workbook.names.getItemOrNullObject
        ? context.workbook.names.getItemOrNullObject(rest)
        : null;
      if (wbItem) {
        wbItem.load("name,type,scope");
        await context.sync();
        if (!wbItem.isNullObject) {
          item = wbItem;
          scope = "Workbook";
        }
      }
    }

    if (!item) {
      // Check if it's defined on another worksheet to offer an actionable suggestion
      if (context.workbook.worksheets && context.workbook.worksheets.load) {
        try {
          context.workbook.worksheets.load("items/name,items/id");
          await context.sync();
          for (const otherSheet of context.workbook.worksheets.items || []) {
            if (otherSheet.id !== activeWorksheet.id && otherSheet.names) {
              const otherItem = otherSheet.names.getItemOrNullObject
                ? otherSheet.names.getItemOrNullObject(rest)
                : null;
              if (otherItem) {
                otherItem.load("name,type,scope");
                await context.sync();
                if (!otherItem.isNullObject) {
                  throw new Error(
                    `Defined name "${rest}" was not found on the active worksheet or at workbook scope for ${fieldName}. ` +
                    `It is defined locally on worksheet "${otherSheet.name}"; qualify it as "'${otherSheet.name}'!${rest}".`
                  );
                }
              }
            }
          }
        } catch (e) {
          if (e.message && e.message.includes("qualify it as")) throw e;
        }
      }
      throw new Error(`Defined name "${rest}" was not found for ${fieldName}.`);
    }
  }

  // Validate named item type
  if (item.type === "Error") {
    throw new Error(`Defined name "${item.name}" has a broken reference (#REF!) for ${fieldName}.`);
  }
  if (item.type === "Array") {
    throw new Error(`Defined name "${item.name}" refers to an array constant, not a worksheet range, for ${fieldName}.`);
  }
  if (item.type && item.type !== "Range") {
    throw new Error(`Defined name "${item.name}" refers to a named constant or scalar formula, not a worksheet range, for ${fieldName}.`);
  }

  let range;
  let usedWorksheetFallback = false;
  try {
    range = item.getRange();
  } catch (err) {
    if (scopeWorksheet && typeof scopeWorksheet.getRange === "function") {
      range = scopeWorksheet.getRange(item.name);
      usedWorksheetFallback = true;
    } else {
      throw new Error(`Defined name "${item.name}" does not refer to a valid worksheet range for ${fieldName}: ${err.message}`);
    }
  }

  try {
    await preflightAndLoadRangeValues(context, range, fieldName, item.name);
  } catch (err) {
    if (!usedWorksheetFallback && scopeWorksheet && typeof scopeWorksheet.getRange === "function") {
      try {
        range = scopeWorksheet.getRange(item.name);
        await preflightAndLoadRangeValues(context, range, fieldName, item.name);
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const descriptor = {
    originalText: trimmed,
    kind: "name",
    canonicalName: item.name,
    scope: scope || item.scope || "Workbook",
    scopeWorksheetId: scopeWorksheet ? scopeWorksheet.id : null,
    scopeWorksheetName: scopeWorksheet ? scopeWorksheet.name : null,
    resolvedWorksheetId: range.worksheet.id,
    resolvedWorksheetName: range.worksheet.name,
    absoluteAddress: formatAbsoluteAddress(range.worksheet.name, range.address),
    rowIndex: range.rowIndex,
    columnIndex: range.columnIndex,
    rowCount: range.rowCount,
    columnCount: range.columnCount,
    values: range.values,
  };

  return { range, descriptor };
}

async function verifySourceDescriptor(context, descriptor) {
  if (!descriptor) return false;

  try {
    if (descriptor.kind === "name") {
      if (descriptor.scope === "Worksheet") {
        const sheet = context.workbook.worksheets.getItemOrNullObject
          ? context.workbook.worksheets.getItemOrNullObject(descriptor.scopeWorksheetName)
          : context.workbook.worksheets.getItem(descriptor.scopeWorksheetName);
        sheet.load("id,name");
        await context.sync();
        if (sheet.isNullObject) return false;
        if (descriptor.scopeWorksheetId && sheet.id !== descriptor.scopeWorksheetId) {
          return false;
        }

        const item = sheet.names.getItemOrNullObject
          ? sheet.names.getItemOrNullObject(descriptor.canonicalName)
          : null;
        if (!item) return false;
        item.load("name,type,scope");
        await context.sync();
        if (item.isNullObject || item.type !== "Range") return false;

        let range;
        if (typeof sheet.getRange === "function") {
          try {
            range = sheet.getRange(descriptor.canonicalName);
          } catch {
            range = item.getRange();
          }
        } else {
          range = item.getRange();
        }

        try {
          return await verifyRangeDescriptorPreflightAndValues(context, range, descriptor);
        } catch {
          return false;
        }
      }

      if (descriptor.scope === "Workbook") {
        const item = context.workbook.names.getItemOrNullObject
          ? context.workbook.names.getItemOrNullObject(descriptor.canonicalName)
          : null;
        if (!item) return false;
        item.load("name,type,scope");
        await context.sync();
        if (item.isNullObject || item.type !== "Range") return false;

        const range = item.getRange();
        return await verifyRangeDescriptorPreflightAndValues(context, range, descriptor);
      }

      return false;
    }

    if (descriptor.kind === "address") {
      const sheet = context.workbook.worksheets.getItemOrNullObject
        ? context.workbook.worksheets.getItemOrNullObject(descriptor.resolvedWorksheetName)
        : context.workbook.worksheets.getItem(descriptor.resolvedWorksheetName);
      sheet.load("id,name");
      await context.sync();
      if (sheet.isNullObject) return false;
      if (descriptor.resolvedWorksheetId && sheet.id !== descriptor.resolvedWorksheetId) return false;

      const { rest } = parseInputQualifier(descriptor.originalText);
      const range = sheet.getRange(rest || descriptor.originalText);
      return await verifyRangeDescriptorPreflightAndValues(context, range, descriptor);
    }

    return false;
  } catch {
    return false;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_SUPPORTED_CELLS,
    parseInputQualifier,
    isA1Address,
    formatAbsoluteAddress,
    deepEqualValues,
    checkNamedRangeRequirementSupport,
    formatDescriptorSummary,
    resolveRangeInput,
    verifySourceDescriptor,
  };
}

if (typeof window !== "undefined") {
  window.RangeInputResolver = {
    MAX_SUPPORTED_CELLS,
    parseInputQualifier,
    isA1Address,
    formatAbsoluteAddress,
    deepEqualValues,
    checkNamedRangeRequirementSupport,
    formatDescriptorSummary,
    resolveRangeInput,
    verifySourceDescriptor,
  };
  window.MAX_SUPPORTED_CELLS = MAX_SUPPORTED_CELLS;
  window.parseInputQualifier = parseInputQualifier;
  window.isA1Address = isA1Address;
  window.formatAbsoluteAddress = formatAbsoluteAddress;
  window.deepEqualValues = deepEqualValues;
  window.checkNamedRangeRequirementSupport = checkNamedRangeRequirementSupport;
  window.formatDescriptorSummary = formatDescriptorSummary;
  window.resolveRangeInput = resolveRangeInput;
  window.verifySourceDescriptor = verifySourceDescriptor;
}
