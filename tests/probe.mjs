/**
 * 成员探测脚本
 * 用途：实测本机各 agent CLI 是否存在、能否被 Node 调起、版本号多少
 * 用法：node tests/probe.mjs [memberId]
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

const CANDIDATES = [
  { id: 'claude', cmd: String.raw`C:\Users\deno\bin\claude.cmd`, args: ['--version'] },
  { id: 'cursor-agent', cmd: 'cursor-agent', args: ['--version'] },
  { id: 'qodercli', cmd: 'qodercli', args: ['--version'] },
  { id: 'trae-cli', cmd: 'trae-cli', args: ['--version'] },
  { id: 'dsh', cmd: 'dsh', args: ['--version'] },
]

function run(cmd, args, { input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => { if (!settled) { settled = true; resolve(r) } }

    let child
    try {
      child = spawn(cmd, args, { shell: true, windowsHide: true })
    } catch (e) {
      return done({ code: -1, out: '', err: String(e), spawnFailed: true })
    }

    let out = '', err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      done({ code: -2, out, err: err + '\n[timeout]' })
    }, timeoutMs)

    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    if (input !== undefined) { child.stdin.write(input); child.stdin.end() }
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err }) })
    child.on('error', (e) => { clearTimeout(timer); done({ code: -1, out, err: String(e), spawnFailed: true }) })
  })
}

const only = process.argv[2]
const rows = []

for (const c of CANDIDATES) {
  if (only && c.id !== only) continue
  const r = await run(c.cmd, c.args)
  const text = (r.out.trim() || r.err.trim() || '(no output)')
  const firstLine = text.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '(empty)'
  const ok = r.code === 0 && !r.spawnFailed
  rows.push({ id: c.id, ok, code: r.code, line: firstLine })
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${c.id.padEnd(14)} exit=${String(r.code).padEnd(4)}  ${firstLine.slice(0, 90)}`)
}

const okCount = rows.filter((r) => r.ok).length
console.log(`\n可用 ${okCount} / ${rows.length}`)
