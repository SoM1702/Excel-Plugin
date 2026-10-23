const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const xml2js = require("xml2js");

const { buildDeployment, validateHttpsUrl } = require("../configure-url");

test("deployment builder writes hosted manifest, static assets, and API configuration", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr-deploy-test-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "site");

  const result = buildDeployment({
    frontendBaseUrl: "https://team.example.com/excel-addin/",
    backendApiUrl: "https://api.example.com/v1/",
    providerName: "Team & Research",
    supportUrl: "https://team.example.com/support",
    outputDir,
  });

  const manifest = fs.readFileSync(result.manifestPath, "utf8");
  const config = fs.readFileSync(path.join(outputDir, "src/taskpane/config.js"), "utf8");
  assert.match(manifest, /<ProviderName>Team &amp; Research<\/ProviderName>/);
  assert.match(manifest, /https:\/\/team\.example\.com\/excel-addin\/src\/taskpane\/taskpane\.html/);
  assert.match(manifest, /<SupportUrl DefaultValue="https:\/\/team\.example\.com\/support"\/>/);
  assert.doesNotMatch(manifest, /https:\/\/localhost:3001/);
  assert.match(config, /https:\/\/api\.example\.com\/v1/);
  assert.ok(fs.existsSync(path.join(outputDir, "src/commands/commands.html")));
  assert.ok(fs.existsSync(path.join(outputDir, "assets/icon-32.png")));

  const parsed = await xml2js.parseStringPromise(manifest);
  assert.equal(parsed.OfficeApp.ProviderName[0], "Team & Research");
  assert.equal(parsed.OfficeApp.SupportUrl[0].$.DefaultValue, "https://team.example.com/support");
  assert.equal(
    parsed.OfficeApp.DefaultSettings[0].SourceLocation[0].$.DefaultValue,
    "https://team.example.com/excel-addin/src/taskpane/taskpane.html"
  );
});

test("deployment builder correctly escapes and preserves special replacement tokens, quotes, and Unicode", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr-deploy-tokens-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "site");

  // Tokens include JavaScript regex replacement specials ($&, $$, $`, $')
  // quotes, brackets, and Unicode
  const trickyProviderName = "Team $& and $$ `quote' \"special\" <bracket> & co. 日本語";
  const complexFrontend = "https://example.com/a&b/addin/";
  const complexSupport = "https://example.com/support/a&b";

  const result = buildDeployment({
    frontendBaseUrl: complexFrontend,
    backendApiUrl: "https://api.example.com/v1/a&b/",
    providerName: trickyProviderName,
    supportUrl: complexSupport,
    outputDir,
  });

  const manifestXml = fs.readFileSync(result.manifestPath, "utf8");
  const parsed = await xml2js.parseStringPromise(manifestXml);

  // Assert parsed element values match exact raw input strings without corruption
  assert.equal(parsed.OfficeApp.ProviderName[0], trickyProviderName);
  assert.equal(parsed.OfficeApp.SupportUrl[0].$.DefaultValue, complexSupport);

  // Assert URL attribute in DefaultSettings source location preserves the ampersand subpath
  const sourceLocation = parsed.OfficeApp.DefaultSettings[0].SourceLocation[0].$.DefaultValue;
  assert.equal(sourceLocation, "https://example.com/a&b/addin/src/taskpane/taskpane.html");

  // Verify config.js contains the unescaped literal URLs
  const configContent = fs.readFileSync(path.join(outputDir, "src/taskpane/config.js"), "utf8");
  assert.ok(configContent.includes("https://api.example.com/v1/a&b"));
});

test("deployment builder rejects insecure or incomplete deployment settings", () => {
  assert.throws(() => validateHttpsUrl("http://api.example.com", "API URL"), /HTTPS/);
  assert.throws(() => validateHttpsUrl("https://user:pass@api.example.com", "API URL"), /HTTPS/);
  assert.throws(
    () => buildDeployment({
      frontendBaseUrl: "https://team.example.com",
      backendApiUrl: "https://api.example.com",
      providerName: "Your Team Name",
      supportUrl: "https://team.example.com/support",
      outputDir: path.join(os.tmpdir(), "unused-lr-output"),
    }),
    /real provider or team name/
  );
});

test("deployment builder refuses to overwrite an unmanaged output directory", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lr-deploy-unmanaged-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "site");
  fs.mkdirSync(outputDir);
  fs.writeFileSync(path.join(outputDir, "keep.txt"), "user data");

  assert.throws(
    () => buildDeployment({
      frontendBaseUrl: "https://team.example.com",
      backendApiUrl: "https://api.example.com",
      providerName: "Team",
      supportUrl: "https://team.example.com/support",
      outputDir,
    }),
    /Refusing to replace existing output directory/
  );
  assert.equal(fs.readFileSync(path.join(outputDir, "keep.txt"), "utf8"), "user data");
});
