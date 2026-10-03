const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const State = require("./tc-state.js");

const root = path.resolve(__dirname, "..");
const committed = process.argv.includes("--committed");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

function inspectSvgWithPython(markup) {
  const program = [
    "import json, sys",
    "from xml.dom import Node, minidom",
    "markup = sys.stdin.read()",
    "try:",
    "    document = minidom.parseString(markup)",
    "except Exception as error:",
    "    sys.stdout.write(json.dumps({'parseError': str(error)}))",
    "    raise SystemExit(0)",
    "def serialize(element):",
    "    attributes = []",
    "    for index in range(element.attributes.length):",
    "        attribute = element.attributes.item(index)",
    "        attributes.append({'name': attribute.name, 'value': attribute.value})",
    "    children = [serialize(child) for child in element.childNodes if child.nodeType == Node.ELEMENT_NODE]",
    "    return {'localName': element.localName or element.tagName, 'attributes': attributes, 'children': children}",
    "sys.stdout.write(json.dumps(serialize(document.documentElement)))",
  ].join("\n");
  const output = execFileSync("python3", ["-c", program], {
    cwd: os.tmpdir(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    input: String(markup || ""),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function domElement(node) {
  return {
    nodeType: 1,
    localName: node.localName,
    attributes: node.attributes || [],
    children: (node.children || []).map(domElement),
  };
}

function elementsNamed(rootElement, name) {
  const matches = [];
  const visit = (element) => {
    if (element.localName === name) matches.push(element);
    element.children.forEach(visit);
  };
  visit(rootElement);
  return matches;
}

class PythonDomParser {
  parseFromString(markup) {
    const parsed = inspectSvgWithPython(markup);
    if (parsed.parseError) {
      const parsererror = domElement({ localName: "parsererror", attributes: [], children: [] });
      return { documentElement: parsererror, getElementsByTagName: (name) => name === "parsererror" ? [parsererror] : [] };
    }
    const documentElement = domElement(parsed);
    return {
      documentElement,
      getElementsByTagName: (name) => elementsNamed(documentElement, name),
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
    cwd: os.tmpdir(),
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
State.sanitizeSvg(defaultSvg, { DOMParser: PythonDomParser });
for (const [name, markup, rejectedAttribute] of [
  ["root style attribute", '<svg style="background:#fff"></svg>', "style"],
  ["malformed unclosed element", "<svg><text>broken</svg>", null],
  ["mixed quotes followed by an event attribute", '<svg><text font-family="\'A\', B" onclick="x">x</text></svg>', "onclick"],
  ["prefixed namespace declaration", '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect x="1"/></svg>', "xmlns:xlink"],
  ["nested default namespace override", '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://example.com/evil"><rect x="1"/></g></svg>', null],
]) {
  assert.throws(
    () => State.sanitizeSvg(markup, { DOMParser: PythonDomParser }),
    (error) => error && error.code === "TC_SVG_UNSAFE"
      && (rejectedAttribute ? error.details && error.details.attribute === rejectedAttribute : true),
    `SVG verification must reject ${name}`,
  );
}

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
