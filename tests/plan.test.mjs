/**
 * plan.js 单元测试 —— validatePlan / findCycle / layers
 *
 * 运行：node --test tests/plan.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { validatePlan, findCycle, layers } from '../src/engine/plan.js'

/** 造一个合法子任务，测试里只覆盖关心的字段 */
const st = (id, dependsOn = [], extra = {}) => ({
  id,
  memberId: 'claude',
  prompt: `做 ${id}`,
  ...(dependsOn.length ? { dependsOn } : {}),
  ...extra,
})

/** 造一个合法计划 */
const plan = (subtasks, extra = {}) => ({ goal: '测试目标', subtasks, ...extra })

/** 把分层结果压成 id 数组，方便断言 */
const ids = (ls) => ls.map((layer) => layer.map((s) => s.id))

// ---------------------------------------------------------------- validatePlan

test('validatePlan：正常计划通过', () => {
  const res = validatePlan(plan([st('s1'), st('s2', ['s1']), st('s3', ['s1', 's2'])]))
  assert.equal(res.ok, true)
  assert.deepEqual(res.errors, [])
})

test('validatePlan：接受真实的 real-plan.json', () => {
  const real = JSON.parse(readFileSync(new URL('./real-plan.json', import.meta.url), 'utf8'))
  const res = validatePlan(real)
  assert.equal(res.ok, true, `真实计划不应报错：${res.errors.join('；')}`)
})

test('validatePlan：plan 不是对象', () => {
  for (const bad of [null, undefined, 'plan', 42]) {
    const res = validatePlan(bad)
    assert.equal(res.ok, false)
    assert.deepEqual(res.errors, ['plan 不是对象'])
  }
})

test('validatePlan：缺少 goal', () => {
  const res = validatePlan({ subtasks: [st('s1')] })
  assert.equal(res.ok, false)
  assert.ok(res.errors.includes('缺少 goal（任务目标）'))
})

test('validatePlan：subtasks 为空或缺失', () => {
  assert.ok(validatePlan(plan([])).errors.includes('subtasks 为空'))
  assert.ok(validatePlan({ goal: 'g' }).errors.includes('subtasks 为空'))
  // 非数组也按空处理
  assert.ok(validatePlan({ goal: 'g', subtasks: 'x' }).errors.includes('subtasks 为空'))
})

test('validatePlan：子任务缺 id', () => {
  const res = validatePlan(plan([{ memberId: 'claude', prompt: '做点事' }]))
  assert.equal(res.ok, false)
  assert.ok(res.errors.includes('存在子任务缺少 id'))
})

test('validatePlan：缺 id 的子任务不再连带报 memberId/prompt 缺失，其他子任务照常检查', () => {
  const res = validatePlan(plan([
    { memberId: 'claude', prompt: '做点事' }, // 缺 id
    { id: 's2', memberId: 'claude' },          // 缺 prompt
  ]))
  assert.deepEqual(res.errors, ['存在子任务缺少 id', '子任务 s2 缺少 prompt'])
})

test('validatePlan：id 重复', () => {
  const res = validatePlan(plan([st('s1'), st('s1'), st('s1')]))
  assert.ok(res.errors.includes('子任务 id 重复：s1'))
})

test('validatePlan：缺 memberId 与 prompt', () => {
  const res = validatePlan(plan([{ id: 's1', prompt: 'p' }, { id: 's2', memberId: 'claude' }]))
  assert.deepEqual(res.errors, ['子任务 s1 缺少 memberId', '子任务 s2 缺少 prompt'])
})

test('validatePlan：permission 合法时不报错，非法时报错', () => {
  const ok = validatePlan(plan([st('s1', [], { permission: 'readonly' }), st('s2', [], { permission: 'full' })]))
  assert.equal(ok.ok, true)

  const bad = validatePlan(plan([st('s1', [], { permission: 'root' })]))
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.includes('子任务 s1 的 permission 非法：root'))
})

test('validatePlan：依赖不存在的 id', () => {
  const res = validatePlan(plan([st('s1', ['s9'])]))
  assert.equal(res.ok, false)
  assert.ok(res.errors.includes('子任务 s1 依赖了不存在的 s9'))
})

test('validatePlan：依赖自己', () => {
  const res = validatePlan(plan([st('s1', ['s1'])]))
  assert.equal(res.ok, false)
  assert.ok(res.errors.includes('子任务 s1 依赖了自己'))
})

test('validatePlan：依赖成环', () => {
  const res = validatePlan(plan([st('s1', ['s3']), st('s2', ['s1']), st('s3', ['s2'])]))
  assert.equal(res.ok, false)
  const cyc = res.errors.find((e) => e.startsWith('依赖成环：'))
  assert.ok(cyc, `应报出环，实际：${JSON.stringify(res.errors)}`)
  // 环序列首尾相同，且三个 id 都在环上
  const order = cyc.replace('依赖成环：', '').split(' → ')
  assert.equal(order[0], order[order.length - 1])
  assert.deepEqual(new Set(order), new Set(['s1', 's2', 's3']))
})

test('validatePlan：一次报全所有问题', () => {
  const res = validatePlan(plan([
    { memberId: 'claude', prompt: '缺 id' },
    st('s2'),                          // 孤立合法点，制造“依赖不存在”的下游错误
    st('s3', ['nope'], { permission: 'root' }),
  ], {}))
  assert.equal(res.ok, false)
  assert.ok(res.errors.includes('存在子任务缺少 id'))
  assert.ok(res.errors.includes('子任务 s3 依赖了不存在的 nope'))
  assert.ok(res.errors.includes('子任务 s3 的 permission 非法：root'))
})

test('validatePlan：dependsOn 缺省视为无依赖', () => {
  const res = validatePlan(plan([{ id: 's1', memberId: 'claude', prompt: 'p' }]))
  assert.equal(res.ok, true)
})

// ------------------------------------------------------------------- findCycle

test('findCycle：无依赖、链式、菱形都无环', () => {
  assert.equal(findCycle([st('s1'), st('s2')]), null)
  assert.equal(findCycle([st('s1'), st('s2', ['s1']), st('s3', ['s2'])]), null)
  assert.equal(findCycle([st('a'), st('b', ['a']), st('c', ['a']), st('d', ['b', 'c'])]), null)
  assert.equal(findCycle([]), null)
})

test('findCycle：两节点互指成环', () => {
  const cyc = findCycle([st('a', ['b']), st('b', ['a'])])
  assert.ok(Array.isArray(cyc))
  assert.equal(cyc[0], cyc[cyc.length - 1])
  assert.deepEqual(new Set(cyc), new Set(['a', 'b']))
})

test('findCycle：三节点环上的每个节点都能作为入口', () => {
  const cyc = findCycle([st('a', ['c']), st('b', ['a']), st('c', ['b'])])
  assert.ok(cyc)
  assert.equal(cyc[0], cyc[cyc.length - 1])
  assert.equal(cyc.length, 4) // a → b → c → a
})

test('findCycle：自依赖也算环', () => {
  const cyc = findCycle([st('s1', ['s1'])])
  assert.deepEqual(cyc, ['s1', 's1'])
})

test('findCycle：链尾挂环，环外节点不进结果', () => {
  const cyc = findCycle([st('root'), st('a', ['root', 'b']), st('b', ['a'])])
  assert.ok(cyc)
  assert.ok(!cyc.includes('root'))
  assert.deepEqual(new Set(cyc), new Set(['a', 'b']))
})

test('findCycle：指向不存在节点的依赖不会误报', () => {
  assert.equal(findCycle([st('s1', ['ghost'])]), null)
})

test('findCycle：不修改入参', () => {
  const input = [st('a', ['b']), st('b', ['a'])]
  const snapshot = JSON.stringify(input)
  findCycle(input)
  assert.equal(JSON.stringify(input), snapshot)
})

// --------------------------------------------------------------------- layers

test('layers：无依赖时全部落在同一层（可并行）', () => {
  const ls = layers([st('s1'), st('s2'), st('s3')])
  assert.equal(ls.length, 1)
  assert.deepEqual(ls[0].map((s) => s.id), ['s1', 's2', 's3'])
})

test('layers：单链五层', () => {
  const ls = layers([st('s1'), st('s2', ['s1']), st('s3', ['s2']), st('s4', ['s3']), st('s5', ['s4'])])
  assert.deepEqual(ids(ls), [['s1'], ['s2'], ['s3'], ['s4'], ['s5']])
})

test('layers：菱形依赖分层正确，同层可并行', () => {
  //      a
  //     / \
  //    b   c
  //     \ /
  //      d
  const ls = layers([st('a'), st('b', ['a']), st('c', ['a']), st('d', ['b', 'c'])])
  assert.deepEqual(ids(ls), [['a'], ['b', 'c'], ['d']])
})

test('layers：跨层多依赖，层级取最深的那个', () => {
  // e 同时依赖 a（第 1 层）和 c（第 2 层）→ e 必须在第 3 层
  const ls = layers([st('a'), st('b', ['a']), st('c', ['b']), st('e', ['a', 'c'])])
  assert.deepEqual(ids(ls), [['a'], ['b'], ['c'], ['e']])
})

test('layers：真实计划的批次划分（s1、s2 并行，s3 收口）', () => {
  const real = JSON.parse(readFileSync(new URL('./real-plan.json', import.meta.url), 'utf8'))
  const ls = layers(real.subtasks)
  assert.equal(ls.length, 2)
  assert.deepEqual(ls[0].map((s) => s.id), ['s1', 's2'])
  assert.deepEqual(ls[1].map((s) => s.id), ['s3'])
})

test('layers：同层内的每个 id 彼此不依赖（可并行的定义）', () => {
  const real = JSON.parse(readFileSync(new URL('./real-plan.json', import.meta.url), 'utf8'))
  const ls = layers(real.subtasks)
  for (const [i, layer] of ls.entries()) {
    const layerIds = new Set(layer.map((s) => s.id))
    for (const s of layer) {
      for (const d of s.dependsOn || []) {
        assert.ok(!layerIds.has(d), `第 ${i + 1} 层内 ${s.id} 依赖了同层的 ${d}`)
      }
    }
  }
})

test('layers：返回的是原子任务对象，不是副本', () => {
  const s1 = st('s1')
  assert.equal(layers([s1])[0][0], s1)
})

test('layers：空输入返回空数组', () => {
  assert.deepEqual(layers([]), [])
})

test('layers：成环时不返回半成品层，直接停下（不死循环）', () => {
  // a、b 互指 → 第一层就没人就绪，返回空数组，而不是死循环
  assert.deepEqual(layers([st('a', ['b']), st('b', ['a'])]), [])
})

test('layers：环外节点照常分层，环上节点不出现', () => {
  const ls = layers([st('root'), st('x', ['root', 'y']), st('y', ['x'])])
  assert.deepEqual(ids(ls), [['root']])
})
