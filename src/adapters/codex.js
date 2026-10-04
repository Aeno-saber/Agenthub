/**
 * Codex 适配器 —— 把本机的 codex CLI 接成一个成员
 *
 * 实测环境：Windows 11 / codex-cli 0.159.2（Codex 桌面版自带的那份 CLI）
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么不用 generic 适配器
 *
 * `codex exec --json` 吐的是 **JSONL：一行一个事件**，不是一整块 JSON。
 * generic 的 outputFormat: 'json' 走的是 JSON.parse(整个 stdout) —— 喂给它必然解析失败，
 * 然后**静默退回纯文本**：跑是能跑，但交付的是混着 "Reading additional input from stdin..."
 * 和一堆事件对象的原始流，正文被噪音包住、token 用量全丢。所以 JSONL 必须单独解析。
 *
 * ## 实测出来的四件事（样本见 tests/fixtures/codex-exec-*.jsonl）
 *
 * 1. **stdout 里会混非 JSON 行。** stdin 有内容时 codex 先印一行
 *    "Reading additional input from stdin..."。逐行解析必须跳过它。
 *
 * 2. **item 级的 error 不等于失败。** 一次**成功**的运行（退出码 0、文件真改对了）里就有：
 *      {"item":{"type":"error","message":"Model metadata for deepseek-v4-flash not found…"}}
 *    这是模型元数据缺失的**告警**。把 item 级 error 一律当失败，等于每一次成功运行都记 failed。
 *
 * 3. **真失败长在 turn 级。** 用假模型名跑一次，拿到的是：
 *      {"type":"error","message":"{…invalid_request_error…}"}
 *      {"type":"turn.failed","error":{"message":"{…}"}}      退出码 1
 *    所以判定只看三处：**turn.failed / turn 级 error / 退出码非 0**。
 *    （turn.failed 里的 message 是一层 JSON 字符串，得拆开才读得懂 —— 见 unwrapErrorMessage。）
 *
 * 4. **命令失败也不等于这一步失败。** 只读档那次实测：agent 试着写文件被沙箱拒了，
 *    事件里是 {"status":"failed","exit_code":1}，但整轮照常收尾、退出码 0，
 *    agent 自己把"被拒了"写进了结论。**这是正确行为，不是故障。**
 *
 * ## 两件刻意不做的事
 *
 * · **不上报 changedFiles。** 实测那次任务真的创建了 hello.txt，但它走的是 shell 命令
 *   （Set-Content）而不是 file_change 事件 —— 事件流里**一条文件改动都没有**。
 *   而 "[]" 在判定层的含义是"量过了，确实没改"（见 quality.js）。
 *   拿事件流当改动清单，就是拿一把量不到东西的尺子去定罪。所以保持 null（未采集），
 *   交给引擎的目录快照去测。
 *
 * · **不落会话文件**（--ephemeral）。一次协同会跑几十个子任务，每个都在
 *   ~/.codex/sessions 里留一条的话，用户自己的 Codex 历史会被冲垮。代价是这些子任务
 *   不可 resume —— 但 AgentHub 本来也不 resume 子任务，排障看的是 .agenthub/runs/*.json。
 *
 * ## 命令路径为什么要动态找
 *
 * codex 的可执行文件在 %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe，
 * **哈希目录每次 Codex 自更新都会换**（实测同一台机器上并存两个哈希目录，
 * 其中一个里面只剩 rg.exe）。写死路径必然在某次更新后失效，
 * 而失效的表现是"成员突然不可用"，当场很难归因。解析顺序：
 *   1. 配置里显式写的 command —— 文件还在就用它（用户能覆盖）
 *   2. commandSearch 里的通配路径（默认见 DEFAULT_CODEX_SEARCH），取修改时间最新的
 *   3. PATH 里的 codex（最后兜底）
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import process from 'node:process'

import { BaseAdapter, rolePrompt, describePermission } from './base.js'
import { execMember, cleanStderr, elide } from './exec.js'

const nodeFs = {
  existsSync: (p) => existsSync(p),
  readdirSync: (p) => readdirSync(p),
  statSync: (p) => statSync(p),
}

/**
 * commandSearch 没配时的默认搜索路径。
 *
 * 两个位置都认：LOCALAPPDATA 下那份是 Codex 桌面版装的，USERPROFILE 下的是
 * 独立安装位置。任一命中即可，取最新的那个。
 */
export const DEFAULT_CODEX_SEARCH = [
  '%LOCALAPPDATA%\\OpenAI\\Codex\\bin\\*\\codex.exe',
  '%USERPROFILE%\\AppData\\Local\\OpenAI\\Codex\\bin\\*\\codex.exe',
]

/** 展开 %VAR% 形式的环境变量。认不出来的原样留着 —— 那样路径必然不存在，会被跳过，不会误命中。 */
export function expandEnvVars(str, env = process.env) {
  return String(str).replace(/%([^%]+)%/g, (whole, name) => {
    const hit = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()]
    return hit == null ? whole : String(hit)
  })
}

/**
 * 展开一个只支持 "*" 当一层目录名的通配路径，返回命中的**文件**，按修改时间从新到旧。
 *
 * 刻意不引 glob 依赖（本项目零依赖）：这里只需要"一层通配 + 取最新"，
 * 手写二十行足够，而且能直接喂假的 fs 做测试。
 */
export function expandGlob(pattern, deps = {}) {
  const fs = deps.fs || nodeFs
  const parts = String(pattern).split(/[\\/]+/)
  let nodes
  let rest
  if (parts[0] && /^[A-Za-z]:$/.test(parts[0])) {
    nodes = [parts[0] + sep]
    rest = parts.slice(1)
  }
  else if (parts[0] === '') {
    nodes = [sep]
    rest = parts.slice(1)
  }
  else {
    nodes = ['']
    rest = parts
  }

  for (const part of rest) {
    if (!part) continue
    const next = []
    for (const base of nodes) {
      if (part === '*') {
        let names = []
        try { names = fs.readdirSync(base || '.') } catch { names = [] }
        for (const name of names) {
          const full = join(base || '.', name)
          let isDir = false
          try { isDir = fs.statSync(full).isDirectory() } catch { isDir = false }
          if (isDir) next.push(full)
        }
      }
      else {
        next.push(join(base || '.', part))
      }
    }
    nodes = next
  }

  const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs || 0 } catch { return 0 } }
  return nodes
    .filter((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile() } catch { return false } })
    .sort((a, b) => mtimeOf(b) - mtimeOf(a))
}

/**
 * 定位这一次要调哪个 codex 可执行文件。
 *
 * @returns {{command:string, source:'config'|'search'|'fallback', pattern?:string, candidates?:string[]}}
 */
export function resolveCodexCommand(spec = {}, deps = {}) {
  const env = deps.env || process.env
  const fs = deps.fs || nodeFs
  const explicit = spec.command ? String(spec.command) : ''
  const exists = (p) => { try { return !!p && fs.existsSync(p) } catch { return false } }

  if (exists(explicit)) return { command: explicit, source: 'config' }

  const patterns = Array.isArray(spec.commandSearch) && spec.commandSearch.length
    ? spec.commandSearch
    : DEFAULT_CODEX_SEARCH
  for (const pattern of patterns) {
    const hits = expandGlob(expandEnvVars(pattern, env), { ...deps, fs })
    if (hits.length) return { command: hits[0], source: 'search', pattern, candidates: hits }
  }

  // 兜底：让 shell 去 PATH 里找。找不到时 spawn 会失败，probe 会把话说清楚。
  return { command: explicit || 'codex', source: 'fallback' }
}

/** codex 的凭据文件位置（CODEX_HOME 优先，其次 ~/.codex） */
export function codexAuthFile(env = process.env) {
  const home = env.CODEX_HOME
    || (env.USERPROFILE ? join(env.USERPROFILE, '.codex') : '')
    || (env.HOME ? join(env.HOME, '.codex') : '')
  return home ? join(home, 'auth.json') : ''
}

/**
 * 登录态前置检查 —— 零成本，挡的是"最难查的那类失败"。
 *
 * 没有凭据时，codex exec 会在**真跑任务**时才报鉴权失败 —— 那时成员看着是绿的、
 * 活已经派下去、钱已经花了。这和 index.js 的 precheckEnv 是同一条规矩：
 * **探活前先把"没配"挡掉，并说清缺什么。**
 *
 * ⚠️ 边界同样只到"挡得住没配，挡不住配错/过期"。所以探针仍然要真跑一次 --version。
 */
export function precheckAuth(spec = {}, env = process.env, fs = nodeFs) {
  const keyed = ['OPENAI_API_KEY', 'CODEX_API_KEY'].some((k) => env[k] || (spec.env || {})[k])
  if (keyed) return null
  const file = codexAuthFile(env)
  if (file && fs.existsSync(file)) return null
  return {
    available: false,
    reason: file
      ? '未登录：找不到 ' + file + '（先跑一次 codex login，或在 .env 里配 OPENAI_API_KEY）'
      : '未登录，也定位不到凭据目录（缺 USERPROFILE / CODEX_HOME）—— 先跑一次 codex login',
  }
}

/**
 * 把 turn.failed / turn 级 error 里的 message 拆成人话。
 *
 * 实测那次失败的原文是一层套着的 JSON 字符串：
 *   "{\"error\":{\"message\":\"The supported API model names are …\"}}"
 * 原样展示给用户等于没展示。拆得开就拆，拆不开就原样返回。
 */
export function unwrapErrorMessage(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s.startsWith('{')) return s
  try {
    const o = JSON.parse(s)
    return String(o?.error?.message || o?.message || s).trim()
  }
  catch { return s }
}

/**
 * stdout 一行的判定：codex 这一轮是不是已经收尾了。
 *
 * ★ 为什么值得单独抽出来测：实测 codex **1.9 秒就答完了，进程却还要再挂 ~10 秒**才退出
 *   （时间线：turn.completed 1857ms → exit 11879ms）。那 10 秒纯属白等，而成员调用是
 *   串在用户等待路径上的。判定写错的表现不是报错，是"优化看着像生效了、其实没有"。
 *
 * 只认 type 字段，不在整行里搜 "turn.completed" 字样 —— agent 的正文里出现这串字符
 * 完全可能，那时候收工会把真正的交付切掉。
 */
export function isTurnEndLine(line) {
  return /"type"\s*:\s*"turn\.(completed|failed)"/.test(String(line))
}

/**
 * 解析 codex exec --json 的 JSONL 输出。
 *
 * 抽成纯函数是为了能直接拿真实样本测（tests/fixtures/codex-exec-*.jsonl）——
 * 这段判定错一个分支，表现不是报错，而是**安静地把失败记成成功**。
 *
 * ★ 同一个 item 会出现两次（item.started 然后 item.completed，见样本里的 command_execution）。
 *   按 item.id 去重、**后到的覆盖先到的**，否则每条命令都会被记两遍。
 */
export function parseCodexJsonl(stdout = '') {
  const out = {
    threadId: '',
    messages: [],        // agent_message 的正文，按出现顺序
    notes: [],           // item 级 error = 诊断告警（**成功运行里也有**）
    turnErrors: [],      // turn 级 error / turn.failed = 真失败信号
    commands: [],        // 跑过的命令（排障用；含被沙箱拒掉的那些）
    unknownItemTypes: [],
    usage: null,
    sawTurnCompleted: false,
    turnFailed: false,
    unparsed: [],        // 不是 JSON 的行（例如 "Reading additional input from stdin..."）
  }

  const byId = new Map()
  const order = []
  let anon = 0

  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (!line.startsWith('{')) { out.unparsed.push(line); continue }

    let evt = null
    try { evt = JSON.parse(line) } catch { out.unparsed.push(line); continue }
    if (!evt || typeof evt !== 'object') { out.unparsed.push(line); continue }

    const type = evt.type
    if (type === 'thread.started') {
      if (evt.thread_id) out.threadId = String(evt.thread_id)
      continue
    }
    if (type === 'turn.completed') {
      out.sawTurnCompleted = true
      if (evt.usage) out.usage = evt.usage
      continue
    }
    if (type === 'turn.failed') {
      out.turnFailed = true
      out.turnErrors.push(evt.error?.message ?? evt.message ?? '')
      continue
    }
    if (type === 'turn.started') continue
    // turn 级 error：不带 item，直接挂在事件上（见样本 codex-exec-failed.jsonl）
    if (type === 'error' && !evt.item) {
      out.turnErrors.push(evt.message ?? '')
      continue
    }

    const item = evt.item
    if (!item || typeof item !== 'object') continue

    const id = item.id ? String(item.id) : 'anon-' + (anon++)
    if (!byId.has(id)) order.push(id)
    byId.set(id, { ...(byId.get(id) || {}), ...item })
  }

  for (const id of order) {
    const item = byId.get(id)
    switch (item.type) {
      case 'agent_message':
        out.messages.push({ id, text: String(item.text ?? '') })
        break
      case 'error':
        out.notes.push(String(item.message ?? '').trim())
        break
      case 'command_execution':
        out.commands.push({
          id,
          command: String(item.command ?? ''),
          output: String(item.aggregated_output ?? ''),
          exitCode: item.exit_code ?? null,
          status: String(item.status ?? ''),
        })
        break
      case 'reasoning':
        break
      default:
        if (!out.unknownItemTypes.includes(item.type)) out.unknownItemTypes.push(item.type)
    }
  }

  return out
}

/**
 * 这一步的交付正文 —— 取**最后一条**非空 agent_message。
 *
 * 为什么不把几条拼起来：agent 干活时会先来一句"我先建个文件"（样本里的 item_1），
 * 那句是过程话术，不是交付物；最后那条才是结论（item_3）。
 * 拼接会把过程话术混进交付，报告和判定层都要跟着忍受噪音。
 */
export function codexResultText(parsed) {
  const texts = (parsed?.messages || []).map((m) => m.text).filter((t) => t && t.trim())
  return texts.length ? texts[texts.length - 1].trim() : ''
}

/**
 * 由「JSONL 解析结果 + 进程退出码」定出这一步的结论。
 *
 * 抽成纯函数是被逼的：这段判定里最容易写错的一条（**item 级 error 不算失败**）
 * 只在"成功运行里恰好带着一条告警"时才暴露 —— 而那正是最难手工复现的场景。
 * 真实样本 tests/fixtures/codex-exec-ok.jsonl 就是这样一份：文件改对了、退出码 0，
 * 里面却有一条 Model metadata not found 的 error 项。
 *
 * @param {boolean} [opts.stoppedEarly] 是不是我们自己按树收的工（见 exec.js 的 stopWhen）。
 *        为 true 时**不拿退出码定罪** —— 那个非 0 是我们自己造成的，见下面的说明。
 * @returns {{status:string, errorKind:?string, errorLine:string}}
 */
export function resolveOutcome(parsed, opts = {}) {
  const { exitCode = null, timedOut = false, durationMs = 0, stoppedEarly = false } = opts

  if (timedOut) {
    return {
      status: 'timeout',
      errorKind: null,
      errorLine: '超时（' + Math.round(durationMs / 1000) + 's）后被终止',
    }
  }

  const turnErrors = (parsed?.turnErrors || []).map(unwrapErrorMessage).filter(Boolean)

  /*
   * ★ 退出码那一条要**排除 stoppedEarly**：那个非 0 退出码是我们自己 taskkill 出来的
   *   （见 exec.js 的 stopTree），不是成员报的错。不排除的话，每一次"答完就收工"的正常
   *   运行都会被记成 failed，而且是安静地记错。真的 turn 级失败不受影响：
   *   它走上面两个信号，与退出码无关。
   */
  const exitFailed = exitCode !== 0 && !stoppedEarly

  // 真失败只有三个来源：turn.failed、turn 级 error、退出码非 0（见文件头第 3 条）
  if (parsed?.turnFailed || turnErrors.length || exitFailed) {
    return {
      status: 'failed',
      errorKind: parsed?.turnFailed ? 'turn_failed' : (turnErrors.length ? 'turn_error' : 'exit_code'),
      errorLine: turnErrors[0] || '',
    }
  }

  /*
   * 收尾正常。这里**刻意不看** item 级 error，也不看命令的 exit_code：
   * 前者是告警（成功运行里也有），后者可能只是 agent 试了一下被沙箱拒掉、
   * 而它自己已经把这件事写进结论了。见文件头第 2、4 条。
   */
  return { status: 'ok', errorKind: null, errorLine: '' }
}

export class CodexAdapter extends BaseAdapter {
  /**
   * ★ codex 的输出是**逐事件**交回来的（`exec --json` 一行一个 JSON），
   * 不是"攒到最后一次性吐一大段"。所以规划者那两条防截断的上限
   * （子任务 2-6 个、prompt ≤150 字）对它没有意义 —— 显式声明出去，
   * 让规划提示词按规划者自己的能力选口径（见 src/engine/planner.js）。
   */
  get streamsStructuredOutput() { return true }

  /** 本次要调用的可执行文件（界面用它显示"在哪"） */
  get command() {
    if (!this._resolved) this._resolved = resolveCodexCommand(this.spec)
    return this._resolved.command
  }

  /** 这个路径是怎么来的：config / search / fallback —— 排障时第一个要看的东西 */
  get commandSource() {
    void this.command
    return this._resolved.source
  }

  async probe() {
    const bin = this.command
    const r = await execMember(bin, ['--version'], { timeoutMs: 30000 })
    const out = (r.stdout || '').trim() || cleanStderr(r.stderr)

    if (r.exitCode !== 0 || !out) {
      return {
        available: false,
        reason: r.spawnFailed
          ? '命令无法启动（' + bin + '）—— 路径可能已随 Codex 更新失效，检查 command / commandSearch'
          : '退出码 ' + r.exitCode,
        raw: elide(out, 400),
      }
    }

    const version = out.split('\n')[0].trim()
    const blocked = precheckAuth(this.spec)
    if (blocked) return { ...blocked, version, raw: elide(out, 400) }
    return { available: true, version, raw: out }
  }

  /**
   * 权限档位 → 命令行参数。
   *
   * ★ readonly 与 plan **映射到同一个沙箱**（-s read-only）。这不是偷懒，是 codex 没有
   *   更细的档：它的沙箱只有 read-only / workspace-write / danger-full-access 三档，
   *   而"计划档"在 AgentHub 里的意思是"能读能规划、不动文件"，与只读档在**文件系统
   *   约束上是同一件事** —— 区别在提示词层的意图，不在沙箱。
   *   ⚠️ 实测（只读档跑 Get-Location + Set-Content）：**命令是能跑的**，被拒的是写文件。
   *   所以界面上"只读 = 不跑命令"那句对 codex 不成立（对 dsh 也不成立，见 docs/05）。
   *   这件事写在成员的 notes 里，不能让界面替成员许下它做不到的承诺。
   */
  permissionArgs(level) {
    return describePermission(this.spec, level).args
  }

  permissionEnv(level) {
    return describePermission(this.spec, level).env
  }

  buildArgs(opts = {}) {
    const level = opts.permission || this.spec.defaultPermission || 'plan'
    const args = [
      'exec',
      '--json',
      // 不落会话文件 —— 见文件头"刻意不做的事"
      '--ephemeral',
      // 输出不要颜色。管道里本来是自动关的，显式写死是不想在某个版本上赌
      '--color', 'never',
      // AgentHub 的工作目录可以是任意文件夹（默认是「文档/AgentHub」），不一定是 git 仓库；
      // 不加这个 codex 会直接拒绝执行
      '--skip-git-repo-check',
      ...this.permissionArgs(level),
    ]

    if (opts.workdir) args.push('-C', opts.workdir)
    if (opts.model) args.push('-m', opts.model)

    // 末位 '-' = 从标准输入读指令（codex 官方写法）。多行指令走命令行会被 cmd.exe 截断，
    // 这条规矩见 exec.js 文件头。
    args.push('-')
    return args
  }

  async run(opts = {}) {
    const level = opts.permission || this.spec.defaultPermission || 'plan'

    /*
     * 角色说明**前置在指令最前面**。
     *
     * codex 没有 --append-system-prompt 那种等价的系统提示开关。想走 -c 配置键注入，
     * 只能猜键名 —— 猜错了会被**静默忽略**（未知配置键不报错），那是最坏的一种失败。
     * 前置在 prompt 里是版本无关的，代价只是它进了用户消息而不是系统消息。
     */
    const role = opts.role ? rolePrompt(opts.role) : ''
    const prompt = role ? role + '\n\n' + (opts.prompt ?? '') : (opts.prompt ?? '')

    const r = await execMember(this.command, this.buildArgs(opts), {
      input: prompt,
      workdir: opts.workdir,
      timeoutMs: opts.timeoutMs ?? this.spec.timeoutMs ?? 600000,
      env: {
        ...(this.spec.env || {}),
        ...this.permissionEnv(level),
      },
      /*
       * ★ 答完即收工 —— 这里是本轮提速的关键。
       *
       * 实测 codex 报出 turn.completed 之后，进程还要再挂 ~10 秒才自己退出，那 10 秒
       * 全白等（整轮 21s → 预期 2-3s）。判定条件见 isTurnEndLine；"怎么收工"在
       * exec.js 的 stopTree，"收工后的退出码不算失败"在 resolveOutcome。
       */
      stopWhen: isTurnEndLine,
    })

    const parsed = parseCodexJsonl(r.stdout)
    const result = {
      status: 'failed',
      text: '',
      // null = 「未采集」。**不要写成 []** —— 那会把"没有数据"伪装成"没有改动"，
      // 理由见文件头"刻意不做的事"。
      changedFiles: null,
      cost: {},
      raw: {
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        // 是不是我们主动收的工（排障时用来区分"成员自己结束"与"我们切掉的"）
        stoppedEarly: r.stoppedEarly,
        stdout: r.stdout,
        stderr: cleanStderr(r.stderr),
      },
    }

    const outcome = resolveOutcome(parsed, {
      exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
      stoppedEarly: r.stoppedEarly,
    })
    result.status = outcome.status

    if (outcome.status === 'timeout') {
      result.text = outcome.errorLine
      return result
    }

    result.text = codexResultText(parsed)
    if (outcome.errorKind) result.errorKind = outcome.errorKind
    if (outcome.errorLine) {
      result.text = result.text ? result.text + '\n\n[错误] ' + outcome.errorLine : outcome.errorLine
    }

    // 一条正文都没解析出来时的兜底：如果不是 JSONL（比如某个版本改了输出格式），
    // 那 stdout 本身就是唯一的产出，原样交出去比交一片空白强。
    if (!result.text && !parsed.threadId) {
      const raw = (r.stdout || '').trim()
      if (raw) result.text = raw
    }

    // stoppedEarly 时那个退出码是我们自己造成的，stderr 里多半是 taskkill 的噪音，别塞进交付
    if (r.exitCode !== 0 && !r.stoppedEarly) {
      const err = elide(cleanStderr(r.stderr), 500)
      if (err && !result.text.includes(err)) {
        result.text = (result.text ? result.text + '\n\n' : '') + '[stderr] ' + err
      }
    }

    /*
     * 成本：codex 只报 token，**不报美元**。
     * 原样上报 token，不去估美元 —— 估出来的数会顺着预算闸门影响"这一单还能不能跑"，
     * 拿一个编出来的价格去关闸，比不关闸更糟。同一条规矩见 doubao / qoder 的适配器。
     */
    if (parsed.usage) {
      if (typeof parsed.usage.input_tokens === 'number') result.cost.inputTokens = parsed.usage.input_tokens
      if (typeof parsed.usage.output_tokens === 'number') result.cost.outputTokens = parsed.usage.output_tokens
    }

    return result
  }
}