/*
 * Minimal HTTPS static server for the add-in.
 *
 * Office task panes must be served over HTTPS. This uses the locally-trusted
 * certificate created by `office-addin-dev-certs` (run `npm run cert` once) and
 * serves the add-in folder on https://localhost:3001. No webpack, no bundler —
 * just the raw files, which keeps things easy to read for a student project.
 * (Port 3001, not 3000, because 3000 is the common default for other dev
 * servers like Next.js/Create React App and is often already taken.)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const devCerts = require("office-addin-dev-certs");

const PORT = 3001;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".xml": "text/xml",
  ".json": "application/json",
};

async function main() {
  const httpsOptions = await devCerts.getHttpsServerOptions();

  https
    .createServer(httpsOptions, (req, res) => {
      let urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/") urlPath = "/src/taskpane/taskpane.html";

      const filePath = path.join(ROOT, urlPath);
      // Prevent path traversal outside the add-in folder.
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          return res.end("Not found: " + urlPath);
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(data);
      });
    })
    .listen(PORT, () => {
      console.log(`Add-in served at https://localhost:${PORT}`);
      console.log(`Task pane:  https://localhost:${PORT}/src/taskpane/taskpane.html`);
    });
}

main().catch((e) => {
  console.error("Failed to start dev server:", e.message);
  console.error("Did you run `npm run cert` first?");
  process.exit(1);
});
