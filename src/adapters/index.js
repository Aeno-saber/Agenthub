/**
 * 成员注册表 —— 读 members.json，造出适配器实例
 * 引擎只跟这里打交道，不直接碰具体适配器。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import process from 'node:process'

import { ClaudeAdapter } from './claude.js'
import { GenericAdapter } from './generic.js'
import { DoubaoAdapter } from './doubao.js'
import { CodexAdapter } from './codex.js'

// 成员适配器表 —— 每加一个成员适配器，这里多一行
const ADAPTER_MAP = {
  claude: ClaudeAdapter,
  generic: GenericAdapter,
  doubao: DoubaoAdapter,
  codex: CodexAdapter,
}

const __dirname = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_CONFIG_PATH = join(__dirname, '..', 'config', 'members.json')

/**
 * 探活前的环境前置检查 —— 零成本，但能挡住最难查的一类失败。
 *
 * **实测教训（2026-09-29 真跑协同任务）**：trae 的探活走的是 `trae-cli --version`，
 * 这条命令**根本不碰 API Key**，所以永远返回成功 —— 界面上是绿的、规划者也会放心把活派给它。
 * 直到真执行时才炸，而且炸出来是一段 Python 堆栈：
 *   `openai.OpenAIError: Missing credentials. Please pass an api_key ...`
 * 一个「这成员到底能不能干活」的问题，被推到执行阶段才暴露，还伪装成"装坏了"。
 *
 * 对策：成员配置里可以声明 `requiredEnv`，探活前先看这些变量在不在。
 * 缺了就**直接判不可用**并说清缺哪个 —— 比真跑一次更省、更快、更准。
 *
 * ⚠️ 边界：这只挡"没配"，挡不住"配错了"（key 拼错、模型没开通、额度用尽）。
 * 所以能用真实调用的成员（如豆包 REST）仍然要真去调一次，两者是互补而非替代。
 */
export function precheckEnv(spec, env = process.env) {
  const need = spec?.requiredEnv || []
  if (!need.length) return null
  const own = spec.env || {}
  const missing = need.filter((k) => !own[k] && !env[k])
  if (!missing.length) return null
  return {
    available: false,
    reason: `缺少环境变量 ${missing.join('、')}（配置里声明了 requiredEnv，探活前先查）`,
    raw: '',
  }
}

export class MemberRegistry {
  constructor(config) {
    this.config = config
    this.adapters = new Map()
    this._probeCache = new Map()

    for (const spec of config.members || []) {
      const Cls = ADAPTER_MAP[spec.adapter] || GenericAdapter
      this.adapters.set(spec.id, new Cls(spec))
    }
  }

  get orchestrator() {
    return this.config.orchestrator || null
  }

  list() {
    return [...this.adapters.values()]
  }

  get(id) {
    return this.adapters.get(id) || null
  }

  /** 按能力标签筛人（引擎分派依据） */
  capable(tag) {
    return this.list().filter((a) => a.isEnabled && (!tag || a.capabilities.includes(tag)))
  }

  /** 单个成员探活：禁用 → 环境前置检查 → 真实探测 */
  async _probeMember(a) {
    if (!a.isEnabled) return { available: false, reason: '配置中已禁用' }
    const blocked = precheckEnv(a.spec)
    if (blocked) return blocked
    return await a.probe()
  }

  /**
   * 批量探测可用性并缓存。可用性永远来自实测，不来自配置文件。
   */
  async probeAll({ force = false } = {}) {
    const out = {}
    await Promise.all(
      this.list().map(async (a) => {
        if (!force && this._probeCache.has(a.id)) {
          out[a.id] = this._probeCache.get(a.id)
          return
        }
        const r = await this._probeMember(a)
        this._probeCache.set(a.id, r)
        out[a.id] = r
      })
    )
    return out
  }

  /**
   * 探测单个成员并写回缓存。界面上的「测试」按钮走这里 ——
   * 只为一行结果去把全部成员重探一遍是浪费（REST 成员会真发请求、会产生费用）。
   */
  async probeOne(id) {
    const a = this.get(id)
    if (!a) return null
    const r = await this._probeMember(a)
    this._probeCache.set(a.id, r)
    return r
  }

  /** 只返回实测可用的成员 */
  async available() {
    const probed = await this.probeAll()
    return this.list().filter((a) => probed[a.id]?.available)
  }
}

export function loadRegistry(configPath = DEFAULT_CONFIG_PATH) {
  const raw = readFileSync(configPath, 'utf8')
  return new MemberRegistry(JSON.parse(raw))
}
