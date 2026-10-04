/**
 * 文件改动采集 —— 让「声称改了、但磁盘上没变」这条规则真正能落地
 *
 * ## 为什么需要它
 *
 * `quality.js` 里有一条规则 `claimed-edit-no-change`：写权限档下，
 * 产出声称"已修复/已写入"，而采集到的文件改动为空 → 判定可疑。
 *
 * 但那条规则写完之后**一直不会触发** —— 因为 `changedFiles` 这个字段
 * 声明在适配器接口里、一路传到报告，**从来没有任何实现填过它**（三处硬编码 `[]`）。
 * 规则写得再对，没有数据就是死的。这个模块就是去把数据采出来。
 *
 * ## 采集方式：跑前跑后各拍一次快照，然后比对
 *
 * 逐文件记 `mtime : ctime : size`，两次快照一 diff 就得到 added / modified / removed。
 * 不读文件内容 —— 在几万文件的项目上做全量哈希是不可接受的，而 mtime+size
 * 对"agent 刚写了文件"这个场景足够灵敏（新文件一定命中 added，改动一般会变 mtime 和 size）。
 *
 * ## ★ 两条铁律：宁漏勿误
 *
 * 这个模块的产物会**直接用来给成员定罪**，所以宁可说"不知道"，也不给一个错答案：
 *
 * 1. **采不全就返回 `null`（未采集），绝不返回 `[]`。**
 *    超时、超文件数上限、目录读不到 —— 一律 `null`。
 *    返回 `[]` 等于宣称"我完整看过磁盘了，一个文件都没变"，而事实是"我没看完"。
 *    这两种情况在判定层的含义**正好相反**：`null` 不判，`[]` 会判。
 *
 * 2. **快照必须有上界。** 本仓库 `tools/` 一个目录就有 8498 个文件（Python venv + cursor agent），
 *    真实项目里 `node_modules` 动辄十万。没有上界 = 每次子任务都要卡住几十秒。
 *
 * ## ★ 一个已知边界：同尺寸覆盖写，可能采不到
 *
 * 签名是 `mtime : ctime : size`，**不看内容**。所以成员把文件改成**同样字节数**、
 * 而系统又把这次写入的时间戳**合并**掉时，前后签名一模一样，这次改动就采不到。
 *
 * 这不是理论风险：实测（Windows 11 / NTFS）连着两次 writeFileSync 同一个文件，
 * 30 次里 **18 次 mtime 与 ctime 一个都没动** —— 系统会把同一个时间片里的多次写入
 * 合并成一个时间戳。
 *
 * 方向要说清：采不到 → 这个文件不在 `changedFiles` 里。写权限档下产出要是还声称
 * "已改完"，`claimed-edit-no-change` 就会判可疑 —— **真改了的人被误判**。
 *
 * 真实跑批碰不到它：前后快照隔着整个子任务（20~60s），跨了无数个时间片。
 * 它只在"同一时间片内连着写同一个文件"这种微场景里出现。要根治得上内容指纹
 * （全量哈希），代价不可接受（见上面第 2 条），所以这里如实把边界记下来。
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** 这些目录名不该算作"产出改动"（依赖、缓存、构建产物、版本库内部） */
const IGNORE_DIR_NAMES = new Set([
  'node_modules', '.git', '.hg', '.svn',
  '.agenthub', '.workbuddy', '.cache',
  'dist', 'build', 'out', 'coverage',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox',
  '.next', '.nuxt', '.turbo', '.parcel-cache',
  'target', 'vendor', 'Pods', 'DerivedData',
])

/**
 * 目录名里出现这些词也跳过。
 * 用模式而不是精确名，是因为虚拟环境目录名千奇百怪：
 * `venv` / `.venv` / `trae-venv312` / `tools/*-venv*` 都得挡住。
 */
const IGNORE_DIR_PATTERNS = [/venv/i, /site-packages/i, /\.egg-info$/i, /-env\d*$/i]

/** 这些后缀是临时/生成物，不算改动 */
const IGNORE_FILE_SUFFIX = ['.pyc', '.pyo', '.log', '.swp', '.swo', '.tmp', '.DS_Store']

const DEFAULTS = {
  maxFiles: 20000,   // 超过就判定"采不全"
  maxMs: 3000,       // 时间预算
  maxDepth: 20,
}

const isIgnoredDir = (name) =>
  IGNORE_DIR_NAMES.has(name) || IGNORE_DIR_PATTERNS.some((re) => re.test(name))

const isIgnoredFile = (name) => IGNORE_FILE_SUFFIX.some((s) => name.endsWith(s))

/**
 * 给一棵目录树拍快照。
 *
 * @param {string} root
 * @param {{maxFiles?:number, maxMs?:number, maxDepth?:number}} [opts]
 * @returns {{files:Map<string,string>, truncated:boolean, reason:string}}
 *          `truncated: true` 表示**这次快照不完整**，调用方必须当成"未采集"处理。
 */
export function snapshotTree(root, opts = {}) {
  const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles
  const maxMs = opts.maxMs ?? DEFAULTS.maxMs
  const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth

  const files = new Map()
  const state = { truncated: false, reason: '' }
  const deadline = Date.now() + maxMs

  const markTruncated = (reason) => {
    if (!state.truncated) {
      state.truncated = true
      state.reason = reason
    }
  }

  const walk = (dir, depth) => {
    if (state.truncated) return
    if (Date.now() > deadline) return markTruncated(`超出时间预算 ${maxMs}ms`)

    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      /*
       * 根目录读不到 = 我们**根本没看**这个工作目录，绝不能说"没有改动"。
       * 子目录读不到则只是这一个子树的缺失，同样会让整次快照不可信 —— 统一视为采不全。
       */
      return markTruncated(depth === 0 ? `工作目录不可读：${e.code || e.message}` : `子目录不可读：${e.code || e.message}`)
    }

    for (const it of items) {
      if (state.truncated) return
      const name = it.name
      const full = join(dir, name)

      if (it.isDirectory()) {
        if (isIgnoredDir(name)) continue
        if (depth >= maxDepth) continue
        walk(full, depth + 1)
      } else if (it.isFile()) {
        if (isIgnoredFile(name)) continue
        if (files.size >= maxFiles) return markTruncated(`文件数超过上限 ${maxFiles}`)
        try {
          const st = statSync(full)
          /*
           * mtime 看内容改动，ctime 看元数据/内容变动，size 兜住"同毫秒覆盖写"。
           *
           * 时间戳**不取整**：系统真给了新时间戳时，差值也常常不到 1ms（实测见过 0.5ms），
           * 取整会把这最后一点差值抹平。但"系统压根没更新时间戳"那种情况救不了 ——
           * 见文件头的 §已知边界。
           */
          files.set(rel(root, full), `${st.mtimeMs}:${st.ctimeMs}:${st.size}`)
        } catch {
          // 单个文件 stat 失败（被删/被占用）：跳过它，不因此把整次快照作废
        }
      }
    }
  }

  walk(root, 0)
  return { files, truncated: state.truncated, reason: state.reason }
}

/** 路径统一成正斜杠，避免 Windows 的 `\` 让同一个文件在两个平台被当成两个 */
const rel = (root, full) => relative(root, full).split(sep).join('/')

/**
 * 比对两次快照，返回改动过的文件路径（新增、内容变化、删除都算）。
 * @returns {string[]} 已排序
 */
export function diffSnapshots(before, after) {
  const changed = []
  for (const [p, sig] of after.files) {
    if (before.files.get(p) !== sig) changed.push(p)
  }
  for (const p of before.files.keys()) {
    if (!after.files.has(p)) changed.push(p)
  }
  return changed.sort()
}

/**
 * 采集两个快照之间的改动。
 *
 * @returns {string[]|null} `null` = **未采集 / 采不全**，判定层必须据此不判；
 *                          `[]` = 完整采集且确实零改动。
 */
export function collectChanges(before, after) {
  if (!before || !after) return null
  if (before.truncated || after.truncated) return null
  return diffSnapshots(before, after)
}

/** 判定层要用它来决定"哪些权限档才值得采" —— 与 quality.js 共用同一份定义 */
export { DEFAULTS as SNAPSHOT_DEFAULTS }
