'use strict';
/*
 * The vendored, pinned layout engine (non-layered-tidy-tree-layout@2.0.2, MIT) as
 * a CommonJS module — loaded from the very file the webview uses:
 *   media/vendor/non-layered-tidy-tree-layout/dist/non-layered-tidy-tree-layout.js
 *
 * The bench used to resolve this package from `bench/tmp/node_modules`, a separate
 * install that is not in the repo. The vendored copy is byte-identical (see the
 * PROVENANCE.md hash) and always present, so anything that only needs the engine —
 * `verify-tree.js`, `grid-sweep.js`, `analyze-interposition.js` — runs with no npm
 * install at all.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.resolve(
  __dirname, '..', '..', '..',
  'media', 'vendor', 'non-layered-tidy-tree-layout', 'dist', 'non-layered-tidy-tree-layout.js',
);

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
const g = sandbox.window.nonLayeredTidyTreeLayout;
if (!g || typeof g.Layout !== 'function' || typeof g.BoundingBox !== 'function') {
  throw new Error('vendored layout engine unreadable: ' + FILE);
}

module.exports = { Layout: g.Layout, BoundingBox: g.BoundingBox, file: FILE };
