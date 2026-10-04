/**
 * generic 适配器测试 —— 重点是 promptMode 三种取值的参数拼装，
 * 以及 file 模式真的能把多行指令完整送到 CLI 手里。
 *
 * 为什么值得单独测 file 模式：
 * 多行 prompt 走命令行参数会被 cmd.exe 就地截断，**且退出码仍是 0**。
 * file 模式就是为绕开它加的，一旦它悄悄坏了，"任务跑成功但产出是垃圾"
 * 这个最危险的失败模式就会回来。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { GenericAdapter, parsePayload } from '../src/adapters/generic.js'

/**
 * 真实成员配置 —— 用**真配置**跑测试。
 * 否则会出现"配置里 costPath 写错了、但测试用假配置所以没发现"这种最没价值的绿。
 */
const MEMBERS = Object.fromEntries(
  ((raw) => (Array.isArray(raw) ? raw : raw.members || []))(
    JSON.parse(readFileSync(new URL('../src/config/members.json', import.meta.url), 'utf8'))
  ).map((m) => [m.id, m])
)

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try {
    await fn()
    console.log('  ok   ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + '\n       ' + (e.message || e))
    fail++
  }
}

const mk = (over = {}) => new GenericAdapter({ id: 'test', command: 'echo', ...over })

/** 系统临时目录里 agenthub 留下的任务文件数（用来验证清理） */
const taskTmpDirs = () =>
  readdirSync(tmpdir()).filter((n) => n.startsWith('agenthub-task-'))

console.log('\n[buildArgs：三种 promptMode 的分别]')
await t('stdin：模板里不放占位符，指令不进命令行', () => {
  const a = mk({ promptMode: 'stdin', argsTemplate: ['-p'] })
  assert.deepEqual(a.buildArgs({ prompt: '多行\n指令' }), ['-p'])
})

await t('arg：{prompt} 展开成指令原文', () => {
  const a = mk({ promptMode: 'arg', argsTemplate: ['run', '{prompt}'] })
  assert.deepEqual(a.buildArgs({ prompt: '任务A' }), ['run', '任务A'])
})

await t('file：{promptFile} 展开成**路径**，而不是内容', () => {
  const a = mk({ promptMode: 'file', argsTemplate: ['run', '--file', '{promptFile}'] })
  const args = a.buildArgs({ prompt: '任务A', promptFilePath: 'C:/tmp/task.txt' })
  assert.deepEqual(args, ['run', '--file', 'C:/tmp/task.txt'])
  // 关键：指令原文绝不能被拼进命令行
  assert.ok(!args.some((x) => String(x).includes('任务A')))
})

await t('file：没有 promptFilePath 时占位符被丢掉，不会变成字面量 {promptFile}', () => {
  const a = mk({ promptMode: 'file', argsTemplate: ['run', '--file', '{promptFile}'] })
  assert.deepEqual(a.buildArgs({ prompt: '任务A' }), ['run', '--file'])
})

await t('权限参数与 workdir 追加在模板之后', () => {
  const a = mk({
    promptMode: 'stdin',
    argsTemplate: ['-p'],
    permissionArgs: { plan: ['--mode', 'plan'] },
    defaultPermission: 'plan',
    workdirFlag: '--working-dir',
  })
  assert.deepEqual(a.buildArgs({ prompt: 'x', workdir: 'D:/w' }), [
    '-p', '--mode', 'plan', '--working-dir', 'D:/w',
  ])
})

console.log('\n[run：file 模式端到端]')
await t('多行指令被完整送到 CLI（这正是 file 模式存在的理由）', async () => {
  // 用 Windows 内置的 type 命令读文件：它读什么就说明 CLI 收到了什么
  const a = new GenericAdapter({
    id: 'type-test',
    command: 'type',
    promptMode: 'file',
    argsTemplate: ['{promptFile}'],
  })
  const multi = '第一行指令\n第二行指令\n第三行指令'
  const r = await a.run({ prompt: multi })

  assert.equal(r.status, 'ok')
  assert.match(r.text, /第一行指令/)
  assert.match(r.text, /第二行指令/)
  assert.match(r.text, /第三行指令/)
})

await t('临时文件用完即删，不留在系统 temp 里', async () => {
  const before = taskTmpDirs().length
  const a = new GenericAdapter({
    id: 'type-test',
    command: 'type',
    promptMode: 'file',
    argsTemplate: ['{promptFile}'],
  })
  await a.run({ prompt: 'x'.repeat(2000) })
  const after = taskTmpDirs().length
  assert.equal(after, before, `临时目录数量应回落到 ${before}，实际 ${after}`)
})

await t('模板里出现 {promptFile} 时，即使 promptMode 没写成 file 也会走文件路径', async () => {
  const a = new GenericAdapter({
    id: 'type-test',
    command: 'type',
    promptMode: 'stdin', // 故意不写 file
    argsTemplate: ['{promptFile}'],
  })
  const r = await a.run({ prompt: '隐式触发多行\n第二行' })
  assert.equal(r.status, 'ok')
  assert.match(r.text, /隐式触发多行/)
  assert.match(r.text, /第二行/)
})

await t('命令不存在时不抛异常，返回 failed', async () => {
  const a = new GenericAdapter({
    id: 'nope',
    command: 'this-command-does-not-exist-xyz',
    promptMode: 'stdin',
    argsTemplate: ['-p'],
  })
  const r = await a.run({ prompt: 'x' })
  assert.equal(r.status, 'failed')
  assert.equal(r.text === '' || typeof r.text === 'string', true)
})

// ─────────────────── parsePayload：成本与 token 的诚实（2026-09-29 补）───
//
// 背景：qoder 按**积分**计费，它的 CLI 里 `total_cost_usd` 恒为 0、
// `usage` 里的 token 也全是 0，真实消耗在 `total_credits`。
// 把这些 0 当测量值 → 报告会印出 $0.0000，等于宣称"这次免费"，
// 而那次调用跑了 6.5 分钟、烧掉了 0.16 积分。
//
// 样本是**真实调用的原始输出**：tests/fixtures/qoder-result.json
// （qodercli -p -o json 的 stdout 原文）。

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/qoder-result.json', import.meta.url), 'utf8'))
const QODER_SPEC = { outputFormat: 'json', textPath: 'result', costPath: 'total_cost_usd', creditsPath: 'total_credits', ...MEMBERS.qoder }

console.log('\n[parsePayload：qoder 真实样本（积分计费）]')

await t('★★ total_cost_usd 恒为 0 → cost.usd **不设置**，而不是设成 0', () => {
  const r = parsePayload(FIXTURE.payload, QODER_SPEC)
  assert.equal(FIXTURE.payload.total_cost_usd, 0, '前提：真实样本里这个字段就是 0')
  assert.equal('usd' in r.cost, false, '0 不是"免费"，是"这个口径不适用"——必须留空')
  assert.equal(r.cost.usd, undefined)
})

await t('★★ 真实消耗落在 credits 上', () => {
  const r = parsePayload(FIXTURE.payload, QODER_SPEC)
  assert.equal(r.cost.credits, 0.157647882)
})

await t('★★ token 全是 0 → 不上报 token（不是记成 0）', () => {
  const r = parsePayload(FIXTURE.payload, QODER_SPEC)
  assert.equal(FIXTURE.payload.usage.input_tokens, 0, '前提：真实样本里 token 就是 0')
  assert.equal('inputTokens' in r.cost, false)
  assert.equal('outputTokens' in r.cost, false)
})

await t('textPath: result 取到正文', () => {
  assert.equal(parsePayload(FIXTURE.payload, QODER_SPEC).text, 'ok')
})

await t('permission_denials 能取到（qoder 也有这个结构化信号）', () => {
  const r = parsePayload(FIXTURE.payload, QODER_SPEC)
  assert.deepEqual(r.permissionDenials, [])
})

console.log('\n[parsePayload：不变量]')

await t('真的报了正数美元成本 → 记下来（别把好数据也丢了）', () => {
  const r = parsePayload({ result: 'x', total_cost_usd: 0.2056, usage: { input_tokens: 1234, output_tokens: 56 } }, QODER_SPEC)
  assert.equal(r.cost.usd, 0.2056)
  assert.equal(r.cost.inputTokens, 1234)
  assert.equal(r.cost.outputTokens, 56)
})

await t('is_error=true → errorKind，且正文仍取出', () => {
  const r = parsePayload({ type: 'result', subtype: 'error_max_turns', is_error: true, result: '已达到最大轮次' }, QODER_SPEC)
  assert.equal(r.errorKind, 'error_max_turns')
  assert.equal(r.text, '已达到最大轮次')
})

await t('payload 为 null → 退回纯文本，cost 为空对象', () => {
  const r = parsePayload(null, QODER_SPEC, '原始文本')
  assert.equal(r.text, '原始文本')
  assert.deepEqual(r.cost, {})
  assert.equal(r.permissionDenials, null)
  assert.equal(r.errorKind, null)
})

await t('配置里没写 costPath / creditsPath 时不炸（cursor / trae 就是这种）', () => {
  const r = parsePayload({ result: 'ok', total_cost_usd: 0.1 }, { textPath: 'result' })
  assert.equal(r.text, 'ok')
  assert.deepEqual(r.cost, {}, '没配路径就不该猜任何成本字段')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
