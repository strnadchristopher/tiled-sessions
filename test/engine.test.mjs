import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  arrangement,
  groupIdOfPane,
  specRects,
  chatZones,
  gridDims,
  nextLayout,
  promote,
  reconcileOrder,
  swapOrder,
  coreParentSplit,
  coreSplits,
  equalize,
  fromCore,
  insert,
  leaves,
  neighbor,
  openSessions,
  pickTarget,
  rects,
  remove,
  split,
  leaf,
  equalizePlan,
  mergeSessionRows,
  swap,
  toggleSplit,
  touch
} from '../src/engine.mjs'

const AREA = { x: 0, y: 0, w: 1600, h: 900 }

/** Open t1..tn one at a time; each new tile takes focus. */
function build(n, mode) {
  let tree = null
  let history = []
  const steps = []
  const sizesAtOpen = []
  for (let i = 1; i <= n; i++) {
    const id = `t${i}`
    const res = insert(tree, AREA, id, { mode, history, focused: history[0] ?? null })
    tree = res.tree
    history = touch(history, id)
    steps.push({ id, target: res.target, pos: res.pos })
    sizesAtOpen.push(size(tree, id))
  }
  return { tree, history, steps, sizesAtOpen }
}

const size = (tree, id) => {
  const r = rects(tree, AREA).get(id)
  return [Math.round(r.w * 10) / 10, Math.round(r.h * 10) / 10]
}

const box = (tree, id) => {
  const r = rects(tree, AREA).get(id)
  return [r.x, r.y, r.w, r.h]
}

describe('largest mode, 1 → 8 tiles', () => {
  it('1 tile fills the area', () => {
    const { tree } = build(1, 'largest')
    assert.deepEqual(box(tree, 't1'), [0, 0, 1600, 900])
  })

  it('2 tiles sit side by side', () => {
    const { tree, steps } = build(2, 'largest')
    assert.deepEqual(steps[1], { id: 't2', target: 't1', pos: 'right' })
    assert.deepEqual(box(tree, 't1'), [0, 0, 800, 900])
    assert.deepEqual(box(tree, 't2'), [800, 0, 800, 900])
  })

  it('3 tiles: one left, two stacked right (tie → most recently focused)', () => {
    const { tree, steps } = build(3, 'largest')
    assert.deepEqual(steps[2], { id: 't3', target: 't2', pos: 'bottom' })
    assert.deepEqual(box(tree, 't1'), [0, 0, 800, 900])
    assert.deepEqual(box(tree, 't2'), [800, 0, 800, 450])
    assert.deepEqual(box(tree, 't3'), [800, 450, 800, 450])
  })

  it('4 tiles: even 2x2', () => {
    const { tree, steps } = build(4, 'largest')
    assert.deepEqual(steps[3], { id: 't4', target: 't1', pos: 'bottom' })
    assert.deepEqual(box(tree, 't1'), [0, 0, 800, 450])
    assert.deepEqual(box(tree, 't4'), [0, 450, 800, 450])
    assert.deepEqual(box(tree, 't2'), [800, 0, 800, 450])
    assert.deepEqual(box(tree, 't3'), [800, 450, 800, 450])
  })

  it('5 → 8 tiles follow the documented targets', () => {
    const { steps } = build(8, 'largest')
    assert.deepEqual(
      steps.slice(4).map(s => [s.id, s.target, s.pos]),
      [
        ['t5', 't4', 'right'],
        ['t6', 't3', 'right'],
        ['t7', 't2', 'right'],
        ['t8', 't1', 'right']
      ]
    )
  })

  it('8 tiles: every tile is 400x450 (4x2 grid)', () => {
    const { tree } = build(8, 'largest')
    for (const id of leaves(tree)) assert.deepEqual(size(tree, id), [400, 450], id)
    assert.equal(leaves(tree).length, 8)
  })
})

describe('focused mode (dwindle spiral), 1 → 8 tiles', () => {
  it('each new tile halves the previous newest tile, alternating right/bottom', () => {
    const { tree, steps, sizesAtOpen } = build(8, 'focused')
    assert.deepEqual(
      steps.map(s => [s.target, s.pos]),
      [[null, null], ['t1', 'right'], ['t2', 'bottom'], ['t3', 'right'], ['t4', 'bottom'], ['t5', 'right'], ['t6', 'bottom'], ['t7', 'right']]
    )
    assert.deepEqual(sizesAtOpen, [
      [1600, 900], [800, 900], [800, 450], [400, 450], [400, 225], [200, 225], [200, 112.5], [100, 112.5]
    ])
    // The spiral leaves t1 untouched at half the area.
    assert.deepEqual(size(tree, 't1'), [800, 900])
  })

  it('falls back to largest when the focused id is not a candidate', () => {
    const tree = split('row', leaf('a'), leaf('b'), 0.75)
    assert.equal(pickTarget(tree, AREA, { mode: 'focused', focused: 'gone' }), 'a')
  })
})

describe('closing tiles', () => {
  it('closing a middle tile collapses its parent so the sibling takes the space', () => {
    const { tree } = build(3, 'largest')
    const after = remove(tree, 't2')
    assert.deepEqual(box(after, 't3'), [800, 0, 800, 900])
    assert.deepEqual(box(after, 't1'), [0, 0, 800, 900])
  })

  it('closing any single tile of 8 keeps 7 tiles that exactly cover the area', () => {
    for (const mode of ['largest', 'focused']) {
      const { tree } = build(8, mode)
      for (const id of leaves(tree)) {
        const after = remove(tree, id)
        const ids = leaves(after)
        assert.equal(ids.length, 7, `${mode} close ${id}`)
        assert.ok(!ids.includes(id))
        const total = ids.reduce((sum, other) => {
          const r = rects(after, AREA).get(other)
          return sum + r.w * r.h
        }, 0)
        assert.ok(Math.abs(total - 1600 * 900) < 1, `${mode} close ${id} area ${total}`)
      }
    }
  })

  it('closing the last tile empties the tree', () => {
    assert.equal(remove(leaf('a'), 'a'), null)
  })
})

describe('focus moves', () => {
  const grid = build(4, 'largest') // t1 TL, t2 TR, t4 BL, t3 BR

  it('moves within a 2x2 grid', () => {
    const t = grid.tree
    assert.equal(neighbor(t, AREA, 't1', 'right'), 't2')
    assert.equal(neighbor(t, AREA, 't1', 'down'), 't4')
    assert.equal(neighbor(t, AREA, 't2', 'down'), 't3')
    assert.equal(neighbor(t, AREA, 't3', 'left'), 't4')
    assert.equal(neighbor(t, AREA, 't4', 'up'), 't1')
  })

  it('returns null at the edge', () => {
    assert.equal(neighbor(grid.tree, AREA, 't1', 'left'), null)
    assert.equal(neighbor(grid.tree, AREA, 't1', 'up'), null)
  })

  it('breaks equal-overlap ties by recency', () => {
    const { tree } = build(3, 'largest') // t1 left, t2 TR, t3 BR
    assert.equal(neighbor(tree, AREA, 't1', 'right', { history: ['t3', 't2', 't1'] }), 't3')
    assert.equal(neighbor(tree, AREA, 't1', 'right', { history: ['t2', 't3', 't1'] }), 't2')
  })
})

describe('tree edits', () => {
  it('toggleSplit flips the split holding the tile', () => {
    const t = toggleSplit(split('row', leaf('a'), leaf('b')), 'b')
    assert.deepEqual(box(t, 'a'), [0, 0, 1600, 450])
    assert.deepEqual(box(t, 'b'), [0, 450, 1600, 450])
  })

  it('equalize resets every ratio to 0.5', () => {
    const t = equalize(split('row', leaf('a'), split('column', leaf('b'), leaf('c'), 0.2), 0.8))
    assert.deepEqual(box(t, 'a'), [0, 0, 800, 900])
    assert.deepEqual(box(t, 'b'), [800, 0, 800, 450])
  })

  it('swap exchanges two tiles', () => {
    const t = swap(split('row', leaf('a'), leaf('b')), 'a', 'b')
    assert.deepEqual(leaves(t), ['b', 'a'])
  })
})

describe('core projection adapter', () => {
  const core = {
    type: 'split', id: 's1', orientation: 'row', weights: [1, 1, 2],
    children: [
      { type: 'group', id: 'g1', panes: ['sessions'], active: 'sessions' },
      { type: 'group', id: 'g2', panes: ['workspace', 'session-tile:x'], active: 'workspace' },
      { type: 'group', id: 'g3', panes: ['session-tile:y'], active: 'session-tile:y' }
    ]
  }

  it('reproduces n-ary weights as a binary chain', () => {
    const t = fromCore(core)
    assert.deepEqual(box(t, 'sessions'), [0, 0, 400, 900])
    assert.deepEqual(box(t, 'workspace'), [400, 0, 400, 900])
    assert.deepEqual(box(t, 'session-tile:y'), [800, 0, 800, 900])
  })

  it('finds the core split holding a pane, and lists every split', () => {
    assert.equal(coreParentSplit(core, 'session-tile:x').id, 's1')
    assert.equal(coreParentSplit(core, 'nope'), null)
    assert.deepEqual(coreSplits(core), [['s1', 3]])
  })

  it('lists open sessions in tile order, including stacked tabs', () => {
    assert.deepEqual(openSessions(core, 'm'), [
      { paneId: 'workspace', storedSessionId: 'm', visible: true },
      { paneId: 'session-tile:x', storedSessionId: 'x', visible: false },
      { paneId: 'session-tile:y', storedSessionId: 'y', visible: true }
    ])
  })
})

describe('fromCore keep filter', () => {
  const core = {
    type: 'split', id: 'root', orientation: 'row', weights: [1, 2, 2, 1],
    children: [
      { type: 'group', id: 'gs', panes: ['sessions', 'tiled-sessions:pane'], active: 'sessions' },
      { type: 'group', id: 'gm', panes: ['workspace'], active: 'workspace' },
      { type: 'group', id: 'ga', panes: ['session-tile:a'], active: 'session-tile:a' },
      { type: 'group', id: 'gt', panes: ['terminal'], active: 'terminal', minimized: true }
    ]
  }
  const chat = id => id === 'workspace' || id.startsWith('session-tile:')

  it('keeps only chat panes and renormalizes the split around them', () => {
    const t = fromCore(core, chat)
    assert.deepEqual(leaves(t), ['workspace', 'session-tile:a'])
    assert.equal(t.ratio, 0.5)
  })

  it('drops minimized zones even without a filter', () => {
    assert.deepEqual(leaves(fromCore(core)), ['sessions', 'workspace', 'session-tile:a'])
  })
})

describe('mergeSessionRows', () => {
  it('unions live and stored rows by id, newest first, keeping a known title', () => {
    const live = [{ id: 'a', title: '', started_at: 3, message_count: 4 }]
    const stored = [{ id: 'a', title: 'Alpha', started_at: 3, message_count: 2 }, { id: 'b', title: 'Beta', started_at: 5, message_count: 1 }]
    const rows = mergeSessionRows(live, stored)
    assert.deepEqual(rows.map(r => [r.id, r.title]), [['b', 'Beta'], ['a', 'Alpha']])
    assert.equal(rows[1].message_count, 4)
  })

  it('drops empty untitled drafts and rows without an id', () => {
    assert.deepEqual(mergeSessionRows([{ id: 'x', title: '', message_count: 0 }, { title: 'no id' }], []), [])
  })
})

describe('equalizePlan', () => {
  const chat = id => id === 'workspace' || id.startsWith('session-tile:')
  const g = (id, panes, extra = {}) => ({ type: 'group', id, panes, active: panes[0], ...extra })

  it('evens out chat children only; sidebar and rails keep their weight', () => {
    const core = {
      type: 'split', id: 'root', orientation: 'row', weights: [1, 1.7, 0.85, 1.25],
      children: [
        g('gs', ['sessions']),
        { type: 'split', id: 'col', orientation: 'column', weights: [3, 1], children: [g('a', ['session-tile:a']), g('b', ['session-tile:b'])] },
        g('gm', ['workspace']),
        g('rail', ['files'])
      ]
    }
    const plan = Object.fromEntries(equalizePlan(core, chat))
    assert.deepEqual(plan.root, [1, 1.275, 1.275, 1.25])
    assert.deepEqual(plan.col, [2, 2])
  })

  it('returns nothing when already even or with a single chat', () => {
    const even = { type: 'split', id: 's', orientation: 'row', weights: [1, 1], children: [g('a', ['workspace']), g('b', ['session-tile:b'])] }
    assert.deepEqual(equalizePlan(even, chat), [])
    assert.deepEqual(equalizePlan(g('a', ['workspace']), chat), [])
  })
})

// ---- layouts ---------------------------------------------------------------

const WIDE = { x: 0, y: 0, w: 1640, h: 1000 }
const ids = n => Array.from({ length: n }, (_, i) => `p${i}`)

describe('layouts', () => {
  it('grid: every tile has the same height, and full rows the same size', () => {
    for (let n = 2; n <= 9; n++) {
      const r = [...specRects(arrangement('grid', ids(n), WIDE), WIDE).values()]
      const heights = new Set(r.map(x => Math.round(x.h)))
      assert.equal(heights.size, 1, `n=${n} heights ${[...heights]}`)
      const area = r.reduce((s, x) => s + x.w * x.h, 0)
      assert.ok(Math.abs(area - WIDE.w * WIDE.h) < 1, `n=${n} fills the area`)
    }
  })

  it('grid: 4 is 2×2, 3 is three columns, 6 is 3×2 on a wide area', () => {
    assert.deepEqual(gridDims(4, WIDE), { rows: 2, cols: 2 })
    assert.deepEqual(gridDims(3, WIDE), { rows: 1, cols: 3 })
    assert.deepEqual(gridDims(6, WIDE), { rows: 2, cols: 3 })
    const four = [...specRects(arrangement('grid', ids(4), WIDE), WIDE).values()]
    assert.ok(four.every(x => Math.round(x.w) === 820 && Math.round(x.h) === 500))
  })

  it('master: first pane takes the ratio on the left, the rest stack evenly', () => {
    const r = specRects(arrangement('master', ids(4), WIDE, { masterRatio: 0.6 }), WIDE)
    assert.equal(Math.round(r.get('p0').w), 984)
    assert.equal(Math.round(r.get('p0').h), 1000)
    for (const p of ['p1', 'p2', 'p3']) {
      assert.equal(Math.round(r.get(p).x), 984)
      assert.equal(Math.round(r.get(p).h), 333)
    }
  })

  it('dwindle: each tile halves the previous along its longer side', () => {
    const r = specRects(arrangement('dwindle', ids(4), WIDE), WIDE)
    assert.deepEqual([r.get('p0').w, r.get('p0').h], [820, 1000])
    assert.deepEqual([r.get('p1').w, r.get('p1').h], [820, 500])
    assert.deepEqual([r.get('p2').w, r.get('p2').h], [410, 500])
    assert.deepEqual([r.get('p3').w, r.get('p3').h], [410, 500])
  })

  it('columns: equal widths, full height', () => {
    const r = [...specRects(arrangement('columns', ids(3), WIDE), WIDE).values()]
    assert.ok(r.every(x => Math.abs(x.w - WIDE.w / 3) < 1e-6 && x.h === 1000))
  })

  it('one pane is a bare leaf; none is null', () => {
    assert.deepEqual(arrangement('grid', ['a'], WIDE), { pane: 'a' })
    assert.equal(arrangement('grid', [], WIDE), null)
  })

  it('chatZones lists all-chat groups with their active pane, skipping chrome', () => {
    const root = {
      type: 'split', id: 's', orientation: 'row', weights: [1, 1, 1, 1], children: [
        { type: 'group', id: 'side', panes: ['sessions'], active: 'sessions' },
        { type: 'group', id: 'g1', panes: ['workspace'], active: 'workspace' },
        { type: 'group', id: 'g2', panes: ['session-tile:a', 'session-tile:b'], active: 'session-tile:b' },
        { type: 'group', id: 'g3', panes: ['terminal'], active: 'terminal' }
      ]
    }
    assert.deepEqual(chatZones(root), [{ groupId: 'g1', pane: 'workspace' }, { groupId: 'g2', pane: 'session-tile:b' }])
  })

  it('reconcileOrder keeps known order, drops closed, appends or inserts new', () => {
    assert.deepEqual(reconcileOrder(['a', 'b', 'c'], ['c', 'a', 'd']), ['a', 'c', 'd'])
    assert.deepEqual(reconcileOrder(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], 'a'), ['a', 'd', 'b', 'c'])
  })

  it('promote, swapOrder and nextLayout', () => {
    assert.deepEqual(promote(['a', 'b', 'c'], 'c'), ['c', 'a', 'b'])
    assert.deepEqual(swapOrder(['a', 'b', 'c'], 'a', 'c'), ['c', 'b', 'a'])
    assert.equal(nextLayout('columns'), 'grid')
    assert.equal(nextLayout('grid'), 'master')
  })
})

describe('groupIdOfPane', () => {
  it('finds the zone holding a pane', () => {
    const root = { type: 'split', id: 's', orientation: 'row', weights: [1, 1], children: [
      { type: 'group', id: 'g1', panes: ['workspace'], active: 'workspace' },
      { type: 'group', id: 'g2', panes: ['session-tile:a', 'session-tile:b'], active: 'session-tile:a' }
    ] }
    assert.equal(groupIdOfPane(root, 'session-tile:b'), 'g2')
    assert.equal(groupIdOfPane(root, 'nope'), null)
  })
})
