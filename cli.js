#!/usr/bin/env node
/**
 * AgentHub 命令行入口（第一期）
 *
 *   node cli.js probe                          探测成员可用性
 *   node cli.js plan  --goal "..." [--out f]   让成员拆解目标，产出计划
 *   node cli.js dry   --plan plan.json         干跑：只校验与排版
 *   node cli.js run   --plan plan.json         执行计划，产出轨迹报告
 *   node cli.js auto  --goal "..."             拆解 + 执行一条龙
 *
 * 常用参数：
 *   --permission readonly|plan|execute|full    全局权限档位（默认 plan）
 *   --workdir <dir>                            工作目录
 *   --budget <usd>                             整个任务的花费上限
 *   --on-failure <策略>                        一步失败后剩下的活怎么办（默认 skip-blocked）
 *       abort        任一步失败就停掉后面所有步骤（最省钱，但已花的可能白花）
 *       skip-blocked 只跳过依赖断了的那些，不依赖失败结果的分支照跑完（默认）
 *       salvage      谁都不跳；最终交付照样跑，但会把"缺了谁"写进它的指令和报告
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

import { loadRegistry } from './src/adapters/index.js'
import { Orchestrator } from './src/engine/orchestrator.js'
import { planWithMember } from './src/engine/planner.js'
import { costOf } from './src/engine/trace.js'
/*
 * 进度日志从独立模块引，**不在这里自己写一份** ——
 * 这里原来手写的 `$${(usd || 0).toFixed(4)}` 会把"按积分计费、不上报美元"的成员印成 `$0.0000`，
 * 而报告层早就改成了"未知"。（详见 src/report/logger.js 的说明。）
 */
import { makeLogger } from './src/report/logger.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ }
      else out[key] = true
    } else out._.push(a)
  }
  return out
}


async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const registry = loadRegistry()

  switch (cmd) {
    case 'probe': {
      const probed = await registry.probeAll({ force: true })
      for (const a of registry.list()) {
        const r = probed[a.id]
        console.log(`${r.available ? '可用  ' : '不可用'}  ${a.name.padEnd(8)}  ${(r.version || r.reason || '').slice(0, 70)}`)
      }
      break
    }

    case 'plan': {
      if (!args.goal) throw new Error('缺少 --goal')
      console.log(`让 ${args.member || 'claude'} 拆解目标…\n`)
      const { plan, raw, cost } = await planWithMember(registry, args.goal, { memberId: args.member || 'claude' })
      if (!plan) {
        console.error('拆解失败：没能从输出里解析出 JSON。原始输出：\n')
        console.error(raw.slice(0, 1500))
        process.exit(2)
      }
      const out = args.out || 'plan.json'
      const { writeFileSync } = await import('node:fs')
      writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8')
      // 拆解这一步本身也可能按积分计费（--member qoder），所以用共用的成本格，别印 $0.0000
      console.log(`计划已写入 ${out}（花费 ${costOf(cost)}）`)
      console.log(JSON.stringify(plan, null, 2))
      break
    }

    case 'dry':
    case 'run': {
      if (!args.plan) throw new Error('缺少 --plan')
      const plan = JSON.parse(readFileSync(args.plan, 'utf8'))
      const orch = new Orchestrator(registry, {
        permission: args.permission || 'plan',
        totalBudgetUsd: args.budget ? Number(args.budget) : null,
        // 一步挂了之后，剩下的活怎么办。不传就用默认的 skip-blocked
        onFailure: args['on-failure'] || undefined,
      })
      const workdir = resolve(args.workdir || process.cwd())

      const pre = orch.dryRun(plan)
      if (!pre.ok) {
        console.error('计划校验失败：\n' + pre.errors.map((e) => '  - ' + e).join('\n'))
        process.exit(2)
      }
      if (cmd === 'dry') {
        console.log(pre.preview)
        console.log(`\n批次划分：${JSON.stringify(pre.batches)}`)
        break
      }

      const { trace } = await orch.run(plan, { onEvent: makeLogger(true), workdir })
      const dir = join(workdir, '.agenthub', 'runs')
      const { jsonPath, mdPath } = trace.save(dir, `run-${Date.now()}`)
      console.log(`\n轨迹报告：\n  ${mdPath}\n  ${jsonPath}`)
      break
    }

    case 'auto': {
      if (!args.goal) throw new Error('缺少 --goal')
      console.log('① 让主脑拆解…')
      const { plan, cost } = await planWithMember(registry, args.goal, { memberId: args.member || 'claude' })
      if (!plan) { console.error('拆解失败'); process.exit(2) }
      console.log(JSON.stringify(plan, null, 2))

      console.log('\n② 执行计划…')
      const orch = new Orchestrator(registry, {
        permission: args.permission || 'plan',
        totalBudgetUsd: args.budget ? Number(args.budget) : null,
        // 一步挂了之后，剩下的活怎么办。不传就用默认的 skip-blocked
        onFailure: args['on-failure'] || undefined,
      })
      const workdir = resolve(args.workdir || process.cwd())
      const { trace } = await orch.run(plan, { onEvent: makeLogger(true), workdir })
      const { mdPath } = trace.save(join(workdir, '.agenthub', 'runs'), `run-${Date.now()}`)
      console.log(`\n轨迹报告：${mdPath}`)
      break
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace('/**', '').trim())
  }
}

main().catch((e) => {
  console.error('\n出错了：', e.message)
  process.exit(1)
})
