const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript } = require("./helpers/load-script.cjs");

const OfficeAdapter = loadScript("tc-office.js");
const office = { AsyncResultStatus: { Succeeded: "succeeded" } };

test("fromAsyncResult resolves the callback value only on success", async () => {
  const value = await OfficeAdapter.fromAsyncResult((callback) => callback({ status: "succeeded", value: 42 }), office);
  assert.equal(value, 42);
});

test("fromAsyncResult rejects an Office callback failure", async () => {
  await assert.rejects(
    OfficeAdapter.fromAsyncResult((callback) => callback({ status: "failed", error: { code: "Denied", message: "No" } }), office),
    (error) => error.code === "Denied" && error.message === "No",
  );
});

test("fromAsyncResult rejects a synchronous throw from the callback registrar", async () => {
  await assert.rejects(
    OfficeAdapter.fromAsyncResult(() => { throw new Error("boom"); }, office),
    /boom/,
  );
});

test("saveSettings rejects a failed document-settings save", async () => {
  const settings = { saveAsync: (callback) => callback({ status: "failed", error: { code: "SaveFailed", message: "disk" } }) };

  await assert.rejects(OfficeAdapter.saveSettings(settings, office), (error) => error.code === "SaveFailed");
});

test("runExcel propagates a rejected context sync", async () => {
  const excel = {
    run: async (callback) => callback({ sync: async () => { throw new Error("sync rejected"); } }),
  };

  await assert.rejects(OfficeAdapter.runExcel(excel, async (context) => context.sync()), /sync rejected/);
});

test("host runners return an unsupported error when the host API is absent", async () => {
  await assert.rejects(OfficeAdapter.runExcel(null, async () => {}), (error) => error.code === "TC_OFFICE_UNSUPPORTED");
  await assert.rejects(OfficeAdapter.runPowerPoint(null, async () => {}), (error) => error.code === "TC_OFFICE_UNSUPPORTED");
});
