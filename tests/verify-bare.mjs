/**
 * 验证 --bare 模式下工具是否仍然可用
 * 便宜不代表能用 —— 必须实测它还能不能读写文件、执行命令
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLAUDE = process.env.CLAUDE_CLI || String.raw`C:\Users\deno\bin\claude.cmd`
const q = (s) => (/[\s"]/.test(String(s)) ? `"${s}"` : String(s))
const WORKDIR = process.cwd()

function run(args, input) {
  return new Promise((resolve) => {
    const full = `chcp 65001 >nul & ${q(CLAUDE)} ${args.map(q).join(' ')}`
    const child = spawn(full, [], { shell: true, windowsHide: true, cwd: WORKDIR })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.stdin.write(input)
    child.stdin.end()
    const timer = setTimeout(() => { try { child.kill() } catch {} }, 240000)
    child.on('close', (c) => { clearTimeout(timer); resolve({ code: c, out, err }) })
  })
}

const target = join(WORKDIR, '.agenthub', 'bare-test.txt')
const prompt = `请完成两个动作：
1. 创建文件 .agenthub/bare-test.txt，内容写 bare-mode-works
2. 然后运行命令读取它：node -e "console.log(require('fs').readFileSync('.agenthub/bare-test.txt','utf8'))"

把命令的真实输出报告给我。如果工具不可用或命令被拦截，请明确说明「做不到」，不要编造结果。`

const args = [
  '-p', '--output-format', 'json', '--bare',
  '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  '--add-dir', WORKDIR,
]

const r = await run(args, prompt)
let p = null
try { p = JSON.parse(r.out.trim()) } catch {}

console.log('exitCode     :', r.code)
if (p) {
  console.log('input_tokens :', p.usage?.input_tokens)
  console.log('cost         : $' + (p.total_cost_usd ?? 0).toFixed(4))
  console.log('duration_ms  :', p.duration_ms ?? p.duration_api_ms)
  const stderr = (r.err || '').split('\n').filter((l) => !/reg\.exe|Program Blacklist|security policy/i.test(l)).join(' ').trim()
  if (stderr) console.log('stderr       :', stderr.slice(0, 200))
  console.log('\n--- 它的回答 ---')
  console.log(String(p.result).slice(0, 1000))
} else {
  console.log('输出解析失败：\n', (r.out || r.err).slice(0, 600))
}

console.log('\n--- 硬证据：文件是否真的被创建 ---')
console.log('存在:', existsSync(target))
if (existsSync(target)) console.log('内容:', JSON.stringify(readFileSync(target, 'utf8').trim()))
