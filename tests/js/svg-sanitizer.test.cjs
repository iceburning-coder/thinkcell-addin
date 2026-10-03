const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const State = loadScript("tc-state.js");

class FakeElement {
  constructor(localName, attributes = [], children = []) {
    this.nodeType = 1;
    this.localName = localName;
    this.attributes = attributes.map(([name, value]) => ({ name, value }));
    this.children = children;
  }
}

class FixtureParser {
  parseFromString(markup) {
    const tags = [...markup.matchAll(/<\s*(?!\/)([A-Za-z][\w:-]*)([^>]*)>/g)].map((match) => {
      const attributes = [...match[2].matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)].map((item) => [item[1], item[2]]);
      return new FakeElement(match[1], attributes);
    });
    const root = tags.shift() || new FakeElement("parsererror");
    root.children = tags;
    return { documentElement: root, getElementsByTagName: (name) => root.localName === name ? [root] : [] };
  }
}

for (const [name, markup] of [
  ["script elements", '<svg xmlns="http://www.w3.org/2000/svg"><script></script></svg>'],
  ["foreignObject elements", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject></foreignObject></svg>'],
  ["event attributes", '<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>'],
  ["external href attributes", '<svg xmlns="http://www.w3.org/2000/svg"><text href="https://example.com/x">x</text></svg>'],
  ["javascript URLs", '<svg xmlns="http://www.w3.org/2000/svg"><text href="javascript:alert(1)">x</text></svg>'],
  ["unknown SVG elements", '<svg xmlns="http://www.w3.org/2000/svg"><filter></filter></svg>'],
]) {
  test(`SVG sanitizer rejects ${name}`, () => {
    assert.throws(
      () => State.sanitizeSvg(markup, { DOMParser: FixtureParser }),
      (error) => error.code === "TC_SVG_UNSAFE",
    );
  });
}

test("SVG sanitizer accepts only the primitives emitted by the chart engine", () => {
  const svg = State.sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="0" y="0" width="10" height="10" fill="#123456"/><line x1="0" y1="0" x2="10" y2="10" stroke="#123456"/><polygon points="0,0 1,1" fill="#123456"/><circle cx="5" cy="5" r="2" fill="#123456"/><text x="5" y="5" fill="#123456">A</text></svg>',
    { DOMParser: FixtureParser },
  );

  assert.equal(svg.localName, "svg");
  assert.deepEqual(svg.children.map((child) => child.localName), ["rect", "line", "polygon", "circle", "text"]);
});
