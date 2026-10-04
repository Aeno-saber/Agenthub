/**
 * 通用适配器 —— 配置驱动，不写代码就能接新成员
 *
 * 适合"命令 + 参数模板 + 权限参数"这类标准 CLI（Cursor / Qoder / Trae 都是）。
 * 特殊交互的成员（如豆包的 REST API）再单独写专用适配器。
 *
 * ## promptMode 三种取值
 *
 * | 值 | 指令怎么进 CLI | argsTemplate 里放什么 | 什么时候用 |
 * |---|---|---|---|
 * | `stdin`（默认） | 写进标准输入 | 什么都别放 | 首选：最快，且不受转义与换行影响 |
 * | `arg` | 当命令行参数 | `{prompt}` | 只在 CLI 明确不吃 stdin 时用 |
 * | `file` | 先落成临时文件 | `{promptFile}` | CLI 只认文件（如 Trae 的 `--file`），或参数位被占用时 |
 *
 * ⚠️ **多行指令绝不能走 `arg`。** 实测（2026-09-29）：双引号内的换行会被
 * cmd.exe 就地截断，成员只收到第一行，**而退出码仍然是 0** —— 静默产出垃圾。
 * 详见 skill `windows-agent-cli-headless` 的「三层冒烟」。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BaseAdapter, rolePrompt, describePermission } from './base.js'
import { execMember, cleanStderr, elide } from './exec.js'

/** 从 JSON 输出里按点分路径取值 */
export function extractByPath(obj, path) {
  if (!path) return undefined
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj)
}

/**
 * 取出「真的测到了」的数值 —— **0 一律当成"没上报"，而不是"是 0"**。
 *
 * 实测依据（2026-09-29，qoder CLI 一次真实调用 `-p -o json`）：
 *
 * ```json
 * {"type":"result","result":"ok",
 *  "total_cost_usd": 0,            ← 恒为 0（硬编码）
 *  "total_credits": 0.157647882,   ← 真实消耗在这里
 *  "usage":{"input_tokens":0,"output_tokens":0},   ← token 也全是 0
 *  "modelUsage":{"auto":{"credits":0.157647882}}}
 * ```
 *
 * qoder 按**积分**计费，所以 `total_cost_usd` 天然是 0；token 也没回填。
 * 把这些 0 当测量值会得出两个错误结论：「这次免费」「没消耗 token」——
 * 而事实是它跑了 2 秒、消耗了 0.1576 积分。
 *
 * 这不是"保守估计"，是**口径不适用**。豆包适配器早就是这么处理的
 * （它的注释写着"按人民币计价，塞进 usd 会误导"），这里只是把同一条规矩统一。
 */
export function positiveNumber(v) {
  return typeof v === 'number' && v > 0 ? v : undefined
}

/**
 * 把 CLI 的 JSON payload 映射成结果字段。
 *
 * 抽成**导出纯函数**是为了能直接拿真实样本测 —— 否则要验一段成本解析逻辑，
 * 就得 spawn 一个子进程、真的花一次钱。`tests/fixtures/qoder-result.json`
 * 就是那次真实调用的原始输出，直接喂进来即可。
 *
 * @param {object|null} payload            CLI 的 JSON 输出（null 表示不是 JSON 模式/没解析出来）
 * @param {object} spec                    成员配置（textPath / costPath / creditsPath）
 * @param {string} [fallbackText]          没有 payload 时用的纯文本
 * @returns {{text:string, cost:object, permissionDenials:Array|null, errorKind:string|null}}
 */
export function parsePayload(payload, spec = {}, fallbackText = '') {
  const out = { text: fallbackText, cost: {}, permissionDenials: null, errorKind: null }
  if (!payload || typeof payload !== 'object') return out

  const extracted = extractByPath(payload, spec.textPath)
  out.text = typeof extracted === 'string'
    ? extracted
    : (extracted != null ? JSON.stringify(extracted) : fallbackText)

  /*
   * 成本：只记"真的测到了"的数。`usd` 与 `credits` 是**两种并列的计价口径**，
   * 谁有就记谁 —— 报告层据此区分「这次免费」和「这个成员不走美元计价」。
   */
  const usd = positiveNumber(extractByPath(payload, spec.costPath))
  if (usd !== undefined) out.cost.usd = usd
  const credits = positiveNumber(extractByPath(payload, spec.creditsPath))
  if (credits !== undefined) out.cost.credits = credits

  // token 同理：0 表示 CLI 没回填，不表示没消耗
  const usage = payload.usage || {}
  const inTok = positiveNumber(usage.input_tokens)
  const outTok = positiveNumber(usage.output_tokens)
  if (inTok !== undefined) out.cost.inputTokens = inTok
  if (outTok !== undefined) out.cost.outputTokens = outTok

  // 被权限拦下的命令 —— "写了但没验证"的硬证据（和 claude 适配器同一套约定）
  if (Array.isArray(payload.permission_denials)) out.permissionDenials = payload.permission_denials
  // is_error 优先于退出码：CLI 可能以 0 退出却把错误写在 payload 里
  if (payload.is_error === true || payload.type === 'error') {
    out.errorKind = payload.subtype || payload.error?.type || 'is_error'
  }
  return out
}

export class GenericAdapter extends BaseAdapter {
  async probe() {
    const args = this.spec.probeArgs || ['--version']
    const r = await execMember(this.spec.command, args, { timeoutMs: 30000 })
    const out = ((r.stdout || '').trim() || cleanStderr(r.stderr)).trim()
    const firstLine = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || ''

    if (r.exitCode === 0 && firstLine) {
      return { available: true, version: firstLine, raw: out }
    }
    return {
      available: false,
      reason: r.spawnFailed
        ? (this.spec.installHint ? `未安装 · ${this.spec.installHint}` : '命令无法启动')
        : `退出码 ${r.exitCode}`,
      raw: elide(out, 400),
    }
  }

  /** 权限档位 → CLI 参数。翻译规则与 claude 适配器共用一份，见 base.js 的 describePermission */
  permissionArgs(level) {
    return describePermission(this.spec, level).args
  }

  /**
   * 权限档位 → 环境变量。
   *
   * 有些 CLI **完全没有权限开关**，权限是走环境变量控的（dsh 就是：
   * `--profile headless --help` 只有 `-h`，但 `DSH_PERMISSION_MODE` 一改，
   * 沙箱模式和审批策略跟着变）。只查参数就断定"这成员无法表达档位"是**看错了地方**。
   */
  permissionEnv(level) {
    return describePermission(this.spec, level).env
  }

  buildArgs(opts = {}) {
    const promptMode = this.spec.promptMode || 'stdin'
    const tpl = this.spec.argsTemplate || ['-p']
    const args = []

    for (const token of tpl) {
      if (token === '{prompt}') {
        if (promptMode === 'arg') args.push(opts.prompt)
      } else if (token === '{promptFile}') {
        // promptMode: 'file' —— 指令已落成临时文件，命令行只传路径。
        // 见文件头说明：多行 prompt 走命令行在 Windows 上必被截断。
        if (opts.promptFilePath) args.push(opts.promptFilePath)
      } else {
        args.push(token)
      }
    }

    args.push(...this.permissionArgs(opts.permission || this.spec.defaultPermission || 'plan'))

    if (opts.model && this.spec.modelFlag) args.push(this.spec.modelFlag, opts.model)
    if (opts.workdir && this.spec.workdirFlag) args.push(this.spec.workdirFlag, opts.workdir)
    if (opts.role && this.spec.systemPromptFlag) {
      args.push(this.spec.systemPromptFlag, rolePrompt(opts.role))
    }

    return args
  }


  async run(opts = {}) {
    const promptMode = this.spec.promptMode || 'stdin'
    const tpl = this.spec.argsTemplate || []

    // promptMode: 'file'（或模板里出现 {promptFile}）—— 先把指令落成临时文件，
    // 命令行只传路径。这是绕过"多行 prompt 被 cmd.exe 就地截断"的唯一可靠办法。
    let tmpDir = null
    let promptFilePath = null
    if (promptMode === 'file' || tpl.includes('{promptFile}')) {
      tmpDir = mkdtempSync(join(tmpdir(), 'agenthub-task-'))
      promptFilePath = join(tmpDir, 'task.txt')
      writeFileSync(promptFilePath, opts.prompt ?? '', 'utf8')
    }

    try {
      const args = this.buildArgs({ ...opts, promptFilePath })

      const r = await execMember(this.spec.command, args, {
        input: promptMode === 'stdin' ? opts.prompt : undefined,
        workdir: opts.workdir,
        timeoutMs: opts.timeoutMs ?? this.spec.timeoutMs ?? 600000,
        // 成员自带的环境变量 + 这一档位专属的环境变量（后者优先）。
        // 两处合并不是可有可无的：dsh 的整个权限档位就靠这里。
        env: {
          ...(this.spec.env || {}),
          ...this.permissionEnv(opts.permission || this.spec.defaultPermission || 'plan'),
        },
      })

      const result = {
        status: 'failed',
        text: '',
        // null = 「未采集文件改动」；**不要写成 `[]`** —— 那会把"没数据"伪装成"没有改动"。
        // 判定层靠这个区分来避免一条恒定误报的规则，详见 quality.js。
        changedFiles: null,
        cost: {},
        raw: {
          command: r.command,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          stdout: r.stdout,
          stderr: cleanStderr(r.stderr),
        },
      }

      if (r.timedOut) {
        result.status = 'timeout'
        result.text = `超时（${Math.round(r.durationMs / 1000)}s）后被终止`
        return result
      }

      const rawOut = (r.stdout || '').trim()
      let payload = null
      if (this.spec.outputFormat === 'json' && rawOut) {
        try { payload = JSON.parse(rawOut) } catch { /* 落到纯文本 */ }
      }

      // 映射逻辑全在 parsePayload 里（纯函数，可直接喂真实样本测）
      const parsed = parsePayload(payload, this.spec, rawOut)
      result.text = parsed.text
      result.cost = parsed.cost
      if (parsed.permissionDenials) result.permissionDenials = parsed.permissionDenials
      if (parsed.errorKind) result.errorKind = parsed.errorKind

      // is_error 优先于退出码：CLI 可能以 0 退出却把错误写在 payload 里
      result.status = (r.exitCode === 0 && !parsed.errorKind) ? 'ok' : 'failed'

      if (r.exitCode !== 0) {
        const err = elide(cleanStderr(r.stderr), 500)
        if (err && !result.text.includes(err)) {
          result.text = (result.text ? result.text + '\n\n' : '') + `[stderr] ${err}`
        }
      }

      return result
    } finally {
      // 临时文件必须清掉，否则每跑一次任务就在 temp 里留一份 prompt 副本
      if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败不影响任务结果 */ }
      }
    }
  }
}
