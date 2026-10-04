/**
 * 角色目录 —— **分工这件事的唯一真相源**。
 *
 * ─────────────────────────────────────────────────────────────
 * 2026-09-30 建立。原因是同一个概念在三处各写了一遍，而且互相对不上：
 *
 *   · `ui/public/app.js` 的 `ROLES`：6 个（代码主笔/评审/文档书写/测试/调研/执行者）
 *   · `src/adapters/base.js` 的 `rolePrompt()`：5 个（**没有「执行者」**）
 *   · `src/engine/planner.js` 的提示词第 6 条：5 个（同上）
 *
 * 后果不是"不整齐"，是一个**真实的空洞**：前端下拉框的默认值就是「执行者」，
 * 而 `rolePrompt()` 里没有它 —— 用户选了执行者，落到模型头上的只有一句
 * 「你在本次任务中承担的角色是：执行者」，等于没写。同一件事写三遍，
 * 早晚有一遍会漏（这次漏的是默认值那一个）。
 *
 * 现在三处都从这一份取：`base.js` 取 `prompt`，`planner.js` 取 `label/duty/deliverable`
 * 拼给规划者看，前端通过 `/api/members` 的 `roles` 字段取全量。
 *
 * ─────────────────────────────────────────────────────────────
 * 每个角色为什么是这五个字段：
 *
 *   label       中文名。**同时也是落在计划 `role` 字段上的值** ——
 *               规划者输出的就是它，`rolePrompt()` 也按它查表，
 *               所以 label 是这三处对齐的接缝，改名即断链（`tests/roles.test.mjs` 盯着）。
 *   glyph       分工卡片左上角的一个字。纯装饰，但能让一列角色在余光里可区分。
 *   duty        职责：**做什么**。给规划者看的，也是界面上「分工模板」的正文。
 *   deliverable 交付物：**做完交出什么**。这一条是"分工再详细点"的关键 ——
 *               只写"负责测试"规划者会拆出"写点测试"这种没法验收的活；
 *               写明"能直接跑的测试文件 + 覆盖了哪些分支"才有约束力。
 *   needs       需要成员具备的能力标签（对应 members.json 的 capabilities）。
 *               界面用它做**能力匹配警告**：把「代码主笔」派给 capability 只有 doc
 *               的成员时当场提示。空数组 = 谁都能干。
 *   write       这一步会不会改文件。对应成员配置里的 `writeCapable`。
 *               与 needs 分开是因为它们会**独立**出错：豆包有 doc 能力但完全不碰文件，
 *               一个"写文档到磁盘"的角色两边都得满足。
 *   prompt      展开给模型看的系统提示词（原来在 base.js 里）。
 *
 * ★ 加角色时的自检：`tests/roles.test.mjs` 会验 label 唯一、必填字段非空、
 *   且每个 label 都能查回一段非兜底的 prompt。漏了会红，不会静默。
 */

/**
 * @typedef {object} Role
 * @property {string} label
 * @property {string} glyph
 * @property {string} duty
 * @property {string} deliverable
 * @property {string[]} needs
 * @property {boolean} write
 * @property {string} prompt
 */

/** @type {Role[]} */
export const ROLES = [
  {
    label: '代码主笔',
    glyph: '⌘',
    duty: '动手写出可运行的实现，改动完整、不留 TODO、不留半截函数',
    deliverable: '改好的文件 + 一句话说明改了哪些文件、为什么这么改',
    needs: ['code'],
    write: true,
    prompt: '你是本次任务的代码主笔。直接动手实现，改动要完整可运行，不要只给建议。完成后简要说明改了哪些文件、为什么这么改。',
  },
  {
    label: '评审',
    glyph: '⌕',
    duty: '只审查、不修改，挑出真实的缺陷与风险',
    deliverable: '按严重程度排序的问题清单，每条带文件与位置；没问题也要明说',
    needs: ['review'],
    write: false,
    prompt: '你是评审者。只审查、不修改文件。指出具体问题（文件+行号级），按严重程度排序。如果没有问题也要明说。',
  },
  {
    label: '测试',
    glyph: '✓',
    duty: '写能真正跑起来的测试，覆盖正常路径、边界值与异常分支',
    deliverable: '可直接执行的测试文件 + 怎么跑、覆盖了哪些分支',
    needs: ['code'],
    write: true,
    prompt: '你负责写测试。覆盖正常路径、边界值和异常分支，测试要能直接跑。完成后说明怎么运行、覆盖了哪些分支。',
  },
  {
    label: '文档书写',
    glyph: '¶',
    duty: '把已有材料整理成给人看的文档，不虚构没给的信息',
    deliverable: '成稿文档 + 说明放在哪个文件、面向谁',
    needs: ['doc'],
    write: true,
    prompt: '你是文档作者。基于给定的材料写文档，不要虚构未提供的信息。结构清晰，语言平实。',
  },
  {
    label: '调研',
    glyph: '◎',
    duty: '查清一个开放问题，给出结论先行的分析',
    deliverable: '结论先行的分析 + 每条结论的信息来源与不确定度',
    needs: [],
    write: false,
    prompt: '你负责调研。给出结论先行的分析，标注信息来源与不确定性。',
  },
  {
    label: '架构设计',
    glyph: '⬡',
    duty: '定模块边界、接口与数据流，把"怎么做"说清楚到能照着写',
    deliverable: '设计方案：模块划分、关键接口签名、数据流、取舍理由',
    needs: [],
    write: false,
    prompt: '你是本次任务的架构设计者。不要动代码，给出模块划分、关键接口与数据流，并说明取舍理由。方案要具体到别人能照着实现。',
  },
  {
    label: '重构清理',
    glyph: '⇄',
    duty: '在不改变外部行为的前提下改善结构，删掉死代码与重复',
    deliverable: '重构后的文件 + 明确说明外部行为**没有**变化、依据是什么',
    needs: ['code'],
    write: true,
    prompt: '你负责重构。在**不改变外部行为**的前提下改善结构，删掉死代码与重复。完成后必须说明外部行为没有变化，以及你凭什么这么判断。',
  },
  {
    label: '汇总交付',
    glyph: '⊞',
    duty: '把上游各步的产出合成一份一致的最终结果，处理互相矛盾之处',
    deliverable: '最终交付物 + 逐条说明它由哪些上游产出合成、哪里做过取舍',
    needs: [],
    write: true,
    prompt: '你负责汇总交付。把上游各步的产出合成一份一致的最终结果，明确指出互相矛盾之处以及你怎么取舍的。不要引入上游没有的新内容。',
  },
  {
    label: '执行者',
    glyph: '▶',
    duty: '按指令完成一件具体的、不需要拆分的活',
    deliverable: '被要求的那件事的完成结果',
    needs: [],
    write: true,
    prompt: '你负责执行这一步。严格按给定的指令完成，不要扩大范围，也不要只给建议。完成后简要说明你做了什么。',
  },
]

/**
 * 按 label 或 glyph 之外的稳定标识查一个角色。
 *
 * 为什么按 label 查而不是另建 id：`role` 这个字段**是要给模型看的**
 * （规划者输出的就是中文短语，见 planner.js 第 6 条），多引入一层 id 映射
 * 只会多一个能对不上的地方。label 就是它的 id。
 *
 * ★ 必须容得下**未知角色**：计划可能是从旧版本 localStorage 里恢复的，
 *   也可能是用户手改过的。查不到就返回 null，由调用方决定兜底 ——
 *   这里抛异常会让一个只是"角色名不认识了"的任务整个打不开。
 *
 * @param {string} [role]
 * @returns {Role|null}
 */
export function findRole(role) {
  if (!role) return null
  const key = String(role).trim()
  return ROLES.find((r) => r.label === key) || null
}

/** 给规划者看的角色清单（label + 职责 + 交付物 + 能力要求） */
export function roleCatalogText() {
  return ROLES.map((r) => {
    const need = r.needs.length ? r.needs.join('/') : '不限'
    return `- ${r.label}：${r.duty}。交付物：${r.deliverable}。（需要能力：${need}${r.write ? '；会改文件' : '；不改文件'}）`
  }).join('\n')
}

/** 全部 label，按目录顺序。前端下拉框、校验、测试都用它 */
export const ROLE_LABELS = ROLES.map((r) => r.label)
