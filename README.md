# AgentHub

多 agent 协同工作台。**WorkBuddy 当主脑**做任务拆解与角色分配，其他 AI agent 当执行手。
每个成员既能单独使用，也能组成一条自动协同的流水线。

---

## 当前阶段

**第一期：编排逻辑验证 —— 核心链路已跑通** ✅

用真任务验证过：主脑拆解 → 依赖分层 → 并行调度 → 上下文传递 → 汇总 → 轨迹报告。

**MCP 桥接 —— 协议层已验证** ✅

自写 MCP server，把引擎暴露成 3 个工具。自测 **8/8 通过**，工具能一路穿到 `claude.cmd`
子进程并原路返回产出。详见 [docs/04-MCP桥接验证.md](docs/04-MCP桥接验证.md)。

**第二期：工作台界面 —— 已落地并跑通** ✅

三栏骨架、单会话 / 并排（含广播）/ 协同任务三种视图、可编辑编辑器（带保存冲突处理）、
成员管理（可加自定义成员）、执行计划确认闸、SSE 实时事件流 —— 全部按
[docs/02-界面设计.md](docs/02-界面设计.md) 实现，浏览器冒烟 **223/223 通过**。

刻意**没有**直接上 Electron：本机火绒会把 `pnpm install` 拖到 20~40 分钟且容易半装，
所以先用零依赖的 Node `http` + SSE 把界面和引擎接通（浏览器直接打开）。
之后包 Electron 只是加一层窗口壳加载**同一个页面**，`ui/public/` 零改动。

---

## 现在能做什么

```bash
# ── 工作台界面（第二期）──
node ui/server.js --workdir D:/app/AgentHub     # 或 npm run ui → http://127.0.0.1:8787
cp .env.example .env                            # 密钥放这里（长驻进程读不到你 export 的变量）
node tests/ui-smoke.mjs                         # 浏览器冒烟，223 条断言，零依赖不用装 Playwright

# ── 命令行（第一期）──
node cli.js probe                               # 探测成员可用性（只跑 --version，不花钱）
node cli.js dry --plan tests/real-plan.json     # 干跑：校验计划 + 显示执行批次（不花钱）
node cli.js run --plan tests/real-plan.json --budget 2.0   # 真跑，产出轨迹报告
node cli.js auto --goal "给 utils 模块补单测并写说明" --budget 1.5  # 拆解 + 执行一条龙

# ── MCP 桥接 ──
node mcp-server/index.js                        # 起 MCP server（正常由客户端拉起）
node mcp-server/selftest.mjs                    # 扮演客户端走完整协议（末次调用约 $0.007）

# ── 测试 ──
npm test                                        # 引擎单测：runner 报 256 全绿；真实断言 318 条
                                                #   （3 个文件用自建 harness，在 node --test 下各只算 1 条，故 runner 数偏低）
npm run smoke:member -- doubao                  # 单成员三层冒烟：装没装 / 能不能干活 / 产出有效
node tests/real-run.mjs --goal "..." --phase plan   # 真跑：走界面真通道拆解，不执行
node tests/real-run.mjs --goal "..." --phase run --permission execute   # 真跑执行（花钱）
```

常用参数：`--permission readonly|plan|execute|full` · `--workdir <dir>` · `--budget <usd>`

---

## 实测环境记录（2026-09-29 更新）

| 成员 | 状态 | 说明 |
|---|---|---|
| **Claude** | ✅ **可用** | `C:\Users\deno\bin\claude.cmd` v2.1.285。模型由 CC Switch / `settings.json` 决定（**刻意不固定**，见下） |
| **Cursor** | ✅ **可用** | v2026.09.28-64d2043 · `tools\cursor-agent\dist-package\cursor-agent.cmd`。官方 zip 解压到项目内，**刻意没走官方安装脚本**（那个会改系统 PATH）。⚠️ 派活需 `CURSOR_API_KEY` 或 `cursor-agent login` |
| **Qoder** | ✅ **可用** | v1.1.64 · `C:\Users\deno\.npm-global\qodercli.cmd`（npm 全局）。⚠️ 派活需 `/login` 或 `QODER_PERSONAL_ACCESS_TOKEN` |
| **Codex** | ✅ **可用** | codex-cli 0.159.2 · Codex 桌面版自带的 CLI（路径含哈希目录，配置用通配取最新）。**就是写这个工具的 Codex 自己**。入口 `codex exec --json`，输出是 JSONL，走专用适配器 `src/adapters/codex.js`（见 [docs/05](docs/05-成员接入.md) §22） |
| **Trae** | ⛔ **缺凭据** | trae-cli 0.1.0 · `tools/trae-venv312`（**必须 Python 3.12**，依赖 `tree-sitter-languages` 只有 cp312 及以下 wheel）。⚠️ 只认 `DOUBAO_API_KEY`。**原先是"探活报绿"的假可用**：`--version` 不碰 API Key，所以永远绿，直到派活时才炸 `Missing credentials` —— 已改为注册期前置检查，现在如实报缺凭据（详见 [docs/05-成员接入.md](docs/05-成员接入.md) §8） |
| **豆包** | ⚠️ 需密钥 | **无官方 CLI** —— `@volcengine/arkclaw` 是 SDK 库（`bin` 为空），装了敲不出命令。已自写 REST 适配器 `src/adapters/doubao.js` 直连火山方舟。**当前唯一缺的是 API Key**，写进 `.env` 即可 |
| DSH | ❌ **启动失败** | 入口已确认（`--profile headless`），但实测退出码 1 —— 见 [docs/05](docs/05-成员接入.md) §21.2 |

**4 / 7 成员此刻实测可用**（claude / codex / cursor / qoder）。Codex 接入后，**链路打通的一共 5 个成员**；trae 与豆包缺密钥、DSH 启动失败。这个数会随环境里的密钥变 —— 界面上的 NODES 数就是它。

### 一个环境变量管两个成员

`DOUBAO_API_KEY` 同时喂饱豆包和 Trae —— trae-agent 按 **provider 名**推导环境变量名，
`trae_config.yaml` 里 `provider: doubao`，所以它**只读 `DOUBAO_API_KEY`**。
设 `ARK_API_KEY` 它不认，而且报出来的是一段 Python 异常堆栈，**完全看不出是 key 的问题**，
极易误判成"环境装坏了"。豆包适配器已把两者做成等价别名，建议统一用 `DOUBAO_API_KEY`。

### 模型的来源：刻意不固定

编排层 **不向成员传 `model`** —— 这是 2026-09-29 的决定，不是漏写。
目的是让每个成员沿用各自 CLI 的既有配置（claude 跟随 CC Switch / `settings.json`），
换供应商时只改一处，不必在 AgentHub 里再维护一份模型清单。

本机实测：`claude.cmd` 被 CC Switch 指向 `api.deepseek.com/anthropic`，实际跑的是 `deepseek-flash`。
CLI 会打一条 `[claude-code:unrecognized_model]` 到 stderr —— **那是噪音**，请求照常转发。

### 四条实打实跑出来的性能数据

| 场景 | 子任务 | 耗时 | 花费 |
|---|---|---|---|
| 首次真跑（2 并行 + 1 汇总） | 3 | 68.5s | $1.0621 |
| 回归验证（单子任务） | 1 | 14.3s | $0.1306 |
| 同类任务 + `--bare` | 3 | 52.3s | **$0.2851** |

**固定开销**：每次调用约吃掉 **18.6k input tokens**（Claude Code 自带的系统提示 +
内置工具 JSON Schema），带上角色提示词后实测 **19.6k**，折合约 $0.10。

**已优化**：给 claude 挂 `--bare` 后，固定开销从 18,577 降到 1,285 tokens（**−93%**），
完整协同任务成本 **−73%**，且实测工具能力一个没少。

→ 所以子任务不是拆得越细越好，拆太碎会把钱花在重复的上下文加载上。

**反应速度**：codex 单次调用实测量到 **21.4s**，其中约 **10s 是它答完之后进程自己挂着不退** ——
真正出答案只用了 1.9s。改成「收到收尾事件就按进程树收工」后降到 **2.2s**（−90%），判定结论不变。
详见 **[docs/05-成员接入.md](docs/05-成员接入.md) §23**。

📄 完整数据、对照实验与复现命令见 **[docs/03-成本模型.md](docs/03-成本模型.md)**

---

## MCP 桥接（WorkBuddy 接入）

WorkBuddy 没有 CLI / API（纯 GUI），所以不能唤起它 —— **反过来**让它当 MCP 客户端连我们。
`mcp-server/index.js` 暴露三个工具：

| 工具 | 用途 | 花钱 |
|---|---|---|
| `agenthub_list_members` | 列出成员及实测可用性（跑 `--version` 实测） | 否 |
| `agenthub_run_member` | 单成员执行 = **单独使用** | 是 |
| `agenthub_run_plan` | 多成员协同 = **协同合作** | 是 |

**两个刻意的实现选择**：

1. **零依赖**，手写 JSON-RPC over stdio。MCP 的 stdio 本质就是"一行一个 JSON-RPC 消息"，
   不值得为它过一遍 `npm install`（本机有火绒，会被拖到几十分钟甚至半装）。
2. **stdout 只走协议，日志一律走 stderr**。往 stdout 打一行日志 = 客户端 JSON 解析失败 =
   server 失联，而且客户端报的错完全不指向真正原因。

配置已写入 `~/.workbuddy/mcp.json`。**新 MCP 不会自动生效** —— 工具清单是启动时生成并缓存的
（`~/.workbuddy/mcp-tool-list.json`），必须**彻底重启 WorkBuddy**。
⚠️ 本机点关闭按钮只是**最小化到托盘**，不是退出，要从托盘右键退出。

**端到端已实测打通（2026-09-29 13:24）**：在 WorkBuddy 会话里直接调用 ——
`list_members` 返回 7 个成员（实测可用 1 个）→ `run_member` 真跑到 Claude，
1951ms / $0.0066，产出「端到端通了」。

---

## 权限档位

对外三档，各成员自己翻译成本家参数：

| 档位 | 含义 | Claude 映射 |
|---|---|---|
| `readonly` 只读 | 只分析、只出建议，绝不落盘 | `--permission-mode dontAsk` |
| `plan` 计划 | 给方案，确认后才落盘（默认） | `--permission-mode plan` |
| `execute` 执行 | 直接改文件 + 跑命令 | `--permission-mode acceptEdits` + `--allowedTools` |
| `full` 全自动 | 全部放行 | `--permission-mode bypassPermissions` |

⚠️ **踩过的坑**：`acceptEdits` 只放行**文件修改**，不放行**执行命令**。
所以 execute 档必须额外挂 `--allowedTools Bash Read Write Edit Glob Grep`，否则 agent 改完文件跑不了测试。

---

## 目录结构

```
agent-hub/
├── cli.js                    命令行入口
├── .env.example              密钥模板（复制成 .env；长驻服务读不到你 export 的变量）
├── src/
│   ├── adapters/             成员适配器层
│   │   ├── exec.js           子进程执行（本机坑都封在这）
│   │   ├── base.js           统一接口 + 角色提示词
│   │   ├── claude.js         Claude 专用适配器
│   │   ├── generic.js        配置驱动的通用适配器（promptMode: stdin / arg / file）
│   │   ├── doubao.js         豆包 REST 适配器（无官方 CLI，直连火山方舟）
│   │   └── index.js          成员注册表
│   ├── engine/               编排引擎
│   │   ├── plan.js           计划校验 + 依赖分层
│   │   ├── orchestrator.js   调度主流程（onEvent 事件流）
│   │   ├── planner.js        任务拆解
│   │   ├── quality.js        产出有效性判定（防"退出码 0 = 成功"的假绿）
│   │   ├── changes.js        文件改动采集（拍快照前后 diff，采不全就报"未采集"）
│   │   └── trace.js          运行轨迹与报告
│   └── config/members.json   成员配置（加成员不改代码）
├── ui/                       第二期工作台界面
│   ├── server.js             零依赖本地服务：静态文件 + API + SSE
│   └── public/               index.html / style.css / app.js（原生 ESM，零依赖）
├── mcp-server/               MCP 桥接（WorkBuddy 从这一侧接进来）
│   ├── index.js              零依赖 MCP stdio server，暴露 3 个工具
│   └── selftest.mjs          扮演 MCP 客户端走完整协议的自测
├── tools/                    第三方 CLI，随项目走（不污染系统 PATH）
│   ├── cursor-agent/         Cursor CLI（官方 zip 解压而来）
│   ├── trae-agent/           Trae（GitHub 源码）
│   └── trae-venv312/         专为它建的 Python 3.12 虚拟环境
├── tests/
│   ├── *.test.mjs            引擎单测（npm test）
│   ├── ui-smoke.mjs          界面冒烟（CDP 直连 Edge，零依赖，可带截图）
│   └── smoke-member.mjs      单成员三层冒烟
├── docs/                     需求 + 界面设计 + 成本模型 + MCP 验证 + 成员接入
└── .agenthub/                运行产物（runs / shots / 临时文件）
```

---

## 本机环境的坑（都已在代码里处理）

1. **Git Bash 不认 `.cmd`** —— `command -v claude` 找不到，实际文件是 `claude.cmd`。spawn 必须带扩展名 + `shell: true`。
2. **cmd.exe 输出 GBK** —— 中文错误信息会乱码。解法：命令前挂 `chcp 65001 >nul &`。
3. **prompt 别走命令行参数** —— 转义和引号会坑死你。走 stdin 又快又稳（3.0s vs 7.1s）。
4. **stdin 必须立刻 end()** —— 否则 claude 会空等 3 秒再继续。
5. **`reg.exe` 被安全策略拦** —— claude 启动时会碰它，每次都报一条告警，不影响功能，已在日志里过滤。

---

## 已知问题 / 下一步

- [x] MCP 桥接协议层验证（自测 8/8）
- [x] 端到端打通 —— 在 WorkBuddy 会话里经 MCP 真实调用成功（13:24）
- [x] **项目迁出会话工作目录** → `D:\app\AgentHub`（会话目录会被归档清理）
- [x] 安装 Cursor / Qoder CLI（均实测可用，1 个成员 → 3 个）
- [x] **重启 WorkBuddy**：`mcp.json` 已指向 `D:\app\AgentHub\mcp-server\index.js`
- [x] Trae：从 GitHub 源码装好并跑通（Python 3.12 venv + 补装 optional 依赖 + `--file` 传 prompt）
- [x] 豆包：自写 REST 适配器（无官方 CLI）
- [x] **第二期工作台界面**：三栏骨架 + 三种视图 + 编辑器 + 成员管理 + SSE（冒烟 223/223）
- [ ] **豆包 / Trae 补上 `DOUBAO_API_KEY`**：写进 `.env` 即可（一个变量管两个成员）。
      模型还需在方舟控制台「开通管理」里单独开通，且**开通后数分钟内有同步延迟**（实测同一分钟内会时好时坏，重试即可）
- [x] **堵掉「L1 探活假绿」** ✅ 2026-09-29：成员配置支持 `requiredEnv`，
      探活前先查环境变量，缺了直接判不可用并说清缺哪个。
      起因是真跑时 Trae 一直显示 ✅（它的探活 `--version` 不碰 API Key），
      执行到第 3 秒才炸出 `openai.OpenAIError: Missing credentials` ——
      这条教训其实早就写在下面，但**没落成代码**，所以又踩了一遍。
- [ ] **Cursor / Qoder 完成认证**：Cursor 需 `CURSOR_API_KEY` 或 `cursor-agent login`；
      Qoder 需 `qodercli` 交互 `/login`。**未认证时 `--version` 正常，但实际派活会失败** —— 别被 L1 探活骗了
- [ ] **`stopOnFailure` 策略要能选**：实测一个子任务失败会停掉整个任务，
      导致下游「最终交付」永不执行、前面花的钱只换到半份成果。见 [docs/05](docs/05-成员接入.md) §9
- [ ] **MCP 长任务异步化**（先返回 taskId，再轮询状态）。已证实是真实风险：
      单成员短任务 2.7s 没问题，但真跑编码任务要 20–60s，协同计划更长，会撞 MCP 请求超时
- [ ] 确认 DSH 有无可编程入口
- [ ] 子任务卡片级的「重试 / 换人 / 跳过」（界面按钮已就位，需要引擎支持单子任务重跑）
- [ ] 界面：拖拽会话进主区形成并排 · 编辑器语法高亮 · 深色主题 · 并排 >3 列时折叠成标签页
- [ ] 并行写文件的目录隔离（现在默认共享目录，靠串行依赖规避冲突）
- [x] **成果物自动 diff 收集** ✅ 2026-09-29 完成：引擎自己在跑前跑后拍目录树快照，
      采不全一律报「未采集」而不是「零改动」。见 [docs/05](docs/05-成员接入.md) §13
      （原描述是"现在靠成员自己报告改了哪些文件" —— 实测发现**没有任何适配器填过这个字段**，
      是个死字段；已改为引擎自己采）
- [x] **回车直接发送**（2026-10-02）：原来只有 Ctrl+回车能发、界面上还没写 —— 现在回车发 / Shift+回车换行，并让开中文输入法的选词回车
- [x] **跑动中的开销**（2026-10-02）：任务视图改增量重画（只画变动的那一块，冒烟 11b2 用**节点身份**钉住）· SSE 通道每 15 秒写一条注释行做心跳（`tests/sse-heartbeat.test.mjs`）· 拆解上限跟着规划者的能力走
- [ ] **把 Electron 壳套上**（界面已零改动可复用，只差一层窗口 + 打包）
