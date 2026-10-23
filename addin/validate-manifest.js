/*
 * Manifest validation wrapper ensuring fail-closed behavior.
 *
 * Verifies that Microsoft's manifest validation service was reached and
 * successfully accepted the manifest schema. Service outages, schema rejections,
 * or missing files explicitly exit with status 1.
 */

const fs = require("fs");
const path = require("path");

async function validateManifestFile(manifestPath, options = {}) {
  const verifyProduction = Boolean(options.verifyProduction || options.production);
  const validator = options.validatorFn || require("office-addin-manifest").validateManifest;

  if (!manifestPath) {
    throw new Error("Manifest path is required.");
  }
  const resolvedPath = path.resolve(manifestPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  let validation;
  try {
    validation = await validator(resolvedPath, verifyProduction);
  } catch (err) {
    throw new Error(`Manifest validation service failure: ${err.message || err}`);
  }

  if (!validation) {
    throw new Error("Manifest validation returned an empty result.");
  }

  if (validation.status && validation.status !== 200) {
    throw new Error(`Manifest validation service returned HTTP ${validation.status}: ${validation.statusText || "Error"}`);
  }

  if (!validation.report) {
    throw new Error("Manifest validation completed without a validation report.");
  }

  const report = validation.report;
  const errors = report.errors || [];
  const warnings = report.warnings || [];
  const notes = report.notes || [];

  if (!validation.isValid || (report.status && report.status.toLowerCase() !== "accepted")) {
    const errDetails = errors
      .map((e) => `  - [${e.title || "Error"}] ${e.content || e.code || JSON.stringify(e)}`)
      .join("\n");
    throw new Error(
      `Manifest validation rejected '${manifestPath}' (status: ${report.status || "failed"}):\n${
        errDetails || "  No error details provided."
      }`
    );
  }

  return {
    isValid: true,
    manifestPath: resolvedPath,
    verifyProduction,
    report,
    errors,
    warnings,
    notes,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const verifyProduction = args.includes("--production");
  const manifestPaths = args.filter((a) => !a.startsWith("--"));

  if (!manifestPaths.length) {
    console.error("Usage: node validate-manifest.js <manifest-path> [--production]");
    process.exit(1);
  }

  (async () => {
    try {
      for (const mPath of manifestPaths) {
        console.log(`Validating manifest: ${mPath} (production=${verifyProduction})...`);
        const result = await validateManifestFile(mPath, { verifyProduction });
        console.log(`✓ Manifest '${mPath}' is valid and accepted by Office Add-in validation service.`);
        if (result.warnings && result.warnings.length) {
          console.warn(`Warnings (${result.warnings.length}):`);
          result.warnings.forEach((w) => console.warn(`  - ${w.title || w.content}`));
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(`✗ Validation failed: ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { validateManifestFile };
