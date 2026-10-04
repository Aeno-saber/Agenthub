/**
 * MemberRegistry 单元测试 —— 重点是探活前的环境前置检查
 *
 * 运行：node --test tests/registry.test.mjs
 *
 * 背景（真跑协同任务时踩到）：trae 的探活是 `trae-cli --version`，这条命令不碰 API Key，
 * 于是永远返回成功 —— 界面绿灯、规划者放心派活，**直到执行阶段才炸**，
 * 炸出来还是一段 Python 堆栈（openai.OpenAIError: Missing credentials）。
 * 下面这组断言就是钉住"缺密钥必须在探活阶段就被判不可用"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MemberRegistry, precheckEnv, loadRegistry } from '../src/adapters/index.js'

// ── 造一个不真跑子进程的假适配器 ──
class FakeAdapter {
  constructor(spec) { this.spec = spec; this.probeCalls = 0 }
  get id() { return this.spec.id }
  get name() { return this.spec.name || this.spec.id }
  get isEnabled() { return this.spec.enabled !== false }
  get capabilities() { return this.spec.capabilities || [] }
  async probe() { this.probeCalls++; return { available: true, version: 'fake-1.0' } }
}

/** 用一个假注册表替换掉真实的适配器映射，避免真去 spawn 进程 */
function mkRegistry(members) {
  const reg = new MemberRegistry({ members })
  reg.adapters = new Map(members.map((s) => [s.id, new FakeAdapter(s)]))
  return reg
}

// ------------------------------------------------------------ precheckEnv

test('precheckEnv：没声明 requiredEnv → 不拦截', () => {
  assert.equal(precheckEnv({ id: 'x' }, {}), null)
  assert.equal(precheckEnv({ id: 'x', requiredEnv: [] }, {}), null)
})

test('precheckEnv：声明的变量都在 → 不拦截', () => {
  assert.equal(precheckEnv({ requiredEnv: ['K1', 'K2'] }, { K1: 'a', K2: 'b' }), null)
})

test('precheckEnv：缺一个 → 拦截，并说清缺哪个', () => {
  const r = precheckEnv({ requiredEnv: ['K1', 'K2'] }, { K1: 'a' })
  assert.equal(r.available, false)
  assert.match(r.reason, /K2/)
  assert.equal(r.reason.includes('K1'), false, '已有的变量不该出现在"缺少"里')
})

test('precheckEnv：成员自带的 spec.env 也算数', () => {
  const r = precheckEnv({ requiredEnv: ['K1'], env: { K1: 'inline' } }, {})
  assert.equal(r, null)
})

// ------------------------------------------------------------ 注册表集成

test('★ 探活：requiredEnv 缺失时直接判不可用，且不去真跑探活命令', async () => {
  const reg = mkRegistry([
    { id: 'trae', adapter: 'generic', enabled: true, requiredEnv: ['AGENTHUB_TEST_DEFINITELY_MISSING'] },
  ])
  const r = await reg.probeOne('trae')
  assert.equal(r.available, false)
  assert.match(r.reason, /AGENTHUB_TEST_DEFINITELY_MISSING/)
  assert.equal(reg.get('trae').probeCalls, 0, '环境检查没过就不该浪费一次子进程调用')
})

test('探活：requiredEnv 满足 → 正常走真实探测', async () => {
  const KEY = 'AGENTHUB_TEST_PRESENT_KEY'
  process.env[KEY] = 'dummy'
  try {
    const reg = mkRegistry([{ id: 'x', adapter: 'generic', enabled: true, requiredEnv: [KEY] }])
    const r = await reg.probeOne('x')
    assert.equal(r.available, true)
    assert.equal(reg.get('x').probeCalls, 1)
  } finally { delete process.env[KEY] }
})

test('探活：禁用成员一律不可用，且不跑探测', async () => {
  const reg = mkRegistry([{ id: 'dsh', adapter: 'generic', enabled: false }])
  const r = await reg.probeOne('dsh')
  assert.equal(r.available, false)
  assert.match(r.reason, /禁用/)
  assert.equal(reg.get('dsh').probeCalls, 0)
})

test('探活：probeAll 与 probeOne 结果一致（同一条路径）', async () => {
  const reg = mkRegistry([
    { id: 'a', adapter: 'generic', enabled: true },
    { id: 'b', adapter: 'generic', enabled: true, requiredEnv: ['AGENTHUB_TEST_DEFINITELY_MISSING'] },
  ])
  const all = await reg.probeAll()
  assert.equal(all.a.available, true)
  assert.equal(all.b.available, false)
  const one = await reg.probeOne('b')
  assert.equal(one.available, false, '两条路径必须给出一致结论')
  assert.equal(one.reason, all.b.reason)
})

test('探活：缓存生效（第二次 probeAll 不重复探测）', async () => {
  const reg = mkRegistry([{ id: 'a', adapter: 'generic', enabled: true }])
  await reg.probeAll()
  await reg.probeAll()
  assert.equal(reg.get('a').probeCalls, 1)
  await reg.probeAll({ force: true })
  assert.equal(reg.get('a').probeCalls, 2, 'force 应绕过缓存')
})

test('available()：只返回实测可用的成员', async () => {
  const reg = mkRegistry([
    { id: 'a', adapter: 'generic', enabled: true },
    { id: 'b', adapter: 'generic', enabled: true, requiredEnv: ['AGENTHUB_TEST_DEFINITELY_MISSING'] },
    { id: 'c', adapter: 'generic', enabled: false },
  ])
  const ids = (await reg.available()).map((a) => a.id)
  assert.deepEqual(ids, ['a'])
})

test('probeOne：不存在的成员返回 null', async () => {
  const reg = mkRegistry([])
  assert.equal(await reg.probeOne('nope'), null)
})

// ------------------------------------------------------------ 真实配置的健全性

test('真实 members.json：trae 声明了 requiredEnv: DOUBAO_API_KEY', () => {
  // trae-agent 按 provider 名推导环境变量名，config 里 provider 是 doubao，所以只认 DOUBAO_API_KEY。
  // 这条断言防止以后有人"顺手"把它删掉 —— 删掉就等于恢复了"假绿"。
  const reg = loadRegistry()
  const trae = reg.get('trae')
  assert.ok(trae, '配置里应有 trae')
  assert.deepEqual(trae.spec.requiredEnv, ['DOUBAO_API_KEY'])
})

test('真实 members.json：能全部实例化，且 id 与 name 都不缺', () => {
  const reg = loadRegistry()
  assert.ok(reg.list().length >= 5)
  for (const a of reg.list()) {
    assert.ok(a.id, '每个成员都要有 id')
    assert.ok(a.name, `${a.id} 缺 name`)
  }
})
