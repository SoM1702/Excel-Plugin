const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { validateManifestFile } = require("../validate-manifest");

test("validateManifestFile accepts valid report from validation service", async () => {
  const dummyManifest = path.resolve(__dirname, "../manifest.xml");
  const mockValidator = async (manifestPath, verifyProduction) => {
    assert.equal(manifestPath, dummyManifest);
    assert.equal(verifyProduction, false);
    return {
      isValid: true,
      report: {
        status: "accepted",
        errors: [],
        warnings: [],
        notes: [],
      },
    };
  };

  const result = await validateManifestFile(dummyManifest, {
    verifyProduction: false,
    validatorFn: mockValidator,
  });

  assert.equal(result.isValid, true);
  assert.equal(result.report.status, "accepted");
  assert.deepEqual(result.errors, []);
});

test("validateManifestFile fails closed on network or DNS failure", async () => {
  const dummyManifest = path.resolve(__dirname, "../manifest.xml");
  const mockValidator = async () => {
    const err = new Error("getaddrinfo ENOTFOUND manifest-validator.azurewebsites.net");
    err.code = "ENOTFOUND";
    throw err;
  };

  await assert.rejects(
    () =>
      validateManifestFile(dummyManifest, {
        verifyProduction: false,
        validatorFn: mockValidator,
      }),
    /Manifest validation service failure: getaddrinfo ENOTFOUND/
  );
});

test("validateManifestFile fails closed when validation report rejects manifest", async () => {
  const dummyManifest = path.resolve(__dirname, "../manifest.xml");
  const mockValidator = async () => ({
    isValid: false,
    report: {
      status: "rejected",
      errors: [
        { title: "Invalid URL", content: "Icon URL must be secure HTTPS." },
      ],
      warnings: [],
    },
  });

  await assert.rejects(
    () =>
      validateManifestFile(dummyManifest, {
        verifyProduction: true,
        validatorFn: mockValidator,
      }),
    /Manifest validation rejected[\s\S]*Icon URL must be secure HTTPS/
  );
});

test("validateManifestFile fails closed on non-200 HTTP status", async () => {
  const dummyManifest = path.resolve(__dirname, "../manifest.xml");
  const mockValidator = async () => ({
    status: 503,
    statusText: "Service Unavailable",
    report: null,
  });

  await assert.rejects(
    () =>
      validateManifestFile(dummyManifest, {
        verifyProduction: false,
        validatorFn: mockValidator,
      }),
    /HTTP 503: Service Unavailable/
  );
});

test("validateManifestFile fails closed on empty result or missing report", async () => {
  const dummyManifest = path.resolve(__dirname, "../manifest.xml");

  await assert.rejects(
    () =>
      validateManifestFile(dummyManifest, {
        verifyProduction: false,
        validatorFn: async () => null,
      }),
    /Manifest validation returned an empty result/
  );

  await assert.rejects(
    () =>
      validateManifestFile(dummyManifest, {
        verifyProduction: false,
        validatorFn: async () => ({ isValid: true }),
      }),
    /without a validation report/
  );
});

test("validateManifestFile rejects missing manifest file", async () => {
  await assert.rejects(
    () => validateManifestFile("/path/to/nonexistent/manifest.xml"),
    /Manifest file not found/
  );
});
