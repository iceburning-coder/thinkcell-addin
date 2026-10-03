const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const committed = process.argv.includes("--committed");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

const required = [
  "staging/taskpane.html",
  "staging/taskpane.css",
  "staging/taskpane.js",
  "staging/tc-state.js",
  "staging/tc-selection-diagnostics.js",
  "staging/tc-office.js",
  "staging/tc-store.js",
  "staging/tc-link.js",
  "staging/assets/icon-16.png",
  "staging/assets/icon-32.png",
  "staging/assets/icon-64.png",
  "staging/assets/icon-80.png",
  "pyodide/pyodide.js",
  "py/pylib.zip",
  "manifest-staging.xml",
];
required.forEach((relative) => assert.ok(exists(relative), `missing ${relative}`));
assert.equal(exists("staging/tc-elements.js"), false, "tc-elements.js must not be staged");

const html = read("staging/taskpane.html");
assert.match(html, /<title>[^<]*诊断版[^<]*<\/title>/);
assert.match(html, /class="brand"[^>]*>[^<]*<span[^>]*><\/span>think-cell 风格图表[^<]*<span class="diag-badge">诊断版<\/span>/);
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const reference = match[1];
  if (/^(?:https?:|data:|#)/.test(reference)) continue;
  const clean = reference.split(/[?#]/, 1)[0];
  assert.ok(fs.existsSync(path.resolve(root, "staging", clean)), `broken HTML reference ${reference}`);
}

const js = read("staging/taskpane.js");
assert.match(js, /const DIAG_STORE_KEY = "diag-staging";/);
assert.match(js, /store\.get\(DIAG_STORE_KEY, 1\)/);
assert.match(js, /new URL\("\.\.\/pyodide\/", location\.href\)/);
assert.match(js, /fetch\("\.\.\/py\/pylib\.zip\?v=9"\)/);

const formalManifest = read("manifest.xml");
const stagingManifest = read("manifest-staging.xml");
const id = (xml) => {
  const match = xml.match(/<Id>([^<]+)<\/Id>/);
  assert.ok(match, "manifest Id missing");
  return match[1];
};
assert.notEqual(id(stagingManifest), id(formalManifest));
assert.notEqual(id(stagingManifest), "5c1f7b8e-3a2d-4c6e-9b0f-7d2e4a1c8b93");
assert.match(stagingManifest, /<DisplayName DefaultValue="think-cell 图表（诊断版）"\/>/);
assert.match(stagingManifest, /<bt:String id="Tc\.Btn" DefaultValue="think-cell 图表（诊断版）"\/>/);
assert.match(stagingManifest, /<Host Name="Presentation"\/>/);
assert.match(stagingManifest, /<Host Name="Workbook"\/>/);
const stagingUrl = "https://iceburning-coder.github.io/thinkcell-addin/staging/taskpane.html?v=diag1";
assert.ok(stagingManifest.split(stagingUrl).length >= 3, "both SourceLocation values must use staging URL");

const protectedPaths = [
  "taskpane.html", "taskpane.css", "taskpane.js", "manifest.xml",
  "pyodide", "py/pylib.zip", ":(glob)tc-*.js",
];
const baseline = committed ? "HEAD~1" : "HEAD";
const target = committed ? "HEAD" : undefined;
const diffArgs = ["diff", "--exit-code", baseline];
if (target) diffArgs.push(target);
diffArgs.push("--", ...protectedPaths);
execFileSync("git", diffArgs, {
  cwd: root,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  stdio: "pipe",
});

const changed = execFileSync("git", committed
  ? ["diff", "--name-only", "HEAD~1..HEAD"]
  : ["status", "--porcelain"], {
  cwd: root,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  encoding: "utf8",
}).trim().split("\n").filter(Boolean).map((line) => committed ? line : line.slice(3));
changed.forEach((relative) => {
  assert.ok(relative === "manifest-staging.xml" || relative.startsWith("staging/"), `out-of-scope change ${relative}`);
});

console.log(`staging verification passed (${committed ? "committed" : "working tree"})`);
