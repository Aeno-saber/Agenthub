/**
 * 单个成员的三层冒烟 —— L1 探活 / L2 干活 / L3 产出有效
 *
 * 用法：
 *   node tests/smoke-member.mjs doubao
 *   node tests/smoke-member.mjs trae
 *
 * 为什么要有它：`probeAll` 只跑 `--version`，通过 ≠ 能干活；能干活也 ≠ 产出有用。
 * 这三层是分开的，必须逐层实测（见 skill `windows-agent-cli-headless`）。
 *
 * 凭据一律从环境变量取，脚本不读也不打印任何密钥值。
 */
import process from 'node:process'

import { loadRegistry } from '../src/adapters/index.js'
import { judgeOutput, describeQuality } from '../src/engine/quality.js'

const id = process.argv[2]
if (!id) {
  const reg = loadRegistry()
  console.error('用法：node tests/smoke-member.mjs <成员id>')
  console.error('可选：' + reg.list().map((a) => a.id).join(' / '))
  process.exit(2)
}

const reg = loadRegistry()
const adapter = reg.get(id)
if (!adapter) {
  console.error(`没有成员 "${id}"。可选：${reg.list().map((a) => a.id).join(' / ')}`)
  process.exit(2)
}

/** 只打印 key 的存在性与形状，绝不打印值 */
function keyShape() {
  const names = ['DOUBAO_API_KEY', 'ARK_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
  const found = names.filter((n) => process.env[n])
  if (!found.length) return '未设置（见 members.json 里该成员的 authHint）'
  const k = process.env[found[0]]
  return `${found.join(' / ')} 已设置（${k.length} 字符，${k.slice(0, 3)}…）`
}

// ── 常见误用提示：别把「key 的名字」当 key ──
// 火山方舟的 API Key 是 UUID 形式（xxxxxxxx-yyyy-xxxx-yyyy-xxxxxxxxxxxx）。
// 控制台列表里排在左边的那串（如 api-key-20260929164906）是**名字**，
// 拿它去调用会得到 401 "The API key format is incorrect"。
if (id === 'doubao') {
  const k = process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY || ''
  // 方舟 key 可能是 `ark-<uuid>` 或 `<uuid>` 或 `ek-<uuid>` 几种形态，
  // 所以这里只判断"UUID 段存在"，前缀一概放行。
  if (k && !/^(?:[a-z]+-)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}/.test(k)) {
    console.log('⚠️  当前 ARK_API_KEY 看起来不像方舟密钥的形状')
    console.log('    方舟 API Key 一般是 UUID 形式；若这串是你在控制台起的名字，')
    console.log('    服务端会回 401 The API key format is incorrect。')
    console.log('    正确做法：控制台 → API Key 管理 → 点该行右侧的「查看」图标复制完整值。')
    console.log('')
  }
}

const line = (s) => console.log(s)
line(`成员：${adapter.name}（${id}）`)
line(`凭据：${keyShape()}`)
line('')

// ── L1 探活 ──
line('[L1] 探活 adapter.probe() …')
const probe = await adapter.probe()
line(`     available = ${probe.available}`)
if (probe.version) line(`     version   = ${probe.version}`)
if (probe.reason) line(`     reason    = ${probe.reason}`)

if (!probe.available) {
  line('')
  line('L1 未通过，后面两层不必跑（先解决上面的原因）。')
  process.exit(1)
}

// ── L2 干活 ──
const TASK = '只回复这四个字，不要做任何其他动作：冒烟通过'
line('')
line(`[L2] 派一个极短任务：${TASK}`)
const t0 = Date.now()
const r = await adapter.run({ prompt: TASK, permission: adapter.spec.defaultPermission })
const ms = Date.now() - t0

line(`     status = ${r.status}`)
line(`     耗时   = ${ms}ms`)
if (r.raw?.exitCode != null) line(`     退出码 = ${r.raw.exitCode}`)
line(`     产出   = ${JSON.stringify(String(r.text || '').slice(0, 200))}`)
if (r.cost && Object.keys(r.cost).length) line(`     用量   = ${JSON.stringify(r.cost)}`)
if (r.raw?.stderr) line(`     stderr = ${String(r.raw.stderr).split('\n')[0].slice(0, 200)}`)

if (r.status !== 'ok') {
  line('')
  line('L2 未通过。')
  process.exit(1)
}

// ── L3 产出有效 ──
line('')
line('[L3] 产出有效性判定（quality.js）')
const q = judgeOutput(r.text, { status: r.status })
line(`     level = ${q.level}`)
if (q.level === 'suspect') {
  line(`     ⚠️ ${describeQuality(q)}`)
  line('')
  line('L3 未通过：进程退出正常，但产出不像有效结果。')
  process.exit(1)
}

line('')
line('✅ 三层全部通过。')
