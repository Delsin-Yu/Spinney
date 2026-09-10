// Resolves candidate packages from the isolated install dir (bench/tmp/node_modules)
// without adding them to the extension's own package.json.
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, 'tmp', 'package.json'));
// non-layered-tidy-tree-layout ships a browser-only UMD (bare `window`), so shim it.
const nlttl = (() => {
  global.window = global.window || globalThis;
  return req('non-layered-tidy-tree-layout');
})();
module.exports = {
  flextree: req('d3-flextree').flextree,
  dagre: req('@dagrejs/dagre'),
  nlttl,
  tmpDir: path.join(__dirname, 'tmp'),
};
