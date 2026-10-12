/*
 * Generate a production manifest that points at your hosted front-end instead
 * of https://localhost:3001.
 *
 *   node configure-url.js https://YOUR-USER.github.io/YOUR-REPO/addin
 *
 * Writes manifest.prod.xml. Upload/sideload THAT for a demo on any machine.
 * (The manifest only locates the task-pane files; the backend API URL is set
 * separately inside the task pane's "Backend settings".)
 */

const fs = require("fs");
const path = require("path");

const base = process.argv[2];
if (!base || !base.startsWith("https://")) {
  console.error("Usage: node configure-url.js https://your-host/base-path");
  console.error("(must be an HTTPS URL — Office requires HTTPS)");
  process.exit(1);
}

const cleanBase = base.replace(/\/+$/, "");
const src = path.join(__dirname, "manifest.xml");
const out = path.join(__dirname, "manifest.prod.xml");

const xml = fs
  .readFileSync(src, "utf8")
  .replace(/https:\/\/localhost:3001/g, cleanBase);

fs.writeFileSync(out, xml);
console.log(`Wrote ${out}`);
console.log(`All task-pane URLs now point at ${cleanBase}`);
