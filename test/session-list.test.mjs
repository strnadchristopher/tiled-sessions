import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSessionRows, groupBySource, isBackgroundSource } from '../src/engine.mjs'

// Execute the actual source function without React/SDK dependencies.
const source = readFileSync(new URL('../src/plugin.src.mjs', import.meta.url), 'utf8')
const listSource = source.slice(source.indexOf('async function listRows()'), source.indexOf('\nfunction createController'))
const load = request => runInNewContext(`${listSource}\nlistRows`, {
  host: { request }, mergeSessionRows, isBackgroundSource
})

test('legacy limit contract retrieves 200 chats behind 450 newer cron runs', async () => {
  const cron = Array.from({ length: 450 }, (_, i) => ({ id: `cron-${i}`, source: 'cron', started_at: 1000 - i }))
  const chats = Array.from({ length: 205 }, (_, i) => ({ id: `chat-${i}`, source: i === 0 ? 'telegram' : 'desktop', started_at: 500 - i }))
  const calls = []
  const list = load(async (method, params) => {
    assert.equal(method, 'session.list')
    // Installed tui_gateway/methods_session.py reads limit and ignores scope;
    // it has no source filtering or offset. No invented filter is accepted here.
    assert.ok(Object.keys(params).every(k => ['limit', 'scope'].includes(k)))
    calls.push(params.limit)
    return { sessions: [...cron, ...chats].slice(0, params.limit) }
  })
  const { sessions } = await list()
  const grouped = groupBySource(sessions)
  assert.deepEqual(calls.sort((a, b) => a - b), [200, 200, 400, 400, 800, 800])
  assert.equal(grouped.sessions.length, 199)
  assert.equal(grouped.platforms[0].rows[0].id, 'chat-0')
  assert.equal(grouped.cron.length, 450)
  assert.equal(new Set(sessions.map(r => r.id)).size, 650)
})

test('canonical limit rejection retains live/stored identity and source', async () => {
  const list = load(async (_, params) => {
    if (params.limit > 200) throw new Error('invalid_params')
    return { sessions: params.scope === 'stored'
      ? [{ id: 'root', resolved_id: 'tip', source: 'cron', title: 'Job' }]
      : [{ id: 'root', source: '', title: '', running: true }] }
  })
  const { sessions } = await list()
  assert.deepEqual(sessions, [{ id: 'root', resolved_id: 'tip', source: 'cron', title: 'Job', running: true }])
  assert.equal(groupBySource(sessions).sessions.length, 0)
})

test('canonical full window cannot be paged but is retained after rejection', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), source: 'cron' }))
  const list = load(async (_, { limit }) => {
    if (limit > 200) throw new Error('invalid_params')
    return { sessions: rows }
  })
  assert.equal((await list()).sessions.length, 200)
})

test('background source labels never enter Sessions; cron remains accessible', () => {
  const rows = ['cron', ' CRON ', 'subagent', 'kanban', 'tool', 'oneshot', 'cli', 'local', 'unknown']
    .map((source, id) => ({ id: String(id), source }))
  const grouped = groupBySource(rows)
  assert.deepEqual(grouped.sessions.map(r => r.source), ['cli', 'local', 'unknown'])
  assert.equal(grouped.cron.length, 2)
})

// Legacy _listing_rows reads 2*limit, denies internal sources, then slices.
const legacyListing = (rows, limit) => rows.slice(0, 2 * limit)
  .filter(row => !['tool', 'subagent', 'kanban', 'oneshot'].includes(row.source))
  .slice(0, limit)

for (const toolCount of [350, 450, 10000]) {
  test(`legacy probing handles ${toolCount} newer internal runs within a finite window`, async () => {
    const rows = [
      ...Array.from({ length: toolCount }, (_, i) => ({ id: `tool-${i}`, source: 'tool' })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `cron-${i}`, source: 'cron' })),
      ...Array.from({ length: 200 }, (_, i) => ({ id: `chat-${i}`, source: 'desktop' }))
    ]
    const calls = []
    const list = load(async (method, params) => {
      assert.equal(method, 'session.list')
      assert.ok(Object.keys(params).every(k => ['limit', 'scope'].includes(k)))
      calls.push(params.limit)
      return { sessions: legacyListing(rows, params.limit) }
    })
    assert.equal(legacyListing(rows, 200).length, toolCount === 350 ? 50 : 0)
    const { sessions } = await list()
    assert.equal(groupBySource(sessions).sessions.length, toolCount === 10000 ? 0 : 200)
    assert.equal(groupBySource(sessions).cron.length, toolCount === 10000 ? 0 : 50)
    assert.deepEqual(calls.sort((a, b) => a - b), toolCount === 10000
      ? [200, 200, 400, 400, 800, 800, 1600, 1600, 3200, 3200]
      : [200, 200, 400, 400])
  })
}
