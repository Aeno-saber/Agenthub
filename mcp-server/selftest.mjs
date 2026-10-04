/**
 * MCP 桥接自测
 *
 * 我扮演 MCP 客户端（也就是 WorkBuddy 那一侧的角色）：
 * 起 server 子进程 → 握手 → 列工具 → 真的调工具。
 * 全程走真实 stdio 协议，不 mock 任何一层。
 *
 * 目的：在把这套东西注册进 WorkBuddy 之前，先证明「协议层通 + 工具真能触发引擎」。
 * 若这里就过不去，注册进客户端只会得到一个语焉不详的报错。
 *
 * 唯一一处花钱：最后一个用例真调了一次 claude（readonly 档，约 $0.007）。
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath
const SERVER = join(__dirname, 'index.js')
const WORKDIR = resolve(__dirname, '..')

class Client {
  constructor(cmd, args, cwd) {
    this.nextId = 1
    this.pending = new Map()
    this.stderr = ''
    this.stdoutJunk = []
    this.child = spawn(cmd, args, { cwd, windowsHide: true })

    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (c) => {
      buf += c
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          this.stdoutJunk.push(line.slice(0, 200))
          continue
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        }
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (c) => { this.stderr += c })
  }

  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`请求超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v) },
        reject: (e) => { clearTimeout(timer); rej(e) },
      })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  close() {
    try { this.child.stdin.end() } catch {}
    try { this.child.kill() } catch {}
  }
}

const checks = []
function check(label, ok, detail = '') {
  checks.push({ label, ok })
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? '  — ' + detail : ''}`)
}

console.log(`客户端 = node ${process.version}`)
console.log(`server = ${SERVER}\n`)

const client = new Client(NODE, [SERVER], WORKDIR)

try {
  // ── 1. 握手 ──────────────────────────────────────────────
  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'agenthub-selftest', version: '1.0.0' },
  }, 20000)
  check('握手 initialize', !!init?.serverInfo,
    `${init?.serverInfo?.name} v${init?.serverInfo?.version} · 协商协议 ${init?.protocolVersion}`)
  check('声明 tools 能力', !!init?.capabilities?.tools)

  client.notify('notifications/initialized', {})

  // ── 2. 列工具 ────────────────────────────────────────────
  const list = await client.request('tools/list', {}, 20000)
  const tools = list?.tools || []
  check('tools/list 返回工具', tools.length >= 3, tools.map((t) => t.name).join(', '))
  check('每个工具带 inputSchema',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))

  // ── 3. 调工具（不花钱）：成员可用性 ──────────────────────
  const membersRes = await client.request('tools/call',
    { name: 'agenthub_list_members', arguments: {} }, 120000)
  const mt = membersRes?.content?.[0]?.text || ''
  let parsed = null
  try { parsed = JSON.parse(mt) } catch {}
  check('agenthub_list_members 可调用', !!parsed,
    parsed ? `共 ${parsed.totalCount} 个成员，实测可用 ${parsed.availableCount} 个` : mt.slice(0, 120))

  const claude = parsed?.members?.find((m) => m.id === 'claude')
  check('claude 实测可用', claude?.available === true, claude?.detail || '')

  // ── 4. 调工具（花钱 ~$0.007）：真跑到成员 ────────────────
  console.log('\n… 真调一次 claude（readonly，极短任务）\n')
  const t0 = Date.now()
  const runRes = await client.request('tools/call', {
    name: 'agenthub_run_member',
    arguments: {
      memberId: 'claude',
      prompt: '只回复六个字，不要加任何其他内容：MCP 桥接通了',
      permission: 'readonly',
    },
  }, 300000)
  const rt = runRes?.content?.[0]?.text || ''
  const okRun = /状态：ok/.test(rt)
  check('agenthub_run_member 真跑到成员', okRun, `${Date.now() - t0}ms`)
  console.log('\n--- 成员返回（原样） ---')
  console.log(rt.split('\n').map((l) => '  ' + l).join('\n'))

  // ── 5. 杂项 ──────────────────────────────────────────────
  check('stdout 未被日志污染', client.stdoutJunk.length === 0,
    client.stdoutJunk.length ? client.stdoutJunk[0] : '干净')
} catch (e) {
  check('未抛异常', false, e.message)
} finally {
  client.close()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`)

if (client.stderr.trim()) {
  console.log('\n--- server stderr（应只有启动日志） ---')
  console.log(client.stderr.trim().split('\n').map((l) => '  ' + l).join('\n'))
}

process.exit(failed.length ? 1 : 0)
