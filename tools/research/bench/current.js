'use strict';
// Loads the *current* media/tree.js (a browser IIFE assigning window.treeLayout)
// inside a throwaway VM context, without touching any media/ file.
//
// Since media/tree.js now delegates to the vendored engine, the pre-change
// implementation is kept next to this file as legacy-tree.js so the benchmark
// baseline stays reproducible.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LEGACY = path.join(__dirname, 'legacy-tree.js');
const TREE_JS = fs.existsSync(LEGACY) ? LEGACY : path.resolve(__dirname, '..', '..', '..', 'media', 'tree.js');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(TREE_JS, 'utf8'), sandbox, { filename: TREE_JS });

if (!sandbox.window.treeLayout || typeof sandbox.window.treeLayout.layoutTree !== 'function') {
  throw new Error('media/tree.js did not expose window.treeLayout.layoutTree');
}

module.exports = {
  layoutTree: sandbox.window.treeLayout.layoutTree,
  source: TREE_JS,
};
