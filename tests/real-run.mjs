#!/usr/bin/env node
/**
 * 真实任务实跑 —— 用**界面的真通道**跑一个真实协同任务，全程留证
 *
 * ## 为什么要有它
 *
 * `ui-smoke.mjs` 验的是"界面能不能用"（元素在不在、点得动、控制台干不干净），
 * 用的都是打桩和玩具指令。它**回答不了"这工具到底有没有用"** ——
 * 真实编码任务会暴露一批玩具任务看不见的问题：上游产出的截断够不够、
 * 两个 agent 同时改同一个文件会怎样、产出有效性判定准不准、成本是否可接受。
 *
 * 所以这个脚本专门干一件事：**走界面自己的那条路**（点按钮 → 拆解 → 计划确认表 → 点执行），
 * 让 `window.AgentHub.runTask` 真跑，中途不停截图，跑完把任务数据整个 dump 出来。
 *
 * ⚠️ 不另写一份 fetch。测试脚本自己拼请求，测的就是测试脚本，不是界面。
 *
 * ## 用法
 *
 * ```bash
 * node ui/server.js --workdir D:/app/AgentHub &        # 先起服务
 *
 * # 第一步：只拆解，看看主脑怎么拆（不执行，不花钱/极少钱）
 * node tests/real-run.mjs --goal "..." --phase plan
 *
 * # 第二步：确认没问题，真跑
 * node tests/real-run.mjs --goal "..." --phase run --permission execute
 *
 * # 拆得不合意时，在计划表上改（模拟真实用户编辑，不是走后门）
 * node tests/real-run.mjs --goal "..." --phase run \
 *   --patch '{"s2":{"memberId":"qoder","prompt":"换个说法…"}}'
 * ```
 *
 * 参数：--goal（必需）· --phase plan|run · --planner <成员id> · --permission readonly|plan|execute|full
 *      --patch <JSON> · --shots <dir> · --out <json 文件> · --timeout <秒>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { launchBrowser, closeBrowser, newPage, sleep } from './lib/browser.mjs'

// ── 参数 ──
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    const v = argv[i + 1]
    if (v && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

const UI_URL = process.env.UI_URL || 'http://127.0.0.1:8787'
const CDP_PORT = Number(process.env.CDP_PORT || 0)   // 0 = 自动挑端口，跟别的测试同时跑也不会撞

const GOAL = args.goal
const PHASE = args.phase || 'plan'
const SHOT_DIR = args.shots || '.agenthub/real-run'
const TIMEOUT_S = Number(args.timeout || 1800)
const PATCH = args.patch ? JSON.parse(args.patch) : null
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const OUT = args.out || `.agenthub/real-run/task-${ts}.json`

if (!GOAL) {
  console.error('缺少 --goal。用法见文件头注释。')
  process.exit(2)
}

const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`)
const hr = (t) => console.log('\n' + '─'.repeat(4) + ' ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)))

let browser = null
let page = null

async function main() {
  try {
    const r = await fetch(UI_URL)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`界面服务没起来（${UI_URL}）：${e.message}`)
    console.error('先跑：node ui/server.js --workdir D:/app/AgentHub')
    process.exit(2)
  }

  browser = await launchBrowser({ port: CDP_PORT })
  page = await newPage(browser.port, UI_URL)
  const cdp = page.cdp

  hr('0. 等成员探活完成')
  const ready = await page.waitFor(`return (window.AgentHub?.state?.members?.length || 0) > 0`, {
    tries: 200, interval: 250, label: '成员列表',
  })
  if (!ready) throw new Error('成员列表一直没载入')
  const members = await page.eval(`return window.AgentHub.state.members.map(m => ({ id: m.id, ok: !!m.available }))`)
  console.log('  实测可用：' + members.map((m) => `${m.id}${m.ok ? '✅' : '❌'}`).join(' '))

  hr('1. 在界面上创建协同任务')
  await page.eval(`
    document.getElementById('newTaskBtn').click()
    await new Promise(r => setTimeout(r, 250))
    document.getElementById('goalBox').value = ${JSON.stringify(GOAL)}
    return 1
  `)
  if (args.planner) {
    await page.eval(`
      const sel = document.getElementById('plannerSel')
      sel.value = ${JSON.stringify(args.planner)}
      return sel.value
    `)
  }
  const planner = await page.eval(`return document.getElementById('plannerSel').value`)
  console.log(`  目标：${GOAL}`)
  console.log(`  拆解者：${planner}`)

  hr('2. 点「拆解」，等主脑返回')
  const t0 = Date.now()
  await page.eval(`document.getElementById('planBtn').click(); return 1`)
  const gotPlan = await page.waitFor(
    `return !!document.querySelector('#planRows .plan-row') || document.querySelector('.modal h3')?.textContent.includes('没拆出')`,
    { tries: 400, interval: 500, label: '拆解结果' }
  )
  if (!gotPlan) throw new Error('拆解一直没有结果')
  const planMs = Date.now() - t0

  const failed = await page.eval(`return document.querySelector('.modal h3')?.textContent.includes('没拆出') === true`)
  if (failed) {
    const raw = await page.eval(`return document.querySelector('.modal pre')?.textContent || ''`)
    await page.shot(SHOT_DIR, '0-拆解失败')
    console.log(`\n  ✖ 主脑没拆出可用计划（${fmtMs(planMs)}）。它的原始输出：\n`)
    console.log(raw.split('\n').map((l) => '    ' + l).join('\n'))
    return { phase: PHASE, planFailed: true, raw, planMs }
  }

  // 从计划表 DOM 提取（collectPlanFromDom 是模块私有的，这里按界面渲染出来的结构抓）
  let plan = await page.eval(`
    return [...document.querySelectorAll('#planRows .plan-row')].map(r => ({
      id: r.dataset.sid,
      memberId: r.querySelector('.plan-member')?.value,
      role: r.querySelector('.plan-role')?.value,
      prompt: r.querySelector('.plan-prompt')?.value || '',
    }))
  `)
  console.log(`\n  主脑拆出 ${plan.length} 个子任务（${fmtMs(planMs)}）：`)

  // 依赖关系在 DOM 上只有一句"依赖 s1、s2"的文字，拿不准；从界面自己的 planDraft 读原始值
  const diag = await page.eval(`return window.AgentHub?.planDiag || null`)
  const draft = await page.eval(`return window.AgentHub?.planDraft || null`)
  const depOf = (id) => draft?.subtasks?.find((s) => s.id === id)?.dependsOn || []
  for (const [i, s] of plan.entries()) {
    console.log(`    ${i + 1}. [${s.id}] ${s.memberId} / ${s.role} / 依赖 ${JSON.stringify(depOf(s.id))} / 指令 ${s.prompt.length} 字符`)
    console.log(`       ${s.prompt.replace(/\s+/g, ' ').slice(0, 90)}${s.prompt.length > 90 ? '…' : ''}`)
  }
  if (diag) {
    // 这几行是本轮踩坑后加的：拆解成功并不等于一切正常 ——
    // 有可能是"输出被截断、只抢救回前面几个子任务"。必须显式说出来。
    const flags = [
      `原始输出 ${diag.rawLength} 字符`,
      diag.repaired ? `⚠️ 输出被截断，已抢救（${diag.repairReason}）` : '✅ 输出完整，硬解析',
      `规划者状态 ${diag.plannerStatus || 'n/a'}`,
      `可用成员 ${(diag.roster || []).join('/') || 'n/a'}`,
    ]
    console.log(`  ${flags.join(' · ')}`)
  } else {
    console.log('  ⚠️ 界面没暴露拆解诊断（window.AgentHub.planDiag 为空）')
  }

  if (PATCH) {
    hr('2b. 在计划表上做人工修改（模拟真实用户编辑）')
    for (const [sid, p] of Object.entries(PATCH)) {
      const applied = await page.eval(`
        const row = [...document.querySelectorAll('#planRows .plan-row')].find(r => r.dataset.sid === ${JSON.stringify(sid)})
        if (!row) return null
        const patch = ${JSON.stringify(p)}
        if (patch.memberId) row.querySelector('.plan-member').value = patch.memberId
        if (patch.role) {
          const sel = row.querySelector('.plan-role')
          if (![...sel.options].some(o => o.value === patch.role)) sel.add(new Option(patch.role, patch.role))
          sel.value = patch.role
        }
        if (patch.prompt) row.querySelector('.plan-prompt').value = patch.prompt
        return { id: row.dataset.sid, memberId: row.querySelector('.plan-member').value, role: row.querySelector('.plan-role').value }
      `)
      console.log(applied ? `  已改 [${sid}] → ${applied.memberId} / ${applied.role}` : `  ⚠️ 计划表里没有 [${sid}]，跳过`)
    }
  }

  await page.shot(SHOT_DIR, '1-计划确认表')

  if (PHASE === 'plan') {
    hr('收工（phase=plan：只拆解，不执行）')
    return { phase: 'plan', goal: GOAL, planner, planMs, plan, planDiag: diag, planDraft: draft }
  }

  hr('3. 点「确认执行」，全程盯界面')
  if (args.permission) {
    await page.eval(`document.getElementById('taskPerm').value = ${JSON.stringify(args.permission)}; return 1`)
  }
  const perm = await page.eval(`return document.getElementById('taskPerm').value`)
  console.log(`  权限档：${perm}`)
  await page.eval(`document.querySelector('[data-act="confirm-task"]').click(); return 1`)

  const deadline = Date.now() + TIMEOUT_S * 1000
  const seen = new Set()
  let shotAt = [3, 15, 40, 90]   // 秒；在这些时间点各截一张
  let shotIdx = 0
  const runStart = Date.now()

  while (Date.now() < deadline) {
    const st = await page.eval(`
      const t = window.AgentHub.state.tasks[0]
      if (!t) return null
      return {
        status: t.status,
        cards: Object.values(t.cards).map(c => ({ id: c.id, status: c.status, ms: c.durationMs })),
        logs: t.logs.map(l => l.t + '  ' + l.text),
      }
    `).catch(() => null)

    if (!st) { await sleep(500); continue }

    // 把新出现的日志行打到控制台，这样长任务跑的时候不是一片空白
    for (const line of st.logs) {
      const key = line.slice(0, 60)
      if (seen.has(key)) continue
      seen.add(key)
      console.log('    ' + line)
    }

    const elapsed = (Date.now() - runStart) / 1000
    if (shotIdx < shotAt.length && elapsed >= shotAt[shotIdx]) {
      await page.shot(SHOT_DIR, `2-执行中-${String(shotAt[shotIdx])}s`)
      shotIdx++
    }

    if (st.status !== 'running') {
      console.log(`\n  任务结束：${st.status}`)
      break
    }
    await sleep(1000)
  }

  await sleep(1200)
  const data = await page.eval(`
    const t = window.AgentHub.state.tasks[0]
    return {
      goal: t.goal, status: t.status, permission: t.permission,
      summary: t.summary,
      cards: Object.values(t.cards).map(c => ({
        id: c.id, title: c.title, memberId: c.memberId, role: c.role,
        status: c.status, durationMs: c.durationMs, cost: c.cost || {},
        quality: c.quality || null, prompt: c.prompt, text: c.text,
      })),
      logs: t.logs, markdown: t.markdown,
    }
  `)
  await page.shot(SHOT_DIR, '3-执行完毕')

  hr('4. 结果')
  if (data.summary) {
    const s = data.summary
    // 成本要带上"有谁没上报"——否则那个 $ 数看起来是确定的（qoder 按积分计费正是这种情况）
    const costLine = `$${s.totalCostUsd}` +
      (s.costUnknownCount
        ? `（另有 ${s.costUnknownCount} 个未上报美元成本${s.creditsReportedCount ? ` · ${s.totalCredits} 积分` : ''}）`
        : '')
    console.log(`  ${s.okCount}/${s.subtaskCount} 成功 · ${s.failedCount} 失败 · 产出可疑 ${s.suspectCount} · ${fmtMs(s.durationMs)} · ${costLine}`)
  }
  for (const c of data.cards) {
    const bad = c.quality?.level === 'suspect' ? '  ⚠️ 产出可疑' : ''
    console.log(`  [${c.id}] ${c.memberId}/${c.role} ${c.status} · ${fmtMs(c.durationMs)}${bad}`)
    if (c.quality?.note) console.log(`       ${c.quality.note}`)
  }

  if (page.exceptions.length || page.errors.length) {
    hr('控制台')
    for (const e of [...page.exceptions, ...page.errors].slice(0, 5)) console.log('  ' + String(e).slice(0, 200))
  }

  /*
   * ★ 无论成败都要把「计划本身」和「拆解诊断」一起落盘。
   *
   * 第二轮实跑就吃了亏：那次拆解抢救成功、但救出的计划有残缺，
   * 执行时被服务端拒掉。而 return 里只带了 `data`（任务卡片），
   * plan / diag 全丢了 —— 想复盘"到底抢救成了什么样"时手里没有证据。
   * 教训同一条：**只要结果需要解释，证据就不能省。**
   */
  return {
    phase: 'run', goal: GOAL, planner, planMs, permission: perm,
    plan, planDiag: diag, planDraft: draft,
    ...data,
  }
}

try {
  const result = await main()
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8')
  console.log(`\n  证据已存：${OUT}`)
  console.log(`  截图目录：${SHOT_DIR}`)
} catch (e) {
  console.error('\n实跑挂了：' + e.message)
  if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'))
  process.exitCode = 1
} finally {
  try { page?.close() } catch {}
  await closeBrowser(browser)
}
