/**
 * Claude 适配器冒烟测试
 * 目的：在写正式适配器之前，先确认真实调用链路可行
 *  1) -p + 直接传 prompt（text 格式）
 *  2) -p + stdin 传 prompt（避免命令行转义问题）
 *  3) --output-format json（结构化输出能否解析）
 */
import { spawn } from 'node:child_process'

const CLAUDE = process.env.CLAUDE_CLI || String.raw`C:\Users\deno\bin\claude.cmd`

function run(args, { input, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const q = (s) => (/[\s"]/.test(s) ? `"${s}"` : s)
    const full = `chcp 65001 >nul & ${q(CLAUDE)}${args.length ? ' ' + args.map(q).join(' ') : ''}`
    const child = spawn(full, [], { shell: true, windowsHide: true })
    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ code: -2, out, err: err + '\n[timeout]' })
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    if (input !== undefined) { child.stdin.write(input); child.stdin.end() }
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

const t = async (label, args, opts) => {
  const t0 = Date.now()
  const r = await run(args, opts)
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n=== ${label} ===`)
  console.log(`exit=${r.code}  耗时=${secs}s`)
  console.log(`stdout: ${JSON.stringify(r.out.trim().slice(0, 400))}`)
  if (r.err.trim()) {
    const e = r.err.trim().split('\n').filter((l) => !/reg\.exe|Program Blacklist|security policy/i.test(l))
    if (e.length) console.log(`stderr: ${JSON.stringify(e.join(' | ').slice(0, 300))}`)
  }
  return r
}

await t('1. 直接传 prompt / text 格式', ['-p', 'Reply with just the number: 2+2=?'])
await t('2. stdin 传 prompt', ['-p'], { input: 'Reply with just the number: 3+4=?' })
await t('3. json 结构化输出', ['-p', '--output-format', 'json', 'Reply with just: ok'])
