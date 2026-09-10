/*
 * Chat Tree layout — pure functions, no DOM.
 *
 * Turn children hang directly below their parent's bottom edge; agent (sub-agent)
 * children are isolated windows stacked vertically to the RIGHT of the parent
 * (and to the right of any turn children). Every node is laid out LEFT-aligned at
 * `left` for determinism, and its subtree width reserves space for both the card
 * and the agent windows, so siblings never overlap them.
 * Exposed as `window.treeLayout`.
 */
(function () {
  const DEFAULTS = { nodeW: 320, hGap: 48, vGap: 72, pad: 20, agentGap: 80, agentVGap: 24 };

  /**
   * @param {Object} nodesById  id -> { id, children: string[], kind?: 'turn'|'agent' }
   * @param {string} rootId
   * @param {Object} heights    id -> measured pixel height
   * @param {Object} [opts]     { nodeW, hGap, vGap, pad, widths, agentGap, agentVGap }
   * @returns {{ pos: Object<string, {x:number,y:number}>, width:number, height:number }}
   */
  function layoutTree(nodesById, rootId, heights, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const widths = o.widths || {};
    const size = (id) => ({ w: widths[id] || o.nodeW, h: heights[id] || 120 });
    const isAgent = (id) => !!nodesById[id] && nodesById[id].kind === 'agent';
    const turnKids = (id) => (nodesById[id] && nodesById[id].children || []).filter((c) => !!nodesById[c] && !isAgent(c));
    const agentKids = (id) => (nodesById[id] && nodesById[id].children || []).filter((c) => !!nodesById[c] && isAgent(c));

    if (!nodesById[rootId]) {
      return { pos: {}, width: o.nodeW + o.pad * 2, height: 120 + o.pad * 2 };
    }

    // Subtree width = max(node card, turn-kid row) + agent windows (if any).
    function subWidth(id) {
      const k = turnKids(id);
      let rowW = k.length === 0 ? size(id).w : 0;
      if (k.length > 0) {
        let sum = 0;
        for (const c of k) sum += subWidth(c);
        sum += o.hGap * (k.length - 1);
        rowW = Math.max(sum, size(id).w);
      }
      const ak = agentKids(id);
      if (ak.length > 0) {
        let maxAgentW = 0;
        for (const a of ak) maxAgentW = Math.max(maxAgentW, subWidth(a));
        return rowW + o.agentGap + maxAgentW;
      }
      return rowW;
    }

    // Vertical extent: card + the turn-kid row below, or the agent-window block to
    // the right (whichever is taller). Used to space stacked agent windows so a
    // sub-agent's own depth-2 children are not overlapped by the next sibling.
    function subHeight(id) {
      let h = size(id).h;
      const tk = turnKids(id);
      if (tk.length > 0) {
        let m = 0;
        for (const c of tk) m = Math.max(m, subHeight(c));
        h = size(id).h + o.vGap + m;
      }
      const ak = agentKids(id);
      if (ak.length > 0) {
        let block = 0;
        for (const a of ak) block += subHeight(a) + o.agentVGap;
        block -= o.agentVGap;
        h = Math.max(h, block);
      }
      return h;
    }

    const pos = {};
    let maxW = 0;
    let maxH = 0;

    (function place(id, left, top) {
      const s = size(id);
      const x = left; // deterministic left-align
      pos[id] = { x, y: top };
      maxW = Math.max(maxW, x + s.w);
      maxH = Math.max(maxH, top + s.h);

      // Turn children hang below the card, from the card's left.
      const kids = turnKids(id);
      const childTop = top + s.h + o.vGap;
      let cursor = x;
      for (const c of kids) {
        const cw = subWidth(c);
        place(c, cursor, childTop);
        cursor += cw + o.hGap;
      }
      const turnRight = kids.length > 0 ? cursor - o.hGap : x + s.w;

      // Agent windows: to the right of the card AND the turn-kid row. Each window
      // is laid out recursively so its own agent children (a depth-2 sub-agent of
      // a depth-1 sub-agent) are positioned and connected, not orphaned.
      const ak = agentKids(id);
      if (ak.length > 0) {
        const ax = Math.max(x + s.w, turnRight) + o.agentGap;
        let ay = top;
        for (const a of ak) {
          place(a, ax, ay);
          const as = size(a);
          maxW = Math.max(maxW, ax + as.w);
          maxH = Math.max(maxH, ay + as.h);
          ay += subHeight(a) + o.agentVGap;
        }
      }
    })(rootId, 0, 0);

    return { pos, width: maxW + o.pad * 2, height: maxH + o.pad * 2 };
  }

  window.treeLayout = { layoutTree };
})();
