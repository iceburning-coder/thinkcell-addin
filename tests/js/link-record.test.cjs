const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const Link = loadScript("tc-link.js");
const ID = "4eb927f0-c3fa-4ab8-a828-6c809ad19857";

test("defined names are deterministic, workbook-safe and UUID based", () => {
  assert.equal(Link.definedName(ID), "TC_LINK_4EB927F0C3FA4AB8A8286C809AD19857");
  assert.throws(() => Link.definedName("not-an-id"), (error) => error.code === "TC_LINK_INVALID_ID");
});

test("link records retain worksheet identity and a diagnostic last address", () => {
  assert.deepEqual(Link.createRecord(ID, { worksheetId: "sheet-42", sheet: "O'Brien", address: "$A$1:$C$4" }), {
    kind: "workbook-name",
    name: "TC_LINK_4EB927F0C3FA4AB8A8286C809AD19857",
    worksheetId: "sheet-42",
    sheet: "O'Brien",
    lastAddress: "'O''Brien'!$A$1:$C$4",
    status: "ok",
  });
});

test("cross-sheet addresses quote apostrophes and split back losslessly", () => {
  const qualified = Link.qualifyAddress("O'Brien", "A1:B2");
  assert.equal(qualified, "'O''Brien'!A1:B2");
  assert.deepEqual(Link.splitAddress(qualified), { sheet: "O'Brien", range: "A1:B2" });
});
