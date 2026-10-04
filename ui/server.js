#!/usr/bin/env node
/**
 * AgentHub 本地界面服务
 *
 * ## 为什么是「零依赖 + 浏览器」而不是直接上 Electron
 *
 * 第二期的目标是 Electron 桌面应用（见 docs/02-界面设计.md）。但本机装了火绒实时防护，
 * `pnpm install` 会被拖到 20~40 分钟，还容易在"删旧目录再换新目录"那步被拦成
 * `拒绝访问 (os error 5)`。所以这里先用 **Node 内置模块**把界面和引擎接通：
 * 零依赖、秒起、随时能跑。
 *
 * 之后要包 Electron，只是加一层窗口壳去加载同一个页面，**界面代码零改动**。
 *
 * ## 它做什么
 *
 * 一个只监听 127.0.0.1 的 http 服务：
 *   - 静态文件（ui/public/）
 *   - API：成员探活 / 单成员对话 / 主脑拆解 / 协同执行 / 文件树与文件读取
 *   - SSE：把 Orchestrator 的 onEvent 事件流实时推给界面
 *
 * ## 安全约束
 *
 *   - **只绑 127.0.0.1**，不对外暴露
 *   - 静态文件只从 public/ 读，且做路径白名单校验
 *   - 文件读写一律限制在 workdir 内，防 `../` 穿越
 *
 * 用法：node ui/server.js [--port 8787] [--workdir D:/some/dir]
 */
import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises'
import { join, extname, resolve, relative, isAbsolute, sep, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { loadRegistry } from '../src/adapters/index.js'
import { describePermission, isWriteCapable, PERMISSION_LEVELS } from '../src/adapters/base.js'
import { Orchestrator } from '../src/engine/orchestrator.js'
import { planWithMember } from '../src/engine/planner.js'
import { ROLES } from '../src/roles.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC_DIR = join(__dirname, 'public')
const PROJECT_ROOT = join(__dirname, '..')

/**
 * 零依赖读 .env —— **这个服务是长驻进程，读不到你在某个终端里 `export` 的密钥**。
 *
 * 实测踩过：在 shell 里 `DOUBAO_API_KEY=... node ui/server.js` 能通，
 * 但换个终端、或让界面服务常驻之后再探活，就会报「未设置 ARK_API_KEY」，
 * 让人误以为是成员配错了。所以给一个落在磁盘上的配置点。
 *
 * 规则很简单（不实现引号转义之类的花活，够用就行）：
 *   - 只认 `KEY=VALUE` 一行一条，# 开头是注释
 *   - **不覆盖**已经存在的进程环境变量（显式 export 的优先）
 *   - 文件不存在就静默跳过
 */
function loadDotEnv(file = join(PROJECT_ROOT, '.env')) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return 0 }
  let n = 0
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const eq = s.indexOf('=')
    if (eq <= 0) continue
    const k = s.slice(0, eq).trim()
    let v = s.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (process.env[k] === undefined && v !== '') { process.env[k] = v; n++ }
  }
  return n
}

const dotenvCount = loadDotEnv()

// ── 参数 ──
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2)
      const v = argv[i + 1]
      if (v && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || process.env.AGENTHUB_PORT || 8787)
let WORKDIR = resolve(args.workdir || process.cwd())

/**
 * 成员配置的路径。
 *
 * 默认就是仓库里那份 `src/config/members.json`；`AGENTHUB_MEMBERS` 可以指到别处 ——
 * **那是给测试用的**：像 SSE 通道这种要走完服务端全流程的东西，
 * 只有把成员换成"假的、慢的、不花钱的"才能安全地验
 * （见 tests/sse-heartbeat.test.mjs）。不设这个变量时行为与以前完全一致。
 */
const CONFIG_PATH = process.env.AGENTHUB_MEMBERS
  ? resolve(process.env.AGENTHUB_MEMBERS)
  : join(__dirname, '..', 'src', 'config', 'members.json')

/** 用 let 而不是 const：加/改成员后需要热重载配置，不重启服务 */
let registry = loadRegistry(CONFIG_PATH)
const CONFIG_BAK_DIR = join(dirname(CONFIG_PATH), 'backup')

// ── 小工具 ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolvePromise({})
      try { resolvePromise(JSON.parse(raw)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * 把用户传进来的路径解析成 workdir 内的绝对路径。
 * 越界（`../` 跑到外面）直接抛错 —— 这是本地服务的必需品，不是可选项。
 */
function safeResolveInWorkdir(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(WORKDIR, p)
  const rel = relative(WORKDIR, abs)
  if (rel.startsWith('..') || (rel !== '' && rel.startsWith(`..${sep}`))) {
    throw new Error(`路径越界：${p} 不在工作目录内`)
  }
  return abs
}

// ── 静态文件 ──
async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const abs = join(PUBLIC_DIR, rel)
  // 白名单：必须真在 public/ 里面
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return }
  try {
    const buf = await readFile(abs)
    res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + urlPath)
  }
}

// ── API ──

/**
 * 成员列表的数据本身（含实测可用性）。
 *
 * 抽出来是因为它现在有**两个**出口：`GET /api/members`，以及 `POST /api/env`
 * 写完备钥之后要回一份刷新过的（否则界面只能自己再发一次请求，两头还可能不一致）。
 */
async function membersPayload(force) {
  const probed = await registry.probeAll({ force })
  const list = registry.list().map((a) => {
    const r = probed[a.id] || {}
    return {
      id: a.id,
      name: a.name,
      // 适配器能自己解析可执行文件时以它为准（codex 的路径带版本哈希，配置里那份会过期）
      command: a.command || a.spec.command || a.spec.baseUrl || '(REST)',
      enabled: a.isEnabled,
      available: !!r.available,
      version: r.version || '',
      reason: r.reason || '',
      capabilities: a.capabilities,
      // 计费口径要透出去 —— 界面上曾经显示过 `free` 标签，而实测 qoder 是按积分扣费的
      billing: a.spec.billing || 'unknown',
      defaultPermission: a.spec.defaultPermission || 'plan',
      /*
       * ★ 权限档位到底有没有真的传下去 —— 界面不该替成员许下它做不到的承诺。
       *
       * `permissionSupport[档位] === false` 的意思是：**这一档没有专属参数**。
       * 两种情况都会导致 false：参数其实来自默认档（请求 A 档、实跑 B 档），
       * 或者干脆什么都没传（配置成 `[]`，如 trae 的只读档）。
       * 实测：trae 的 readonly 与 plan 传下去的东西一模一样 —— 界面上却写着
       * 「只读 —— 能读，不改文件、不跑命令」。一个不说这件事的界面等于在帮着说谎。
       *
       * `writeCapable` 是成员**有没有文件系统能力**（豆包是 REST 成员，没有）。
       * 它不读写本地文件时，档位对它本来就没有区别，该说清的是这件事，
       * 而不是"这个档位没生效" —— 两者对用户的意义完全不同。
       */
      writeCapable: isWriteCapable(a.spec),
      permissionSupport: Object.fromEntries(
        PERMISSION_LEVELS.map((lv) => [lv, describePermission(a.spec, lv).expressible])
      ),
      authHint: a.spec.authHint || '',
      notes: a.spec.notes || '',
    }
  })
  return {
    workdir: WORKDIR,
    projectName: basename(WORKDIR) || WORKDIR,
    configPath: CONFIG_PATH,
    orchestrator: registry.orchestrator,
    members: list,
    /*
     * 角色目录一起下发。
     *
     * 前端原来自己硬编码了一份 `ROLES`，和 `base.js` 的 `rolePrompt()`、
     * `planner.js` 的提示词各说各话（三份里有两份没有「执行者」，
     * 而它恰好是下拉框的默认值）。现在只有 `src/roles.js` 一份，界面从这儿取。
     *
     * **不带 `prompt` 字段**：那是服务端展开给模型看的系统提示词，
     * 浏览器不需要它，多传一份就多一份会和目录脱节的可能。
     */
    roles: ROLES.map(({ prompt, ...pub }) => pub),
    /*
     * 允许填写的变量名**由服务端下发**（就是 apiEnvSet 的白名单）。
     * 前端自己抄一份必然会漂移：界面上能选、服务端却拒收，是那种"点了没反应"
     * 又最难查的错。目录和密钥这两件事都只留服务端一份真相源。
     */
    envKeys: ENV_WHITELIST,
  }
}

/** 成员列表（含实测可用性）。force=1 强制重探。 */
async function apiMembers(req, res, url) {
  sendJson(res, 200, await membersPayload(url.searchParams.get('force') === '1'))
}

// ── 成员配置写入（加人 / 改默认档 / 启停）──
//
// 这是本项目里唯一会改用户配置的通道，所以规矩写死：
//   1. 每次写之前先留一份备份（覆盖式 src/config/backup/members.json.bak）
//   2. 写完整份 JSON（而不是字符串拼接），杜绝格式损坏
//   3. 写完立刻热重载 registry 并真探活；探活不过就**回滚**，
//      因为设计文档 §8 要求「能启动且 --version 有返回，才算添加成功」

function readConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

async function writeConfig(cfg) {
  await mkdir(CONFIG_BAK_DIR, { recursive: true })
  await copyFile(CONFIG_PATH, join(CONFIG_BAK_DIR, 'members.json.bak'))
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
}

const VALID_PERMS = ['readonly', 'plan', 'execute', 'full']

// ── 密钥写入（界面里填 Key）──
//
// 这是本服务里**唯一会写密钥**的通道，规矩比改配置更严：
//   1. 白名单限死 —— 只认下面这 7 个。这里不是通用"写环境变量"接口，
//      开放任意 key 就等于给了一条往 .env 里塞任意内容的通道。
//   2. 值不许带换行 —— 带了就能在 .env 里凭空多出一行（`X=1\nPATH=/evil`），
//      那不只是格式坏掉，是能塞进别的变量。
//   3. 原子写：临时文件 + rename，**不留 .env.bak** —— 备份里是明文密钥，
//      多留一份就多一份泄漏面；而 rename 不会写出半个文件，原子性已经够。
//   4. **永不回显、永不写日志**：返回体里只有 key 名和探测结果，没有值。
//      服务只监听 127.0.0.1，密钥只落本地 .env（这一点在 docs/02 里写明）。
const ENV_WHITELIST = [
  'DOUBAO_API_KEY',
  'ARK_API_KEY',
  'CURSOR_API_KEY',
  'QODER_PERSONAL_ACCESS_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ARK_MODEL',
]

/**
 * 把一个 KEY=VALUE 落进项目根的 .env，然后把探活结果回给界面。
 *
 * 为什么在这里做而不是让用户自己去改文件：Trae 和豆包**装了但没有 key**，
 * 界面上的表现是一张"暂不可用"的虚线卡 —— 用户点开它，看到的是
 * "请在项目根目录新建 .env"，然后得去开编辑器、找到目录、写对变量名、再回来点重探。
 * 这条路上每一步都能把人劝退，而引擎侧其实只需要一个字符串。
 *
 * ★ 一个 Key 同时激活 Trae 和豆包：两个成员都读 `DOUBAO_API_KEY`
 *   （trae-agent 按 provider 名推导变量名，它的 provider 就是 doubao）。
 *   界面上必须把这件事说出来，否则用户会以为要填两遍。
 */
async function apiEnvSet(req, res, body) {
  const key = String(body.key || '').trim()
  const value = String(body.value == null ? '' : body.value).trim()

  if (!ENV_WHITELIST.includes(key)) {
    return sendJson(res, 400, { error: `不认识的变量名：${key || '(空)'} —— 只允许 ${ENV_WHITELIST.join(' / ')}` })
  }
  if (!value) return sendJson(res, 400, { error: '值是空的，没写。' })
  if (/[\r\n]/.test(value)) return sendJson(res, 400, { error: '值里不能有换行。' })

  const file = join(PROJECT_ROOT, '.env')
  let raw = ''
  try { raw = await readFile(file, 'utf8') } catch { /* 文件不存在就新建一个 */ }

  /*
   * 逐行改，**保留原有的一切**（注释、空行、其它 KEY、书写顺序）。
   * 为什么不整份重写：.env 是用户自己的文件，里面可能有他自己加的注释和变量，
   * 被我们重写一遍就等于把他写的东西丢了 —— 而我们只是想加一行。
   * 行尾跟着原文件走（Windows 上常是 CRLF），别把一个文件改成两种行尾。
   */
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw ? raw.split(/\r?\n/) : []
  while (lines.length && lines[lines.length - 1] === '') lines.pop()

  const idx = lines.findIndex((l) => {
    const s = l.trim()
    if (!s || s.startsWith('#')) return false
    const eq = s.indexOf('=')
    return eq > 0 && s.slice(0, eq).trim() === key
  })
  const replaced = idx >= 0
  if (replaced) lines[idx] = `${key}=${value}`
  else lines.push(`${key}=${value}`)

  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, lines.join(eol) + eol, 'utf8')
    await rename(tmp, file)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 临时文件没建起来也无所谓 */ }
    return sendJson(res, 500, { error: `写 .env 失败：${e.message}` })
  }

  // 写进当前进程：这一步不能省 —— 服务是长驻的，探活读的是 process.env。
  // 少了它，文件写对了但这次探活仍然说"缺变量"，用户会以为填错了。
  process.env[key] = value

  let payload
  try {
    payload = await membersPayload(true)   // 强制重探：可用性只看实测
  } catch (e) {
    return sendJson(res, 200, { ok: true, key, replaced, members: [], error: `已写入，但重探失败：${e.message}` })
  }
  sendJson(res, 200, { ok: true, key, replaced, file: relative(PROJECT_ROOT, file) || '.env', ...payload })
}

async function apiMemberAdd(req, res, body) {
  const m = body.member || {}
  const id = String(m.id || '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) {
    return sendJson(res, 400, { error: 'id 需小写字母开头，只含小写字母/数字/下划线/连字符，最长 32 位' })
  }
  if (!m.name) return sendJson(res, 400, { error: '缺少名称' })
  if (!m.command) return sendJson(res, 400, { error: '缺少命令（可执行文件路径或命令名）' })

  const cfg = readConfig()
  if ((cfg.members || []).some((x) => x.id === id)) {
    return sendJson(res, 409, { error: `成员 ${id} 已存在` })
  }

  const spec = {
    id,
    name: String(m.name),
    adapter: ['generic', 'doubao'].includes(m.adapter) ? m.adapter : 'generic',
    enabled: true,
    command: String(m.command),
    promptMode: ['stdin', 'arg', 'file'].includes(m.promptMode) ? m.promptMode : 'stdin',
    argsTemplate: Array.isArray(m.argsTemplate) ? m.argsTemplate : [],
    probeArgs: Array.isArray(m.probeArgs) && m.probeArgs.length ? m.probeArgs : ['--version'],
    defaultPermission: VALID_PERMS.includes(m.defaultPermission) ? m.defaultPermission : 'plan',
    timeoutMs: Number(m.timeoutMs) > 0 ? Number(m.timeoutMs) : 600000,
    outputFormat: 'text',
    capabilities: Array.isArray(m.capabilities) ? m.capabilities : ['code', 'free'],
    permissionArgs: { readonly: [], plan: [], execute: [], full: [] },
    notes: String(m.notes || '由界面添加，尚未人工核实过。'),
  }
  if (m.env && typeof m.env === 'object' && Object.keys(m.env).length) spec.env = m.env

  cfg.members.push(spec)
  await writeConfig(cfg)
  registry = loadRegistry(CONFIG_PATH)

  const r = await registry.probeOne(id)
  if (!r?.available) {
    const cfg2 = readConfig()
    cfg2.members = cfg2.members.filter((x) => x.id !== id)
    await writeConfig(cfg2)
    registry = loadRegistry(CONFIG_PATH)
    return sendJson(res, 200, {
      ok: false,
      rolledBack: true,
      reason: r?.reason || '探活未通过',
      raw: String(r?.raw || '').slice(0, 1200),
    })
  }
  sendJson(res, 200, { ok: true, id, name: spec.name, version: r.version || '' })
}

async function apiMemberUpdate(req, res, body) {
  const id = String(body.id || '')
  const patch = body.patch || {}
  const cfg = readConfig()
  const m = (cfg.members || []).find((x) => x.id === id)
  if (!m) return sendJson(res, 404, { error: `没有成员 ${id}` })

  if ('enabled' in patch) m.enabled = !!patch.enabled
  if ('defaultPermission' in patch) {
    if (!VALID_PERMS.includes(patch.defaultPermission)) {
      return sendJson(res, 400, { error: `权限档非法：${patch.defaultPermission}` })
    }
    m.defaultPermission = patch.defaultPermission
  }
  if ('model' in patch) m.model = String(patch.model)

  await writeConfig(cfg)
  registry = loadRegistry(CONFIG_PATH)
  sendJson(res, 200, { ok: true, id })
}

/**
 * 把"用户选的工作目录"记下来，让下次打开还回到这里。
 *
 * 落盘位置由**启动方**指定（壳通过 `AGENTHUB_STATE_FILE` 传进来），而不是服务自己挑。
 * 理由：这个服务不知道自己被谁拉着跑 —— 可能是 `npm run ui` 手动起的（那就别落盘，
 * 免得在你机器上留一个你没要的文件），也可能是 Electron 壳以**一次性数据目录**拉起
 * （smoke 就是这种，落盘正好落在临时目录里，测试跑一百遍也不污染真实状态）。
 *
 * **只记不读**。"没有指定就用默认"这个判断属于壳：只有它知道默认是什么，
 * 也只有它能检查记下的那个目录是不是还在。
 */
function rememberWorkdir(dir) {
  const f = process.env.AGENTHUB_STATE_FILE
  if (!f) return
  try { writeFileSync(f, dir, 'utf8') } catch { /* 记不住偏好不该影响切目录这件事本身 */ }
}

/** 单成员探活（界面「测试」按钮）。只探一个，不动其他人 —— REST 成员探活会真发请求。 */
async function apiProbe(req, res, url) {
  const id = url.searchParams.get('id')
  if (!id) return sendJson(res, 400, { error: '缺少 id' })
  const r = await registry.probeOne(id)
  if (!r) return sendJson(res, 404, { error: `没有成员 ${id}` })
  sendJson(res, 200, { id, ...r })
}

/** 单成员对话。 */
async function apiChat(req, res, body) {
  const adapter = registry.get(body.memberId)
  if (!adapter) return sendJson(res, 400, { error: `没有成员 ${body.memberId}` })

  const t0 = Date.now()
  try {
    const r = await adapter.run({
      prompt: body.prompt ?? '',
      permission: body.permission || adapter.spec.defaultPermission,
      workdir: body.workdir ? safeResolveInWorkdir(body.workdir) : WORKDIR,
      role: body.role,
    })
    sendJson(res, 200, {
      memberId: body.memberId,
      memberName: adapter.name,
      status: r.status,
      text: r.text,
      cost: r.cost || {},
      raw: { command: r.raw?.command, exitCode: r.raw?.exitCode, stderr: r.raw?.stderr },
      durationMs: r.raw?.durationMs ?? Date.now() - t0,
    })
  } catch (e) {
    sendJson(res, 200, {
      memberId: body.memberId,
      memberName: adapter.name,
      status: 'failed',
      text: `调用失败：${e.message}`,
      cost: {},
      durationMs: Date.now() - t0,
    })
  }
}

/** 主脑拆解目标。 */
/**
 * 「交给主脑」—— 把目标落盘成一份待拆解请求，等 WorkBuddy 从 MCP 那侧取走。
 *
 * ## 为什么界面上需要这条接口
 *
 * WorkBuddy 是主脑，但它**没有 CLI** —— 引擎没法像调 claude 那样"调用"它。
 * 它只能从另一侧过来：作为 MCP 客户端调 `agenthub_run_plan`（见 mcp-server/index.js）。
 * 所以界面上把主脑选成 WorkBuddy 时，引擎能做的不**不是替它拆**，而是把请求**存下来**，
 * 并给用户一句可以直接交给 WorkBuddy 的话。
 *
 * ## 「存下来」不是装饰
 *
 * 它让"我已经把活交给主脑了"变成**有留痕、可核对**的事实 —— 谁在什么时候交的什么目标，
 * 落在一个 JSON 文件里，而不是弹完就没的提示。目录在 workdir 下（`.agenthub/inbox/`），
 * 和运行轨迹放在一起：**用户找得到，WorkBuddy 也找得到。**
 *
 * ## 为什么不在这里顺手等主脑的产出
 *
 * 因为那需要一条**反向**通道（引擎 → WorkBuddy），而它并不存在：拆解是主脑做的，
 * 它拆完可以直接调 `agenthub_run_plan` 把活跑掉 —— 要不要"回到界面确认"是它的选择，
 * 引擎替它决定不了。这里只如实记录请求，**不假装有个队列在转**。
 */
async function apiPlanRequest(req, res, body) {
  const goal = String(body.goal || '').trim()
  if (!goal) return sendJson(res, 400, { error: '缺少 goal' })

  const dir = join(WORKDIR, '.agenthub', 'inbox')

  /*
   * 用户在左栏勾的分工，跟着请求一起落盘。
   *
   * 这是主脑路径**唯一**能把"用户想要哪些角色"带过去的地方：主脑那边是个 MCP 客户端
   * （见 mcp-server/index.js），它拿到的是这个 JSON 文件。不写进来，用户在界面上
   * 精心勾的分工就在这一步蒸发了 —— 而界面还显示着"已交给主脑"，属于无声丢数据。
   *
   * 这里只做**去重 + 去空**，不校验名字是否在目录里：主脑是我们自己的另一侧，
   * 它比引擎更清楚有哪些角色可用，替它筛反而会挡住未来的新角色。
   */
  const roles = Array.isArray(body.roles)
    ? [...new Set(body.roles.map((r) => String(r).trim()).filter(Boolean))]
    : []

  const payload = {
    id: `plan-${Date.now()}`,
    goal,
    roles,
    workdir: WORKDIR,
    createdAt: new Date().toISOString(),
    status: 'pending',
    note: '待主脑拆解。WorkBuddy 据此拆解后可调用 agenthub_run_plan 执行；引擎自己不会拆。'
      + (roles.length ? `用户指定分工：${roles.join(' / ')}。` : ''),
  }
  const file = join(dir, `${payload.id}.json`)

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
  } catch (e) {
    return sendJson(res, 500, { error: `写待拆解请求失败：${e.message}` })
  }

  sendJson(res, 200, { ok: true, file, ...payload })
}

async function apiPlan(req, res, body) {
  if (!body.goal) return sendJson(res, 400, { error: '缺少 goal' })
  const t0 = Date.now()
  try {
    const { plan, raw, cost, repaired, repairReason, roster, status, roles, droppedRoles } = await planWithMember(registry, body.goal, {
      memberId: body.memberId || 'claude',
      // 工作台上勾的分工。引擎侧还会再对一遍目录，认不出的丢掉并在回执里说明
      roles: body.roles,
    })
    sendJson(res, 200, {
      plan,
      /*
       * 只有「干净成功」才省掉 raw。
       *
       * 第二轮实跑又踩了一次同一个主题的坑：那次是**抢救成功**（repaired=true），
       * 于是 raw 被当成"成功"省略掉了 —— 等发现问题时手里没有原始输出可查，
       * 只能靠猜"为什么回退了 9 段才勉强拼出来"。
       * 结论：**凡是结果需要解释的情况，证据都不能省。** 干净成功才不需要解释。
       */
      raw: plan && !repaired ? '' : String(raw || '').slice(0, 200000),
      rawLength: String(raw || '').length,
      repaired: !!repaired,
      repairReason: repairReason || '',
      roster: roster || [],
      /*
       * 回执里带上**实际生效的分工**和**被丢掉的角色名**。
       *
       * 丢掉不是静默行为：界面要能说"你勾的角色里有 1 个名字不认识，已忽略"，
       * 否则用户勾了 3 个、只出来 2 个，无从判断是引擎丢了还是规划者没照办。
       */
      roles: roles || [],
      droppedRoles: droppedRoles || [],
      plannerStatus: status || '',
      cost,
      durationMs: Date.now() - t0,
    })
  } catch (e) {
    sendJson(res, 200, { plan: null, raw: `拆解失败：${e.message}`, cost: {}, durationMs: Date.now() - t0 })
  }
}

/** 干跑预检。 */
async function apiDry(req, res, body) {
  const orch = new Orchestrator(registry, { permission: body.permission || 'plan' })
  sendJson(res, 200, orch.dryRun(body.plan))
}

/**
 * 运行现场 —— 单卡片重跑要用它。
 *
 * 为什么不放在前端、让前端把 ctx 传回来：
 * 前端手里的 `task.cards` 只有"给人看"的那几个字段（text / status / quality / changedFiles），
 * 而现场里还有 trace 的 `raw`（命令、退出码、stderr）、每一步真正发出去的 prompt、
 * 累计花费 `spentUsd`、快照判定用的 `changedFiles: null vs []`……
 * 让前端把它拼回来，等于把引擎的内部结构复制一份到浏览器里，两边迟早不一致 ——
 * 而"报告要能说真话"恰恰是靠这些字段撑着的。
 *
 * 代价：进程重启后会丢。丢了就**明说丢了**（见 apiRetry），
 * 绝不退化成"那就从头再跑一遍吧" —— 那是在用户没同意的情况下把已经花过的钱再花一遍。
 */
const RUNS = new Map()   // taskId → { plan, ctx, trace, options, workdir, updatedAt }
const RUNS_MAX = 20      // 只留最近这几次；这是个本地单用户工具，不需要持久化

function rememberRun(taskId, rec) {
  if (!taskId) return
  RUNS.delete(taskId)          // 重新插入，维持"最近用过的排最后"的顺序
  RUNS.set(taskId, rec)
  while (RUNS.size > RUNS_MAX) RUNS.delete(RUNS.keys().next().value)
}

/**
 * SSE 心跳的间隔（毫秒）。
 *
 * 为什么需要它：成员调用一次动辄几十秒（有的成员默认超时 10 分钟），
 * 这段期间通道上**一个字节都没有**。浏览器自己的 EventSource 不会因为静默而断开，
 * 但中间的代理、VPN、系统休眠恢复都可能把它掐掉 ——
 * 而这里的失败方式是最坏的一种：**连接没了，任务其实还在服务端跑**，
 * 界面停在半路，用户以为跑完了（或者以为卡死了）。
 *
 * 15 秒是保守值：比任何常见的空闲超时都短，又不构成流量。
 * 可用 AGENTHUB_SSE_PING_MS 覆盖 —— **那是给测试用的**（把间隔压到几毫秒，
 * 才能在一次普通长度的运行里观察到心跳），正常不要动它。
 */
const SSE_PING_MS = Number(process.env.AGENTHUB_SSE_PING_MS || 15000)

/** 起一条 SSE 通道。首跑和单卡片重跑共用 —— 两条通道的事件格式完全一样。 */
function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (evt) => {
    try { res.write(`data: ${JSON.stringify(evt)}\n\n`) } catch { /* 前端断开 */ }
  }

  /*
   * 心跳用 **SSE 的注释行**（以 ':' 开头）。
   * 按协议，注释行必须被客户端忽略 —— 前端的解析器只认 `data:` 开头的行
   * （见 app.js 的 ssePost），所以它**不会**混进事件里，也不可能被当成坏帧。
   * 之所以不用"发一个假事件"：那是在协议层撒谎，前端得为一条谁都不认识的
   * 事件类型加分支，迟早有人把它当成真事件处理。
   */
  const ping = setInterval(() => {
    try { res.write(': ping\n\n') } catch { /* 前端断开 */ }
  }, SSE_PING_MS)
  // 别让心跳把进程钉住（定时器默认会阻止 Node 退出）
  if (typeof ping.unref === 'function') ping.unref()
  res.on('close', () => clearInterval(ping))

  // 立刻吐一个 open，避免浏览器等首个字节
  send({ type: 'open' })
  return send
}
/**
 * 协同执行 —— 全程 SSE。
 * 这是整套界面里最关键的一条通道：Orchestrator 的每一个 onEvent 都实时推给前端。
 */
async function apiRun(req, res, body) {
  const send = openSse(res)

  if (!body.plan) { send({ type: 'error', message: '缺少 plan' }); return res.end() }

  let workdir
  try { workdir = body.workdir ? safeResolveInWorkdir(body.workdir) : WORKDIR } catch (e) {
    send({ type: 'error', message: e.message }); return res.end()
  }

  const options = {
    permission: body.permission || 'plan',
    totalBudgetUsd: body.budget ?? null,
    // 一步失败之后剩下的活怎么办 —— 界面上是执行计划确认框里的那个下拉。
    // 非法值会由 resolveFailurePolicy 直接抛错，不静默兜底。
    onFailure: body.onFailure || undefined,
  }
  const orch = new Orchestrator(registry, options)

  const pre = orch.dryRun(body.plan)
  if (!pre.ok) {
    send({ type: 'error', message: '计划校验失败', errors: pre.errors })
    return res.end()
  }
  send({ type: 'plan-accepted', preview: pre.preview, batches: pre.batches })

  try {
    const { trace, ctx } = await orch.run(body.plan, { onEvent: send, workdir })
    // 存下现场 —— 之后单卡片重跑就靠它，不必整单重跑
    rememberRun(body.taskId, { plan: body.plan, ctx, trace, options, workdir, updatedAt: Date.now() })
    send({ type: 'trace', summary: trace.summary, markdown: trace.toMarkdown() })
  } catch (e) {
    send({ type: 'error', message: e.message })
  }
  res.end()
}

/**
 * 单卡片重跑 / 换人 / 跳过。
 *
 * 这条通道存在的理由只有一个：**别重复花已经花过的钱**。
 * 已经成功的步骤在引擎侧被明确排除在重跑范围外（见 Orchestrator.needsRun），
 * 这里只负责把现场取出来、交给引擎、再把结果推回去。
 */
async function apiRetry(req, res, body) {
  const send = openSse(res)
  const { taskId, id, action = 'retry', memberId } = body || {}

  if (!taskId || !id) { send({ type: 'error', message: '缺少 taskId 或子任务 id' }); return res.end() }
  if (!['retry', 'swap', 'skip'].includes(action)) {
    send({ type: 'error', message: `未知的操作 ${action}` }); return res.end()
  }

  const rec = RUNS.get(taskId)
  if (!rec) {
    /*
     * ★ 找不到现场时必须明说，且**不能替用户做别的决定**。
     * 如果这里写成"那我把整个计划重新跑一遍"，用户点一次重试就会被多扣一遍全程的钱 ——
     * 比没有这个功能更糟。所以宁可让他重新执行整个计划（那是他明确知道会发生什么的事）。
     */
    send({
      type: 'error',
      message: '找不到这次运行的现场（服务可能重启过）—— 不会替你重跑整单，请重新执行整个计划',
    })
    return res.end()
  }

  if (memberId && !registry.get(memberId)) {
    send({ type: 'error', message: `没有成员 ${memberId}` })
    return res.end()
  }

  const orch = new Orchestrator(registry, rec.options)
  try {
    send({ type: 'resume-ack', id, action, memberId: memberId || null })
    if (action === 'skip') {
      await orch.skipSubtask(rec.plan, { ctx: rec.ctx, trace: rec.trace, onEvent: send, id })
    } else {
      await orch.retrySubtask(rec.plan, { ctx: rec.ctx, trace: rec.trace, onEvent: send, id, memberId })
    }
    rec.updatedAt = Date.now()
    // 换人会改计划本身，回推让界面跟上 —— 计划的唯一权威在服务端
    send({ type: 'plan-updated', plan: rec.plan })
    send({ type: 'trace', summary: rec.trace.summary, markdown: rec.trace.toMarkdown() })
  } catch (e) {
    send({ type: 'error', message: e.message })
  }
  res.end()
}

/**
 * 写回文件 —— 编辑器保存用。
 *
 * 冲突检测是必需的，不是加分项：agent 也在改同一批文件，
 * 「打开时记下 mtime → 保存前比对」是唯一能防住互相覆盖的办法。
 * 不一致时**不覆盖**，返回 409 + 当前内容，交给界面出冲突卡片。
 */
async function apiWrite(req, res, body) {
  const p = body.path
  if (!p) return sendJson(res, 400, { error: '缺少 path' })
  const text = String(body.text ?? '')
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) {
    return sendJson(res, 400, { error: '内容超过 4MB，界面不做写回' })
  }

  let abs
  try { abs = safeResolveInWorkdir(p) } catch (e) { return sendJson(res, 400, { error: e.message }) }

  const cur = await stat(abs).catch(() => null)
  if (!cur) return sendJson(res, 404, { error: `文件不存在：${p}` })
  if (cur.isDirectory()) return sendJson(res, 400, { error: '这是一个目录' })

  const expect = body.expectMtimeMs
  if (expect != null && Math.round(cur.mtimeMs) !== Math.round(Number(expect))) {
    const currentText = await readFile(abs, 'utf8').catch(() => '')
    return sendJson(res, 409, {
      error: 'conflict',
      message: '文件已被外部修改（很可能是某个 agent 改的），未覆盖',
      current: { mtimeMs: cur.mtimeMs, size: cur.size, text: currentText.slice(0, 400000) },
    })
  }

  await writeFile(abs, text, 'utf8')
  const after = await stat(abs)
  sendJson(res, 200, { ok: true, path: p, size: after.size, mtimeMs: after.mtimeMs })
}

/** 文件树（只读，限制在 workdir 内）。 */
async function apiTree(req, res, url) {
  const rel = url.searchParams.get('dir') || '.'
  try {
    const abs = safeResolveInWorkdir(rel)
    const entries = await readdir(abs, { withFileTypes: true })
    const SKIP = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build'])
    const items = []
    for (const e of entries) {
      if (SKIP.has(e.name)) continue
      const full = join(abs, e.name)
      items.push({
        name: e.name,
        dir: e.isDirectory(),
        path: relative(WORKDIR, full).split(sep).join('/'),
      })
    }
    items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    sendJson(res, 200, { dir: rel, items })
  } catch (e) {
    sendJson(res, 400, { error: e.message })
  }
}

/** 读单个文件（只读，限制在 workdir 内，且限制大小）。 */
async function apiFile(req, res, url) {
  const p = url.searchParams.get('path')
  if (!p) return sendJson(res, 400, { error: '缺少 path' })
  try {
    const abs = safeResolveInWorkdir(p)
    const st = await stat(abs)
    if (st.isDirectory()) return sendJson(res, 400, { error: '这是一个目录' })
    if (st.size > 512 * 1024) return sendJson(res, 400, { error: `文件过大（${st.size} 字节），界面暂不预览` })
    const text = await readFile(abs, 'utf8')
    sendJson(res, 200, { path: p, size: st.size, mtimeMs: st.mtimeMs, text })
  } catch (e) {
    sendJson(res, 400, { error: e.message })
  }
}

// ── 路由 ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const { pathname } = url

  try {
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/members' && req.method === 'GET') return await apiMembers(req, res, url)
      if (pathname === '/api/probe' && req.method === 'GET') return await apiProbe(req, res, url)
      if (pathname === '/api/tree' && req.method === 'GET') return await apiTree(req, res, url)
      if (pathname === '/api/file' && req.method === 'GET') return await apiFile(req, res, url)

      const body = req.method === 'POST' ? await readBody(req) : {}
      if (pathname === '/api/env' && req.method === 'POST') return await apiEnvSet(req, res, body)
      if (pathname === '/api/chat' && req.method === 'POST') return await apiChat(req, res, body)
      if (pathname === '/api/plan' && req.method === 'POST') return await apiPlan(req, res, body)
      if (pathname === '/api/plan/request' && req.method === 'POST') return await apiPlanRequest(req, res, body)
      if (pathname === '/api/dry' && req.method === 'POST') return await apiDry(req, res, body)
      if (pathname === '/api/run' && req.method === 'POST') return await apiRun(req, res, body)
      if (pathname === '/api/retry' && req.method === 'POST') return await apiRetry(req, res, body)
      if (pathname === '/api/write' && req.method === 'POST') return await apiWrite(req, res, body)
      if (pathname === '/api/members/add' && req.method === 'POST') return await apiMemberAdd(req, res, body)
      if (pathname === '/api/members/update' && req.method === 'POST') return await apiMemberUpdate(req, res, body)

      if (pathname === '/api/workdir' && req.method === 'POST') {
        // 切换工作目录：**允许切到当前目录之外**（用户就是要点「打开别的项目」）。
        // 旧写法把新目录又塞进 safeResolveInWorkdir 校验，等于只能在子目录里打转，
        // 那是 bug 不是安全设计 —— 边界靠「必须是个存在的目录」来守。
        const target = resolve(body.workdir || '.')
        const st = await stat(target).catch(() => null)
        if (!st || !st.isDirectory()) {
          return sendJson(res, 400, { error: `不是已存在的目录：${target}` })
        }
        WORKDIR = target
        // 记住这次选择：服务的 WORKDIR 只在内存里，进程一退就没了 ——
        // 不记的话，"切到自己项目 → 关掉 → 再打开"会静默回到默认目录。
        rememberWorkdir(target)
        return sendJson(res, 200, { workdir: WORKDIR })
      }

      return sendJson(res, 404, { error: 'no such api: ' + pathname })
    }
    return await serveStatic(req, res, pathname)
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message })
    else try { res.end() } catch {}
  }
})

/** 端口被占用就顺延，最多试 10 个 */
function listen(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log(`端口 ${port} 被占用，试 ${port + 1}…`)
      listen(port + 1, attemptsLeft - 1)
    } else {
      console.error('启动失败：', err.message)
      process.exit(1)
    }
  })
  server.listen(port, '127.0.0.1')
}

/*
 * ★★ 2026-09-30 修掉的严重问题：**启动横幅会为每一次失败过的尝试各印一份**，
 * 于是"报出来的端口"和"真正绑上的端口"可以完全不是一回事。
 *
 * 旧写法是把横幅写进 `server.listen(port, host, cb)` 的回调 —— 那个回调本质上是
 * `once('listening')`。EADDRINUSE 的尝试**不会**触发 listening，但它的回调**已经
 * 注册上去、不会因为失败被摘掉**；等顺延后的那次真的绑上时，listening 只派发一次，
 * 却把攒下来的**所有**回调都跑一遍，每个闭包里装着它自己那一次的 `port`。
 * 实测（8790、8791 都被占，顺延到 8792）：
 *
 *     端口 8790 被占用，试 8791…
 *     端口 8791 被占用，试 8792…
 *       → http://127.0.0.1:8790      ← 假的：这个端口是别人的
 *       → http://127.0.0.1:8791      ← 假的
 *       → http://127.0.0.1:8792      ← 真的
 *
 * 为什么这一条是致命的：`electron/main.js` 在日志里**只认第一个** `http://` 就把窗口
 * 指过去（那边还有 navStarted「只许导航一次」的约束）。于是只要走了顺延这条路，壳就
 * **百分之百**导航到那个已经被别人占着的端口：
 *   - 占着它的是上一次残留的 AgentHub → 窗口显示的是**旧实例**的界面（状态还是旧的）
 *   - 占着它的是别的东西、或者那个进程刚退 → 连不上，用户看到的只有空白或失败页
 * 而"8787 被上一次的实例占着"偏偏是日常最常见的启动场景（壳自己的注释里都写了），
 * 所以它的表现是**时好时坏的"打不开"**：把残留进程关掉再点一次就好了 ——
 * 于是永远查不到病因。
 *
 * 现在横幅只挂**一个** listening，端口从 `server.address()` 读 ——
 * 那是绑定结果本身，而不是"我以为我要绑哪个"。
 */
server.once('listening', () => {
  const port = server.address().port
  console.log('')
  console.log('  AgentHub 界面已启动')
  console.log(`  → http://127.0.0.1:${port}`)
  console.log(`  工作目录：${WORKDIR}`)
  if (dotenvCount) console.log(`  已从 .env 载入 ${dotenvCount} 个环境变量`)
  console.log('  （只监听 127.0.0.1；Ctrl+C 停止）')
  console.log('')
})
listen(PORT)
