/**
 * 适配器层冒烟测试
 *   node tests/smoke-adapter.mjs            只探测（不花钱）
 *   node tests/smoke-adapter.mjs --live     额外真跑一次 claude
 *   node tests/smoke-adapter.mjs --only=claude
 */
import { loadRegistry } from '../src/adapters/index.js'

const live = process.argv.includes('--live')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const only = onlyArg ? onlyArg.split('=')[1] : null

const reg = loadRegistry()
console.log(`主脑：${reg.orchestrator?.name ?? '(未配置)'}    配置成员：${reg.list().length} 个\n`)

const probed = await reg.probeAll({ force: true })

let okCount = 0
for (const a of reg.list()) {
  if (only && a.id !== only) continue
  const r = probed[a.id]
  if (r.available) okCount++
  const label = r.available ? '可用  ' : '不可用'
  const detail = (r.version || r.reason || '').slice(0, 70)
  console.log(`${label}  ${a.name.padEnd(8)}  ${detail}`)
}
console.log(`\n实测可用 ${okCount} / ${reg.list().length}`)

if (live) {
  const target = reg.get(only || 'claude')
  const p = probed[target.id]
  if (!p.available) {
    console.log(`\n${target.name} 不可用，跳过真跑：${p.reason}`)
    process.exit(1)
  }
  console.log(`\n=== 真跑一次 ${target.name}（会消耗少量额度）===`)
  const r = await target.run({
    prompt: 'Reply with exactly: AGENTHUB_OK',
    workdir: process.cwd(),
    permission: 'plan',
    role: '调研',
  })
  console.log('status     :', r.status)
  console.log('text       :', JSON.stringify(r.text.slice(0, 200)))
  console.log('cost       :', JSON.stringify(r.cost))
  console.log('exitCode   :', r.raw.exitCode, ' 耗时:', r.raw.durationMs + 'ms')
  if (r.raw.stderr) console.log('stderr     :', JSON.stringify(r.raw.stderr.slice(0, 200)))
}
