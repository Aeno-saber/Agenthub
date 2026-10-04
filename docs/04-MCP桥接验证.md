# MCP 桥接验证

> 2026-09-29 · 第一期关键假设验证。结论：**端到端已打通** —— WorkBuddy 经 MCP 派活，
> 真跑到 Claude 子进程并拿回产出。协议层自测 8/8，真实调用 1/1。

---

## 一、这一步为什么非做不可

整个 AgentHub 的架构建立在一个判断上：

> **WorkBuddy 没有 CLI、没有 API（纯 GUI），所以不能「唤起它」，只能「让它来连我们」。**

于是方案是：Electron 应用对外暴露一个 MCP server，WorkBuddy 作为 MCP 客户端连上来，
它当大脑负责拆任务、派活，我们当执行器和监控台。

**风险在于**：这个判断从立项到第一期收尾，一次都没实测过。
第一期验证的是「编排逻辑」（拆解 → 分层 → 并行 → 上下文传递 → 汇总 → 轨迹），
**没有验证桥本身**。如果 WorkBuddy 连不上本地 MCP server，整个架构要推倒重来。

所以先写一个最小的 server，把协议层打通，再谈上层。

---

## 二、怎么实现的（两个刻意的选择）

实现：`mcp-server/index.js`（约 250 行，**零依赖**）

### 选择 1：手写 JSON-RPC，不装官方 SDK

MCP 的 stdio 传输，本质就是**一行一个 JSON-RPC 消息**：

```
客户端 → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}\n
服务端 → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"...","serverInfo":{...}}}\n
客户端 → {"jsonrpc":"2.0","method":"notifications/initialized"}\n     ← 通知，无 id，不响应
客户端 → {"jsonrpc":"2.0","id":2,"method":"tools/list"}\n
服务端 → {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}\n
客户端 → {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"...","arguments":{...}}}\n
服务端 → {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"..."}]}}\n
```

就这些。为此引入 `@modelcontextprotocol/sdk` 一棵依赖树，还要在本机过一遍
`npm install`（**装了火绒，会被拖到几十分钟，甚至半装**），收益为零。

### 选择 2：stdout 只走协议，日志一律走 stderr

这是 MCP server 最容易踩的坑：**往 stdout 打一行日志 = 客户端 JSON 解析失败 = 整个 server 失联**，
而且客户端报的错通常只是"连接断开"，根本不指向真正原因。

所以代码里 `console.log` 一次都没出现，所有日志走 `process.stderr.write`，
自测里还专门有一条断言检查 stdout 是否被污染。

### 别的细节

- **协议版本回显**：客户端请求什么版本就回什么（在白名单内），否则回 `2025-06-18`。兼容性优先。
- **不 await 请求**：`handle(msg)` 刻意不 await，长任务（跑成员要几十秒）不阻塞读流，响应靠 id 匹配。
- **默认工作目录 = 项目根**，不用 `process.cwd()` —— server 是被客户端拉起的，cwd 由客户端决定，
  拿它当默认值会让"文件落到哪"不可预测。

---

## 三、暴露了哪三个工具

| 工具 | 用途 | 花钱吗 |
|---|---|---|
| `agenthub_list_members` | 列出成员及**实测**可用性（启动子进程跑 `--version`） | 否 |
| `agenthub_run_member` | 让单个成员执行一段提示词，返回产出 + 耗时 + 花费 | 是 |
| `agenthub_run_plan` | 按计划做多成员协同：依赖分层、同层并行、上游产出注入下游、返回轨迹 | 是 |

对应产品设计里的两种用法：**前两个 = 单独使用，第三个 = 协同合作**。

---

## 四、验证结果（`mcp-server/selftest.mjs`）

自测扮的是 **MCP 客户端那一侧**（也就是 WorkBuddy 的角色），
起 server 子进程、走真实 stdio 协议，不 mock 任何一层。

```
✓ 握手 initialize            — agenthub v0.1.0 · 协商协议 2025-06-18
✓ 声明 tools 能力
✓ tools/list 返回工具        — agenthub_list_members, agenthub_run_member, agenthub_run_plan
✓ 每个工具带 inputSchema
✓ agenthub_list_members 可调用 — 共 6 个成员，实测可用 1 个
✓ claude 实测可用            — 2.1.278 (Claude Code)
✓ agenthub_run_member 真跑到成员 — 2684ms
✓ stdout 未被日志污染         — 干净

8/8 项通过
```

`run_member` 的原始返回（未加工）：

```
成员：Claude（claude）
状态：ok
权限：readonly
耗时：2682ms
花费：$0.0067（输入 1297 / 输出 7 tokens）

--- 产出 ---
MCP 桥接通了
```

**这条就是硬证据**：客户端发一个 `tools/call`，一路穿到 `claude.cmd` 子进程，产出再原路回来。
中间没有任何人工介入、没有文件搬运。

（顺带印证了 `--bare` 的效果：这次 readonly 短任务只花 1,297 input tokens。）

---

## 五、端到端已打通 ✅（2026-09-29 13:24 实测）

配置写在 `~/.workbuddy/mcp.json`。**但改完不会立即生效** —— WorkBuddy 的 MCP 工具清单是
**启动时生成并缓存**的（`~/.workbuddy/mcp-tool-list.json`）。

**证据链**：

| 时刻 | `mcp-tool-list.json` mtime | 里面有没有 `agenthub` |
|---|---|---|
| 写入配置时 | 12:40（启动时生成） | ❌ 没有 |
| **重启 WorkBuddy 后** | **13:24** | ✅ 有了 |

⚠️ **重启有个坑**：本机点关闭按钮是**最小化到托盘**，不是退出
（`~/.workbuddy/app/close-to-tray-hint.json` 存在即为证）。必须从托盘图标右键退出，或直接结束进程。
"关掉再打开"是没用的。

**重启后在 WorkBuddy 会话里实测调用**（这一步不再是自测脚本，是真的走 MCP 通道）：

```
agenthub_list_members → 共 6 个成员，实测可用 1 个
                        claude：2.1.278 (Claude Code) ✅
                        cursor / qoder / trae / doubao：退出码 1
                        dsh：配置中已禁用

agenthub_run_member   → 成员：Claude（claude）
                        状态：ok
                        权限：readonly
                        耗时：1951ms
                        花费：$0.0066（输入 1295 / 输出 5 tokens）
                        --- 产出 ---
                        端到端通了
```

**这就是最终证明**：WorkBuddy（主脑）→ MCP → AgentHub 引擎 → `claude.cmd` → 原路返回。
「WorkBuddy 没有 CLI，所以反过来让它当 MCP 客户端」这个架构判断**成立**。

配置最后长这样（**迁移到 `D:\app\AgentHub` 之后**）：

```json
{
  "mcpServers": {
    "agenthub": {
      "type": "stdio",
      "command": "C:\\Users\\deno\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe",
      "args": ["D:\\app\\AgentHub\\mcp-server\\index.js"],
      "description": "AgentHub — 多 agent 协同引擎（列成员 / 单成员执行 / 多成员协同计划）"
    }
  }
}
```

> ⚠️ **改这个文件里的 `command` / `args` / `env` / `cwd` 之后，必须重跑一次
> `python tools/mcp-trust-refresh.py`**，否则 server 会在下次启动被静默丢弃。原因见第八节。

---

## 六、这次验证排除了哪些风险

| 原风险 | 状态 |
|---|---|
| R4「MCP 长任务要异步轮询防超时」 | **已证实存在**。`run_member` 短任务 2.7s 没问题，但真跑一个编码任务要 20–60s，多成员协同计划更长。MCP 客户端有请求超时，第二期必须做异步任务 + 轮询（先返回 taskId，再查状态） |
| 「WorkBuddy 能否连上本地 MCP server」 | **✅ 已验证** —— 13:24 在 WorkBuddy 会话内经 MCP 真实调用成功 |
| 「本地 MCP 是否只能 stdio」 | 已确认 stdio 可用；HTTP/SSE 作为备选未验证 |

---

## 七、复现命令

```bash
cd agent-hub

# 单独起 server（正常由 MCP 客户端拉起，手动起会等 stdin 输入）
node mcp-server/index.js

# 自测：扮演客户端走完整协议（最后一次调用花约 $0.007）
node mcp-server/selftest.mjs

# 成员可用性（等价于 MCP 工具 agenthub_list_members，不需要启动客户端）
node tests/list-members.mjs

# ⚠️ 别用 tests/probe.mjs —— 旧脚本，用「裸命令名」探测（cursor-agent / qodercli / ...），
#    这些命令不在 PATH 里就一律 FAIL，实测假报「可用 1/5」，真实是 3/6。
#    （2026-09-29 晚更新：Trae 与豆包均已 L2 通过，现在是 5/6 —— 见 05-成员接入.md）
#    判断成员可用性必须走 members.json 里的绝对路径 command。
```

---

## 九、成员实测：从「能探测到」到「真能干活」（2026-09-29 15:50）

> 成员接入的完整做法（适配器类型、promptMode 三种取值、Trae 与豆包的完整踩坑）
> 已整理到 [05-成员接入.md](05-成员接入.md)；本节只保留当时的 L1/L2 验证记录。

**关键教训：`probeAll` 只跑 `--version`，通过 ≠ 能执行任务。** 各有各的门槛：

### Cursor：需要 `--trust`

```
agenthub_run_member(cursor, readonly) →
  failed · 1132ms
  ⚠ Workspace Trust Required
    Cursor Agent can execute code and access files in this directory.
    Do you trust the contents of this directory?  D:\app\AgentHub
    To proceed ... Pass --trust, --yolo, or -f if you trust this directory
```

**修法**：`generic` adapter 的 `buildArgs()` **不支持 `baseArgs`**
（只走 `argsTemplate` → `permissionArgs` → model → workdir → role），
所以 `--trust` 必须放进 `argsTemplate`：

```json
"argsTemplate": ["--trust", "-p", "{prompt}"]
```

修完立即验证通过：`ok · 11335ms · 产出「Cursor 已接入」`。

> **改 `members.json` 不需要重启客户端** —— `mcp-server/index.js` 的 `callTool()`
> 每次调用都重新 `loadRegistry()`，每次都读盘。
> （同时它也**不影响 MCP 信任指纹** —— 指纹只覆盖 `mcp.json` 里该 server 的
> `command/args/env/cwd`，与 `members.json` 无关。两个文件的作用域别搞混。）

### Qoder：需要先登录

```
agenthub_run_member(qoder, readonly) → failed · 5042ms · Not logged in · Please run /login
```

`qodercli login` 走浏览器设备授权（会打印一个 `qoder.com/device/selectAccounts?...` 链接）。

### 结论：单成员可用性判定要做两层

| 层次 | 方法 | 能发现什么 |
|---|---|---|
| L1 装没装 | `probeAll()` 跑 `--version` | 路径对不对、二进制在不在 |
| L2 能不能干活 | 真跑一次 `run_member` 极短任务 | 未登录 / 需信任目录 / 权限参数错 |

**L1 全绿也可能 L2 全挂。** 接入新成员后必须补一次 L2 冒烟（一句"只回复五个字"即可，
花费约 $0.006）。

---

## 十、多成员协同（`run_plan`）验证：先「假成功」，再真通过（2026-09-29 15:57）

这是"协同合作"主入口的第一次真跑。**第一次结果 3/3 "成功"，但三个产出全是废的。**

### 第一次：暴露致命缺陷 —— 多行 prompt 被 cmd 截断

轨迹里的命令原文就是证据：

```
cursor-agent.cmd --trust -p "【任务总目标】
验证 AgentHub 多成员协同：...
```

**双引号内的换行把参数就地截断了。** 成员实际只收到第一行，产出：

> 你这条消息只有标题「任务总目标」，还没有具体内容。请把完整目标、约束和期望产出补全。

Qoder 同样中招。而 **`status` 显示 `ok`、退出码 0、报告写 3/3 成功** ——
一个完全无效的运行被描成了满分。

（Claude 之所以"躲过"，是因为它的 promptMode 本来就是 `stdin`，命令里根本没有 prompt 参数。）

### 修复：prompt 统一走 stdin

实测两家 CLI 都支持 stdin：

```bash
printf '只回复：STDIN 可用' | ./cursor-agent.cmd --trust -p     # → STDIN 可用
printf '只回复：STDIN 可用' | qodercli.cmd -p                  # → STDIN 可用
```

`members.json` 改动：

| 成员 | promptMode | argsTemplate |
|---|---|---|
| cursor | `arg` → **`stdin`** | `["--trust","-p","{prompt}"]` → `["--trust","-p"]` |
| qoder | `arg` → **`stdin`** | `["-p","{prompt}"]` → `["-p"]` |

（`{prompt}` 占位符必须**拿掉** —— 它在 `promptMode: stdin` 下会被忽略，
但留着容易让人误以为是 arg 模式。claude 本来就是 stdin，无需改动。）

### 第二次：真通过

设计了一条**自证式**依赖链 —— 每步答案都必须依赖上一步产出，蒙不出来：

```
s1 (Cursor) 输出 alpha bravo charlie  →  s2 (Qoder) 取第二个单词  →  s3 (Claude) 数它的字母个数
预期：        alpha bravo charlie     →   bravo               →   5
实际：        alpha bravo charlie     →   bravo               →   5   ✅
```

| 项 | 值 |
|---|---|
| 结果 | **3 / 3 成功** |
| 总耗时 | 34.2s（s1 14046ms / s2 18054ms / s3 2096ms） |
| 花费 | $0.0073 |
| 轨迹存档 | `D:\app\AgentHub\.agenthub\runs\mcp-1790668805804.md` / `.json` |

**这就验证了协同的两个核心机制**：依赖分层串行调度 ✓、上游产出自动注入下游提示词 ✓。

### 三条结论

1. **prompt 必须走 stdin。** 多行 prompt 走命令行参数在 Windows 上必被截断 ——
   而且截断后**退出码仍是 0**，静默产出垃圾。
2. **`status: ok` ≠ 产出有效。** 判定要看产出内容跟预期逐字对。详见 skill
   `windows-agent-cli-headless` 的「三层冒烟」。
3. **剩下的尾巴**：claude 的 stderr 有一条
   `[claude-code:unrecognized_model] {"model":"deepseek-flash","query_source":"sdk"}` ——
   本机环境变量把模型指定成了 `deepseek-flash`，claude 不认识这个模型名。
   本次不影响结果（它答对了），但值得单独查一次配置。



---

## 八、信任指纹：为什么"改了路径，工具就消失了"（2026-09-29 实战）

### 症状

迁移到 `D:\app\AgentHub` 并重启 WorkBuddy 后，`mcp__agenthub__*` 从工具索引里消失。
排查所见：

| 检查项 | 结果 |
|---|---|
| `~/.workbuddy/mcp.json` 内容 | ✅ 正确，JSON 合法 |
| `22.22.2-3\node.exe` | ✅ 存在 |
| `mcp-approvals.json` 里的信任记录 | ✅ 那条 `...::agenthub` 还在 |
| server 自测 `selftest.mjs` | ✅ **8/8 通过**，stderr 干净 |
| `mcp-tool-list.json` | ❌ 不含 agenthub（mtime 13:33:42 = 重启时刻） |

### 日志给出的关键证据

```
13:24:28（旧配置）  provider=user items=1  →  controllers=8  fresh=[custom-mcp:agenthub]  state=ready ✅
13:27:34            mcp.json 被改写（node 路径被规范化）
13:33:37（新配置）  provider=user items=1  →  controllers=7  ❌ 且 skipped 里没有它
```

`items` 仍是 8、`skipped` 为空 —— 说明它**被读到了、也没被当成错误跳过**，只是没变成 controller：
典型「信任校验不通过 → 静默丢弃」。

### 根因（对源码逐字节核对）

信任表 `~/.workbuddy/mcp-approvals.json` 的落盘键是 `${configHash}::${serverName}`：

```js
trustMaterial(stdio) = [command, args.sort().join(","), envKeys.sort().join(","), cwd?].join("|")
configHash = sha256(trustMaterial)
```

把已有键的 hash 反推回原文，得到的正是**迁移前的旧配置**：

```
C:\Users\deno\.workbuddy\binaries\node\versions\22.22.2-3\node.exe|D:\app\workbuddy-work\2026-09-29-12-44-53\agent-hub\mcp-server\index.js|
```

→ 13:24 受信的是**旧 args**；13:27 把 args 换成新路径后 `configHash` 变了，
旧记录命不中，13:33 重启时 agenthub 被判为未授信。

`isApproved()` 跑在归并路径的**同步**分支上（"归并期不做 I/O"），未授信就直接不进 items，
所以既不报错也不弹窗、面板里也看不到 —— 这是最难查的一类失败。

### 修复

不点授权、也不改回旧路径，直接把当前配置的指纹补进信任表：

```bash
python tools/mcp-trust-refresh.py --dry-run   # 先看命中情况
python tools/mcp-trust-refresh.py             # 写盘
# 然后从托盘彻底退出 WorkBuddy 再启动
```

脚本按官方口径重算 `trustMaterial`（stdio + 远端 origin 两种），新增/更新
`{hash}::agenthub`。已备份原文件到 `D:\app\AgentHub\backup\`。

### 结论 / 规矩

> **只要动了 `command` / `args` / `env` 的 key / `cwd` 任意一个，就要重跑指纹刷新。**
> 而且 WorkBuddy 自己也会规范化 `command` 里的 node 路径（把 `22.22.2` 改写成托管的
> `22.22.2-3`），所以**你不改它也可能某天自己失效**。


---

## 十一、产出有效性校验：让 `status: ok` 不再骗人（L3 冒烟）

第十节留下的第 2 条结论（「`status: ok` ≠ 产出有效」）这次落了地。

### 要解决的问题

成员调用的返回值里，`status` 只由**进程退出码**决定。上游一旦静默产出垃圾
（prompt 被截断、CLI 未登录、目录未受信…），退出码照样是 0，
`run_plan` 就会在报告里写「3 / 3 成功 · 0 失败」——**满分假绿**。

第十节第一次跑 `run_plan` 就是活例子：报告 3/3，产出全是
「你这条消息只有标题【任务总目标】，还没有具体内容」。

### 做法：`src/engine/quality.js`

新增 `judgeOutput(text, meta)`，返回 `{ level: 'ok' | 'suspect', codes, note }`，
是**附加提示**，不改变 `status`，也不干预调度。

| 规则 | 触发条件 | code |
|---|---|---|
| 空产出 | trim 后为空 | `empty` |
| 推诿模板 | 命中"要求补充目标/内容"类句式，**且产出 ≤ 800 字符** | `template-refusal` |
| 环境错误 | 命中未登录 / 命令不存在 / 目录未受信等，**且产出 ≤ 400 字符** | `env-error` |

**两条刻意的"不做"**：

1. **不按"过短"判定。** 合法答案经常极短 —— 实测协同验证里 s3 的正确产出就是 `"5"`
   （1 个字符）。按长度判会把正确答案标成可疑。
2. **长产出不参与推诿/环境词判定。** 一份长文档里正常讨论"用户没有提供具体内容"、
   引用报错日志 `not logged in` 都是常见写法，长度闸把它挡在门外。

> 原则：**宁漏勿误**。这个标记的价值全在可信度上 ——
> 一个会喊狼来了的标记，比没有标记更糟。

### 接入三处

| 位置 | 作用 |
|---|---|
| `orchestrator.js` → `runOne` | 每条 trace entry 写入 `quality: judgeOutput(r.text, { status })` |
| `trace.js` → `summary` / `toMarkdown` | summary 新增 `suspectCount`；报告头加警示块，表格状态列显示 `ok ⚠️`，逐条加 `- ⚠️ 产出可疑（code）：…` |
| `mcp-server/index.js` → `run_member` | 返回 header 加 `⚠️ 产出可疑` 与 note，WorkBuddy 侧一眼可见 |

报告里现在会明确写出：

> ⚠️ **其中 N 个产出可疑** —— 进程正常退出（退出码 0），但内容不像是有效结果。
> 「成功」只说明没崩，不说明事办成了。

### 测试

样本全部取自**两次真实运行**（`.agenthub/runs/mcp-1790668720650.json` 失败 /
`mcp-1790668805804.json` 成功），不造假样本。

```
tests/quality.test.mjs  11 通过 / 0 失败
  [应判可疑] 真实失败样本 s1 / s2        → template-refusal ✓
  [应判正常] alpha bravo charlie / bravo / "5"  → ok ✓
  [边界] 空产出、status=failed 跳过、未登录、目录未受信
  [防误报] 长文里出现 "not logged in" / "请补充" → 仍判 ok ✓

tests/trace.test.mjs    16 通过 / 0 失败
  新增用例：假成功在报告里显形（退出码 0 但产出可疑 → suspectCount=1 + `ok ⚠️`）
           干净轨迹不出现任何警示块（防误报）

回归：orchestrator 11/11 · plan 32/32 · planner 15/15
```

### 局限（已知且接受）

- 是**启发式**，不是语义校验。真正的验收标准（"答案对不对"）只有调用方能定义，
  所以这里只挡"结构性地不可能合格"的产出。
- 只覆盖**推诿**与**环境错误**两类。答非所问、答了一半，仍会判 ok ——
  这需要各成员自己的评测集，属于后续的事。

