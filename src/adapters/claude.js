/**
 * Claude 适配器
 *
 * 实测环境：Windows 11 / claude.cmd 2.1.278
 * 实测结论：
 *  - prompt 走 stdin 最快（3.0s vs 7.1s），且规避转义问题
 *  - --output-format json 能拿到 total_cost_usd / usage / session_id
 *  - --permission-mode 的取值正好对应我们的三档权限
 */
import { BaseAdapter, rolePrompt, describePermission } from './base.js'
import { execMember, cleanStderr, elide } from './exec.js'

/**
 * 判断 claude 的 JSON 输出是否代表「出错了」。
 *
 * 抽成独立纯函数是为了能**直接测** —— 这段判定最容易写错（漏一种 payload 形态就等于
 * 整层保护失效），而 mock 子进程代价太高，结果往往是干脆不测。
 *
 * 实测样本：
 *   {"type":"result","subtype":"error_max_turns","is_error":true,"result":"已达到最大轮次"}
 *   {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
 */
export function isErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  return payload.is_error === true
    || payload.type === 'error'
    || /^error/i.test(String(payload.subtype || ''))
}

export class ClaudeAdapter extends BaseAdapter {
  async probe() {
    const r = await execMember(this.spec.command, ['--version'], { timeoutMs: 30000 })
    const out = (r.stdout || '').trim() || cleanStderr(r.stderr)
    if (r.exitCode === 0 && out) {
      return { available: true, version: out.split('\n')[0].trim(), raw: out }
    }
    return {
      available: false,
      reason: r.spawnFailed ? '命令无法启动（路径或权限问题）' : `退出码 ${r.exitCode}`,
      raw: elide(out, 400),
    }
  }

  /**
   * 把权限档位翻译成本成员认识的参数。
   *
   * 翻译逻辑**不在这里** —— 与 generic 适配器共用 `describePermission()`。
   * 从前这段是两处各写一份（claude.js 一处、generic.js 一处），
   * 于是"档位没配时会静默回落到默认档"这个行为也就有了两份实现，谁都不知道对方怎么想。
   */
  permissionArgs(level) {
    return describePermission(this.spec, level).args
  }

  /** 权限档位 → 环境变量（与 generic 适配器同一份规则，见 base.js） */
  permissionEnv(level) {
    return describePermission(this.spec, level).env
  }

  buildArgs(opts = {}) {
    const level = opts.permission || this.spec.defaultPermission || 'plan'
    const args = [
      '-p',
      '--output-format', 'json',
      ...(this.spec.baseArgs || []),      // 例如 --bare：砍掉约 90% 的固定开销
      ...this.permissionArgs(level),
    ]

    if (opts.model) args.push('--model', opts.model)
    if (opts.workdir) args.push('--add-dir', opts.workdir)
    if (opts.maxBudgetUsd) args.push('--max-budget-usd', String(opts.maxBudgetUsd))
    if (opts.role) args.push('--append-system-prompt', rolePrompt(opts.role))

    return args
  }

  async run(opts = {}) {
    const args = this.buildArgs(opts)
    const r = await execMember(this.spec.command, args, {
      input: opts.prompt,
      workdir: opts.workdir,
      timeoutMs: opts.timeoutMs ?? this.spec.timeoutMs ?? 600000,
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

    // 先尝试按 json 解析（claude --output-format json 的约定）
    let payload = null
    const raw = (r.stdout || '').trim()
    if (raw) {
      try { payload = JSON.parse(raw) } catch { /* 不是 json，走纯文本分支 */ }
    }

    if (payload) {
      result.text = typeof payload.result === 'string'
        ? payload.result
        : (payload.result ?? payload.text ?? raw)

      /*
       * ★ is_error 优先于退出码。
       *
       * `claude --output-format json` 在「达到最大轮次」「API 错误」等情况下
       * **仍可能以退出码 0 结束**，真实信号在 payload 里：
       *   {"type":"result","subtype":"error_max_turns","is_error":true,"result":"已达到最大轮次"}
       *   {"type":"error","error":{"type":"api_error","message":"Internal server error"}}
       *
       * 只看 exitCode 会把它记成 status:'ok'；接着 quality 因为 status==='ok' 继续判定，
       * 而「已达到最大轮次」不含任何现有词 → 最终判 ok。**一层保护就这么整条漏掉了。**
       */
      const isErr = isErrorPayload(payload)
      if (isErr) {
        result.status = 'failed'
        result.errorKind = payload.subtype || payload.error?.type || 'is_error'
        const msg = payload.error?.message
        if (!result.text && msg) result.text = String(msg)
        if (result.text && !result.text.startsWith('[is_error')) {
          result.text = `[is_error: ${result.errorKind}] ${result.text}`
        }
      } else {
        result.status = r.exitCode === 0 ? 'ok' : 'failed'
      }

      /*
       * 被权限拦下的命令清单 —— 交给产出有效性判定用。
       * 这是「写了但没验证」唯一可靠的硬证据：文本会撒谎，被拦的命令列表不会。
       */
      if (Array.isArray(payload.permission_denials)) {
        result.permissionDenials = payload.permission_denials
      }

      if (payload.total_cost_usd != null) result.cost.usd = payload.total_cost_usd
      if (payload.usage) {
        result.cost.inputTokens = payload.usage.input_tokens
        result.cost.outputTokens = payload.usage.output_tokens
      }
      if (payload.session_id) result.sessionId = payload.session_id
    } else {
      result.text = raw
      result.status = r.exitCode === 0 ? 'ok' : 'failed'
    }

    // 退出码非 0 但拿到了内容，也要把错误信息带上
    if (r.exitCode !== 0) {
      const err = elide(cleanStderr(r.stderr), 500)
      if (err && !result.text.includes(err)) {
        result.text = (result.text ? result.text + '\n\n' : '') + `[stderr] ${err}`
      }
    }

    return result
  }
}
