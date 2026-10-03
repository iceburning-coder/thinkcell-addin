const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const State = require("./tc-state.js");

const root = path.resolve(__dirname, "..");
const committed = process.argv.includes("--committed");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

class SvgElement {
  constructor(localName, attributes = [], children = []) {
    this.nodeType = 1;
    this.localName = localName;
    this.attributes = attributes.map(([name, value]) => ({ name, value }));
    this.children = children;
  }
}

class SvgFixtureParser {
  parseFromString(markup) {
    const tags = [...markup.matchAll(/<\s*(?!\/)([A-Za-z][\w:-]*)([^>]*)>/g)].map((match) => {
      const attributes = [...match[2].matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)].map((item) => [item[1], item[2]]);
      return new SvgElement(match[1], attributes);
    });
    const documentElement = tags.shift() || new SvgElement("parsererror");
    documentElement.children = tags;
    return {
      documentElement,
      getElementsByTagName: (name) => documentElement.localName === name ? [documentElement] : [],
    };
  }
}

function renderDefaultColumnWithActualEngine(engineArchive) {
  const spec = {
    type: "column",
    cats: ["2021", "2022", "2023", "2024", "2025E"],
    series: {
      "刻蚀": [12, 14, 13, 15.5, 17.5],
      "沉积": [6, 7, 6.5, 7.2, 8],
      "其他": [3, 3.3, 3.1, 3.4, 3.7],
    },
    mode: "stacked",
    sort: "sheet",
    labels: "value",
    size: [680, 400],
    title: "Chiller 市场 4 年复合增长 8.6%",
    subtitle: "全球市场规模，亿美元",
    theme: "consulting",
    annotations: [{ type: "cagr", i0: 0, i1: 4 }],
  };
  const program = [
    "import addin_api, json, sys",
    "spec = json.loads(sys.stdin.read())",
    "sys.stdout.write(addin_api.render(json.dumps(spec, ensure_ascii=False)))",
  ].join("\n");
  const output = execFileSync("python3", ["-c", program], {
    cwd: "/private/tmp",
    env: { ...process.env, PYTHONPATH: engineArchive, PYTHONDONTWRITEBYTECODE: "1" },
    input: JSON.stringify(spec),
    encoding: "utf8",
  });
  const rendered = JSON.parse(output);
  assert.equal(rendered.error, undefined, `engine error: ${JSON.stringify(rendered.error)}`);
  return rendered.svg;
}

const required = [
  "staging/taskpane.html",
  "staging/taskpane.css",
  "staging/taskpane.js",
  "staging/tc-state.js",
  "staging/tc-selection-diagnostics.js",
  "staging/tc-office.js",
  "staging/tc-store.js",
  "staging/tc-link.js",
  "staging/py/pylib.zip",
  "staging/assets/icon-16.png",
  "staging/assets/icon-32.png",
  "staging/assets/icon-64.png",
  "staging/assets/icon-80.png",
  "pyodide/pyodide.js",
  "manifest-staging.xml",
];
required.forEach((relative) => assert.ok(exists(relative), `missing ${relative}`));
assert.equal(exists("staging/tc-elements.js"), false, "tc-elements.js must not be staged");

const defaultSvg = renderDefaultColumnWithActualEngine(path.join(root, "staging", "py", "pylib.zip"));
State.sanitizeSvg(defaultSvg, { DOMParser: SvgFixtureParser });

const html = read("staging/taskpane.html");
assert.match(html, /<title>[^<]*诊断版[^<]*<\/title>/);
assert.match(html, /class="brand"[^>]*>[^<]*<span[^>]*><\/span>think-cell 风格图表[^<]*<span class="diag-badge">诊断版<\/span>/);
assert.match(html, /src="taskpane\.js\?v=diag2"/);
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
assert.match(js, /fetch\("\.\/py\/pylib\.zip\?v=diag2"\)/);

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
assert.match(stagingManifest, /<bt:String id="TcDiag\.Btn" DefaultValue="think-cell 图表（诊断版）"\/>/);
assert.doesNotMatch(stagingManifest, /(?:id|resid)="Tc\./, "diagnostic manifest must not reuse formal Tc.* resource IDs");
assert.match(stagingManifest, /<TaskpaneId>TcDiagPane<\/TaskpaneId>/);
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
}).split("\n").filter(Boolean).map((line) => committed ? line : line.slice(3));
changed.forEach((relative) => {
  assert.ok(relative === "manifest-staging.xml" || relative.startsWith("staging/"), `out-of-scope change ${relative}`);
});

console.log(`staging verification passed (${committed ? "committed" : "working tree"})`);
