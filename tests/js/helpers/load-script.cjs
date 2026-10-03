const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "../../..");

function loadScript(relativePath) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  delete require.cache[require.resolve(absolutePath)];
  return require(absolutePath);
}

module.exports = { loadScript, REPO_ROOT };
