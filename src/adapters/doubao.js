/**
 * 豆包适配器 —— 直连火山方舟（Volcengine Ark）REST API
 *
 * ## 为什么不用 CLI
 *
 * 豆包**没有官方命令行工具**。2026-09-29 实测推翻了原假设：
 * npm 包 `@volcengine/arkclaw` 的 package.json 里 `bin` 字段为空，
 * description 写的是 "swagger client for @volcengine/arkclaw" ——
 * 它是给开发者调用的 SDK 库，装完敲不出任何命令。
 * 所以唯一可编程入口就是火山方舟的 OpenAI 兼容端点。
 *
 * ## 实测依据
 *
 * ```
 * POST https://ark.cn-beijing.volces.com/api/v3/chat/completions
 * Authorization: Bearer $ARK_API_KEY
 * {"model":"doubao-seed-...","messages":[{"role":"user","content":"Hello"}]}
 * ```
 * 响应是标准 OpenAI 结构：`choices[0].message.content` +
 * `usage.{prompt_tokens,completion_tokens,total_tokens}`。
 * 另有方舟私有的 `thinking:{type:'disabled'|'enabled'}` 开关深度思考。
 *
 * ## 两个刻意的设计
 *
 * 1. **不估美元成本。** 豆包按人民币计价，塞进 `cost.usd` 字段会误导。
 *    只回报 token 数（`cost.inputTokens` / `cost.outputTokens`），成本交给上层按当期价目表算。
 * 2. **`thinking` 默认不下发。** 只有 members.json 显式配了 `thinking` 才带这个字段 ——
 *    它是方舟私有字段，老的 doubao-pro 系模型不认，发了会 400。
 */
import process from 'node:process'
import { BaseAdapter, rolePrompt } from './base.js'
import { elide } from './exec.js'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_MODEL = 'doubao-seed-1-6-251015'

/** 把 HTTP 错误翻译成人能看懂的一句话 */
function describeHttpError(status, json) {
  const detail =
    json?.error?.message ||
    json?.message ||
    (typeof json?.error === 'string' ? json.error : '') ||
    ''
  const tail = detail ? ` · ${detail.slice(0, 200)}` : ''

  if (status === 401) return `ARK_API_KEY 无效或已过期（401）${tail}`
  if (status === 403) return `无权限，模型可能未在方舟控制台开通（403）${tail}`
  if (status === 404) {
    // 404 有两种完全不同的成因，方舟其实分开说了，必须分开翻译 —— 2026-09-29 实测：
    //   模型存在但账号没开通 → "Your account xxx has not activated the model yyy"
    //   模型名压根不存在     → "The model or endpoint yyy does not exist"
    // 混成一句"不存在或未开通"，会让人在「换个 ID 试试」和「去控制台开通」之间瞎试。
    if (/has not activated/i.test(detail)) {
      return `模型未开通（404）：方舟认得这个 Model ID，是你的账号还没开通它 —— 去控制台「开通管理」点开通即可。${tail}`
    }
    return `Model ID 不对（404）：方舟不认得这个名字 —— 去控制台「开通管理」或模型广场核对准确的 Model ID。${tail}`
  }
  if (status === 429) return `触发限流或账户余额不足（429）${tail}`
  if (status >= 500) return `方舟服务端错误（${status}）${tail}`
  return `HTTP ${status}${tail}`
}

export class DoubaoAdapter extends BaseAdapter {
  get baseUrl() {
    const url =
      this.spec.baseUrl ||
      process.env.ARK_BASE_URL ||
      process.env.DOUBAO_BASE_URL ||
      DEFAULT_BASE_URL
    return String(url).replace(/\/+$/, '')
  }

  /** key 的查找顺序：成员配置 > 方舟惯例名 > Trae 用的别名 */
  get apiKey() {
    const env = this.spec.env || {}
    return (
      env.ARK_API_KEY ||
      env.DOUBAO_API_KEY ||
      process.env.ARK_API_KEY ||
      process.env.DOUBAO_API_KEY ||
      ''
    )
  }

  get model() {
    return this.spec.model || process.env.ARK_MODEL || DEFAULT_MODEL
  }

  /**
   * 一次 chat 调用。不抛异常（除非网络层炸了），一律返回结构化结果，
   * 让 probe 和 run 各自决定怎么解读。
   */
  async chat(messages, { model, maxTokens, temperature, timeoutMs = 30000 } = {}) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)

    const body = {
      model: model || this.model,
      messages,
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
      ...(this.spec.thinking ? { thinking: { type: this.spec.thinking } } : {}),
    }

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })

      const raw = await res.text()
      let json = null
      try { json = JSON.parse(raw) } catch { /* 非 json 响应，保留原文 */ }

      if (res.ok) return { ok: true, status: res.status, json, raw }
      return {
        ok: false,
        status: res.status,
        json,
        raw,
        reason: describeHttpError(res.status, json),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async probe() {
    if (!this.apiKey) {
      return {
        available: false,
        reason:
          '未设置 ARK_API_KEY。到 https://console.volcengine.com/ark 创建 API Key，' +
          '设进环境变量，或写进 members.json 的 doubao.env.ARK_API_KEY',
      }
    }

    try {
      // 真发一次极短请求：这是唯一能同时验证「key 有效 + 模型已开通 + 端点可达」的办法。
      // 相比只 ping 端点，它还能挡住"key 对但模型没开通"这种最隐蔽的情况。
      const r = await this.chat([{ role: 'user', content: 'ping' }], { maxTokens: 1 })
      if (r.ok) return { available: true, version: `REST · ${this.model}`, raw: elide(r.raw, 400) }
      return { available: false, reason: r.reason, raw: elide(r.raw, 400) }
    } catch (e) {
      const reason =
        e.name === 'AbortError'
          ? '探活超时（30s），端点不可达'
          : `网络不可达：${e.message}`
      return { available: false, reason }
    }
  }

  async run(opts = {}) {
    const t0 = Date.now()
    const endpoint = `${this.baseUrl}/chat/completions`

    const result = {
      status: 'failed',
      text: '',
      // null = 「未采集文件改动」；**不要写成 `[]`** —— 那会把"没数据"伪装成"没有改动"。
      // 判定层靠这个区分来避免一条恒定误报的规则，详见 quality.js。
      changedFiles: null,
      cost: {},
      raw: { command: `POST ${endpoint}`, exitCode: null, durationMs: 0, stdout: '', stderr: '' },
    }

    if (!this.apiKey) {
      result.raw.durationMs = Date.now() - t0
      result.text = '未设置 ARK_API_KEY，无法调用方舟 API（见 members.json 的 doubao.authHint）'
      return result
    }

    const messages = []
    const sys = rolePrompt(opts.role)
    if (sys) messages.push({ role: 'system', content: sys })
    messages.push({ role: 'user', content: opts.prompt ?? '' })

    let r
    try {
      r = await this.chat(messages, {
        model: opts.model,
        maxTokens: opts.maxTokens ?? this.spec.maxTokens ?? 4096,
        temperature: this.spec.temperature,
        timeoutMs: opts.timeoutMs ?? this.spec.timeoutMs ?? 120000,
      })
    } catch (e) {
      const ms = Date.now() - t0
      result.raw.durationMs = ms
      if (e.name === 'AbortError') {
        result.status = 'timeout'
        result.text = `超时（${Math.round(ms / 1000)}s）后被终止`
      } else {
        result.text = `请求失败：${e.message}`
        result.raw.stderr = String(e.message)
      }
      return result
    }

    result.raw.durationMs = Date.now() - t0
    result.raw.stdout = r.raw
    // REST 没有退出码，用 HTTP 状态码顶上 —— 报告里「退出码：200」一眼能看出走通了
    result.raw.exitCode = r.status

    if (r.ok) {
      const msg = r.json?.choices?.[0]?.message
      result.text =
        typeof msg?.content === 'string'
          ? msg.content
          : msg?.content != null
            ? JSON.stringify(msg.content)
            : r.raw

      const u = r.json?.usage
      if (u) {
        result.cost.inputTokens = u.prompt_tokens
        result.cost.outputTokens = u.completion_tokens
      }
      result.status = 'ok'
      return result
    }

    result.text = r.reason
    result.raw.stderr = r.reason
    return result
  }
}
