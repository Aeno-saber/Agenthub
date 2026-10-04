/**
 * 命令行进度日志的测试 —— 屏幕上到底印了什么。
 *
 * 运行：node --test tests/cli-logger.test.mjs
 *
 * ## 这个文件为什么存在
 *
 * 这块逻辑原来写在 `cli.js` 里面。而 `cli.js` 是个脚本 —— import 它就会跑 `main()`，
 * 所以**它从来没有被任何测试碰过**。后果是 2026-09-29 发现的：
 *
 *   报告层（trace.js）第三轮整轮都在修「把没上报印成 $0.0000」，
 *   而命令行里那句 `$${(usd || 0).toFixed(4)}` 是**另一份手写实现**，没跟着改 ——
 *   同一份数据，报告印「0.157648 积分」，终端印「$0.0000」。
 *
 * 所以这里做两件事：
 *   1. 把 logger 搬进 `src/report/logger.js`，让它能被直接 import；
 *   2. 拿桩事件断言"屏幕上印出来的字符串"，而不是断言它调用了哪个函数。
 *      断言必须落在最终给用户看的那串字上 —— 中间过程对不对，用户看不见。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeLogger } from '../src/report/logger.js'

/** 把一次日志调用的输出抓下来 —— 测的就是"用户屏幕上会看到什么" */
const capture = (evt, verbose = true) => {
  const buf = []
  const orig = console.log
  console.log = (...args) => buf.push(args.join(' '))
  try { makeLogger(verbose)(evt) } finally { console.log = orig }
  return buf.join('\n')
}

/** 造一个「按积分计费、不上报美元」的完成事件 —— qoder / trae 的真实形态 */
const finishEvt = (extra = {}) => ({
  type: 'plan-finish',
  reason: 'initial',
  summary: {
    okCount: 2, subtaskCount: 2, failedCount: 0, executedCount: 2,
    skippedCount: 0, skippedByKind: { blocked: 0, aborted: 0, budget: 0, user: 0 },
    degradedCount: 0, suspectCount: 0,
    totalCostUsd: 0, costUnknownCount: 2, creditsReportedCount: 2, totalCredits: 0.315296,
    tokenReportedCount: 0, totalInputTokens: 0, totalOutputTokens: 0,
    durationMs: 1800, finishedAt: '2026-09-29T13:00:00.000Z',
    ...extra,
  },
})

// ── 花费：命令行与报告必须说同一句话 ──────────────────────────────────────

test('★★ 单条的「只有积分」→ 印积分，绝不印 $0.0000', () => {
  const out = capture({
    type: 'subtask-finish', id: 's1', status: 'ok', durationMs: 6530,
    cost: { credits: 0.157648 }, text: '产出', memberName: 'qoder', role: '执行者',
  })
  assert.match(out, /0\.157648 积分/)
  assert.doesNotMatch(out, /\$0\.0000/, '第三轮在报告里修掉的谎，命令行里不许还留着')
})

test('★★ 单条的「什么都没上报」→ 印未知，而不是 $0.0000', () => {
  const out = capture({ type: 'subtask-finish', id: 's2', status: 'ok', durationMs: 100, cost: {}, text: '产出' })
  assert.match(out, /未知/)
  assert.doesNotMatch(out, /\$0\.0000/)
})

test('单条的「报了美元」→ 照常印美元（修完不能把正常的也改坏）', () => {
  const out = capture({ type: 'subtask-finish', id: 's3', status: 'ok', durationMs: 100, cost: { usd: 0.0161 }, text: '产出' })
  assert.match(out, /\$0\.0161/)
})

test('★★ 完成行的总花费：零个上报 → 不许印「花费 $0」（那等于宣称这次免费）', () => {
  const out = capture(finishEvt())
  assert.doesNotMatch(out, /花费 \$0\b/, '"花费 $0" 是"没拿到数据"，不是"免费"')
  assert.match(out, /未折算成美元（2 个子任务按积分计费，合计 0\.315296 积分）/)
})

test('完成行：报了美元 → 印总额，并加注有多少条看不见', () => {
  const out = capture(finishEvt({ totalCostUsd: 0.65, costUnknownCount: 1, creditsReportedCount: 1, totalCredits: 0.15 }))
  assert.match(out, /花费 \$0\.65（⚠️ 另有 1 个子任务按积分计费/)
})

// ── 收尾那两格：未执行明细 + 总耗时 ────────────────────────────────────────

test('★ 完成行必须带上「未执行」的**原因明细**，不能只给个条数', () => {
  const out = capture(finishEvt({
    okCount: 2, subtaskCount: 5, failedCount: 1, executedCount: 3,
    skippedCount: 2, skippedByKind: { blocked: 1, aborted: 1, budget: 0, user: 0 },
  }))
  assert.match(out, /2 未执行（引擎未调用成员：1 条依赖断链、1 条策略中止）/)
})

test('★★ 完成行的总耗时：没正常收尾 → 印未知，不许印 0.0s', () => {
  const out = capture(finishEvt({ finishedAt: null, durationMs: 0 }))
  assert.match(out, /总耗时 未知（运行没有正常收尾）/)
  assert.doesNotMatch(out, /总耗时 0\.0s/)
})

test('完成行的总耗时：正常收尾 → 印秒数', () => {
  assert.match(capture(finishEvt()), /总耗时 1\.8s/)
})

// ── 报告里有的警告，命令行也必须有 ────────────────────────────────────────

test('★★ 带缺口 / 产出可疑：这两条警告必须在命令行里也出现', () => {
  /*
   * 少了它们，一条"在上游缺了输入硬跑出来的结论"和一条"进程正常退出但内容不可信"的产物，
   * 在终端里都长得和干净成功一模一样 —— 报告说了、终端没说，两个消费者各说各话，
   * 而用户更可能只看终端。
   */
  const out = capture(finishEvt({ degradedCount: 1, suspectCount: 1 }))
  assert.match(out, /其中 1 个是在上游有缺口的情况下跑的/)
  assert.match(out, /其中 1 个产出可疑/)
})

test('防误报：没有缺口也没有可疑产出 → 这两条警告一个字都不许出现', () => {
  const out = capture(finishEvt())
  assert.doesNotMatch(out, /上游有缺口/)
  assert.doesNotMatch(out, /产出可疑/)
})

// ── 静默与未知类型 ───────────────────────────────────────────────────────

test('verbose=false → 完全静默（任何事件都不印）', () => {
  assert.equal(capture({ type: 'plan-start', preview: 'p' }, false), '')
  assert.equal(capture(finishEvt(), false), '')
})

test('★ 不认识的事件类型 → 一个字都不印（不认识的别瞎猜个措辞印出来）', () => {
  assert.equal(capture({ type: '某个未来才有的事件', foo: 1 }), '')
})

test('★ 单卡片重跑那几个事件在这份日志里**故意不处理** —— CLI 没有重试入口，写了就是死代码', () => {
  assert.equal(capture({ type: 'resume-start', goal: 'g', onlyId: 's1' }), '')
  assert.equal(capture({ type: 'subtask-member-changed', id: 's1', from: 'a', to: 'b' }), '')
})
