const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const committed = process.argv.includes("--committed");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));

function svgWhitelist(constantName) {
  const source = read("staging/tc-state.js");
  const match = source.match(new RegExp(`const ${constantName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${constantName} not found in staging/tc-state.js`);
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  assert.ok(values.length, `${constantName} is empty`);
  return new Set(values);
}

const SVG_TAGS = svgWhitelist("SVG_TAGS");
const SVG_ATTRS = svgWhitelist("SVG_ATTRS");

function unsafeSvg(message, details) {
  const error = new Error(message);
  error.code = "TC_SVG_UNSAFE";
  error.details = details;
  throw error;
}

function inspectSvgWithPython(markup) {
  const program = [
    "import json, sys, xml.etree.ElementTree as ET",
    "markup = sys.stdin.read()",
    "try:",
    "    root = ET.fromstring(markup)",
    "except ET.ParseError as error:",
    "    sys.stdout.write(json.dumps({'parseError': str(error)}))",
    "    raise SystemExit(0)",
    "def split_name(name):",
    "    if name.startswith('{'):",
    "        namespace, local = name[1:].split('}', 1)",
    "        return local, namespace",
    "    return name, None",
    "nodes = []",
    "for element in root.iter():",
    "    local_name, namespace = split_name(element.tag)",
    "    attributes = []",
    "    for name, value in element.attrib.items():",
    "        attribute_name, attribute_namespace = split_name(name)",
    "        attributes.append({'name': attribute_name, 'namespace': attribute_namespace, 'value': value})",
    "    nodes.append({'name': local_name, 'namespace': namespace, 'attributes': attributes})",
    "root_name, root_namespace = split_name(root.tag)",
    "sys.stdout.write(json.dumps({'root': root_name, 'rootNamespace': root_namespace, 'nodes': nodes}))",
  ].join("\n");
  const output = execFileSync("python3", ["-c", program], {
    cwd: os.tmpdir(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    input: String(markup || ""),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

function verifySvg(markup) {
  const inspected = inspectSvgWithPython(markup);
  if (inspected.parseError) unsafeSvg("图表 SVG 语法不正确。", { message: inspected.parseError });
  if (inspected.root !== "svg") unsafeSvg("图表输出不是 SVG。", { element: inspected.root });
  if (inspected.rootNamespace && inspected.rootNamespace !== "http://www.w3.org/2000/svg") {
    unsafeSvg("图表 SVG 命名空间不正确。", { namespace: inspected.rootNamespace });
  }
  for (const node of inspected.nodes) {
    if (!SVG_TAGS.has(node.name)) unsafeSvg("图表 SVG 包含不允许的元素。", { element: node.name });
    for (const attribute of node.attributes) {
      if (/^on/i.test(attribute.name) || !SVG_ATTRS.has(attribute.name)) {
        unsafeSvg("图表 SVG 包含不允许的属性。", { attribute: attribute.name });
      }
      if (/(?:javascript\s*:|data\s*:|https?\s*:|url\s*\()/i.test(attribute.value)) {
        unsafeSvg("图表 SVG 包含外部或脚本地址。", { attribute: attribute.name });
      }
      if (/(?:onload|onerror)\s*=/i.test(attribute.value)) {
        unsafeSvg("图表 SVG 包含事件处理代码。", { attribute: attribute.name });
      }
    }
  }
  return inspected;
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
verifySvg(defaultSvg);
for (const [name, markup, rejectedAttribute] of [
  ["root style attribute", '<svg style="background:#fff"></svg>', "style"],
  ["malformed unclosed element", "<svg><text>broken</svg>", null],
  ["mixed quotes followed by an event attribute", '<svg><text font-family="\'A\', B" onclick="x">x</text></svg>', "onclick"],
]) {
  assert.throws(
    () => verifySvg(markup),
    (error) => error && error.code === "TC_SVG_UNSAFE"
      && (rejectedAttribute ? error.details.attribute === rejectedAttribute : Boolean(error.details.message)),
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
