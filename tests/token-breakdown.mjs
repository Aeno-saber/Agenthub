/**
 * Token 开销拆解实验
 * 目的：搞清楚每次调用那 ~19.6k input tokens 到底花在哪
 * 做法：同一句 prompt，切换 claude 的"最小化"开关，对比 input_tokens
 */
import { spawn } from 'node:child_process'

const CLAUDE = process.env.CLAUDE_CLI || String.raw`C:\Users\deno\bin\claude.cmd`
const q = (s) => (/[\s"]/.test(String(s)) ? `"${s}"` : String(s))

function run(args, input) {
  return new Promise((resolve) => {
    const full = `chcp 65001 >nul & ${q(CLAUDE)} ${args.map(q).join(' ')}`
    const child = spawn(full, [], { shell: true, windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.stdin.write(input)
    child.stdin.end()
    const timer = setTimeout(() => { try { child.kill() } catch {} }, 120000)
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

const PROMPT = 'Reply with exactly: OK'

const variants = [
  { label: '① 默认（完整配置）', args: ['-p', '--output-format', 'json'] },
  { label: '② --safe-mode（跳过全部自定义）', args: ['-p', '--output-format', 'json', '--safe-mode'] },
  { label: '③ --exclude-dynamic（精简环境段）', args: ['-p', '--output-format', 'json', '--exclude-dynamic-system-prompt-sections'] },
  { label: '④ --bare（极简模式）', args: ['-p', '--output-format', 'json', '--bare'] },
]

console.log('同一句 prompt = "Reply with exactly: OK"\n')
console.log('变体'.padEnd(42) + 'input'.padStart(8) + 'output'.padStart(8) + 'cache'.padStart(8) + '花费'.padStart(10))
console.log('-'.repeat(78))

for (const v of variants) {
  const r = await run(v.args, PROMPT)
  let payload = null
  const raw = (r.out || '').trim()
  try { payload = JSON.parse(raw) } catch {}

  if (!payload) {
    const hint = (r.err || raw).split('\n').map((s) => s.trim()).filter(Boolean)[0] || '(无输出)'
    console.log(v.label.padEnd(42) + '  解析失败：' + hint.slice(0, 40))
    continue
  }

  const u = payload.usage || {}
  console.log(
    v.label.padEnd(42) +
    String(u.input_tokens ?? '?').padStart(8) +
    String(u.output_tokens ?? '?').padStart(8) +
    String(u.cache_read_input_tokens ?? 0).padStart(8) +
    ('$' + (payload.total_cost_usd ?? 0).toFixed(4)).padStart(10)
  )
}
