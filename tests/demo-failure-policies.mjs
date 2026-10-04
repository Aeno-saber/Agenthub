/**
 * 演示脚本：同一份计划、同一个失败，三种失败策略各跑一遍，把报告写出来。
 *
 *   node tests/demo-failure-policies.mjs [输出目录]     默认 .agenthub/samples
 *
 * 为什么需要它：
 *   「一个子任务失败之后，剩下的活还跑不跑」这件事，光看代码和单测都不直观。
 *   这里用桩成员把 2026-09-29 真跑那次的形状复现出来（s3 挂掉、s4 是最终交付、
 *   s5 是不依赖失败结果的旁支），三种策略各出一份报告，摆在一起看差别就清楚了。
 *
 * 全程用桩成员，**不调用任何真实 agent、不花一分钱、不依赖成员是否可用**。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { Orchestrator, FAILURE_POLICIES } from '../src/engine/orchestrator.js'

/** s3 会失败，其余成功 */
const behave = { a: 'ok', b: 'failed', c: 'ok', d: 'ok' }

const registry = {
  get: (id) => ({
    name: `桩-${id}`,
    run: async () => (behave[id] === 'failed'
      ? { status: 'failed', text: '成员 b 执行失败：模拟的失败原因', cost: {}, raw: { exitCode: 1 }, changedFiles: null }
      : { status: 'ok', text: `成员 ${id} 的产出正文`, cost: {}, raw: { exitCode: 0 }, changedFiles: null }),
  }),
}

const plan = {
  goal: '复现实跑：第三步挂了，最终交付还要不要跑',
  subtasks: [
    { id: 's1', memberId: 'a', title: '盘点现状', prompt: '第一步' },
    { id: 's2', memberId: 'a', title: '写下结论', prompt: '第二步' },
    { id: 's3', memberId: 'b', title: '第三方评审', prompt: '第三步（这一步会挂）' },
    { id: 's4', memberId: 'c', title: '最终交付', prompt: '汇总前面所有产出，交出最终报告', dependsOn: ['s1', 's2', 's3'] },
    { id: 's5', memberId: 'd', title: '独立支线', prompt: '基于第一步的另一条支线', dependsOn: ['s1'] },
  ],
}

const outDir = resolve(process.argv[2] || '.agenthub/samples')
mkdirSync(outDir, { recursive: true })

const summary = []

for (const policy of FAILURE_POLICIES) {
  const orch = new Orchestrator(registry, { permission: 'plan', onFailure: policy })
  const { trace, ctx } = await orch.run(plan, { workdir: process.cwd() })
  const file = join(outDir, `policy-${policy}.md`)
  writeFileSync(file, trace.toMarkdown(), 'utf8')
  const s = trace.summary
  summary.push({
    policy,
    file,
    最终交付: ctx.results.s4.status,
    旁支: ctx.results.s5.status,
    成功: s.okCount,
    失败: s.failedCount,
    未执行: s.skippedCount,
    带缺口: s.degradedCount,
    轨迹条数: s.subtaskCount,
  })
}

console.log(`报告已写入 ${outDir}\n`)
console.table(summary)
console.log('\n重点看两列：')
console.log('  「最终交付」—— 只有 salvage 能拿到那份成品')
console.log('  「轨迹条数」—— 三种策略下都必须等于计划条数（5），一条都不许无声消失')
