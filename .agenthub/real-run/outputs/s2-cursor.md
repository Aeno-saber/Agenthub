## 结论

真实产物里，`judgeOutput` **明确漏掉 3 条假成功**（全在 `run-1790658473692.json`）：成员写了测试文件，但命令被审批拦截、未实测，`status=ok` 仍被判 `ok`。经典推诿（mcp 截断那次）已能拦住；`Not logged in` / `Workspace Trust` 等环境类、以及「长文包裹导致长度门漏检」在真实数据中**未出现**。

### 扫描范围

| 来源 | 有无可判产出 |
|------|-------------|
| `.agenthub/runs/*.json`（5 个，含注释里的两个 mcp） | 有，`entries[].text` + `status` |
| `trajectories/*.json`（2 个） | 有 LLM content / 空 `final_result` |
| `tests/real-plan.json` / `real-plan-bare.json` / `verify-exec.json` | **无成员产出**（仅计划） |
| `tests/real-run.mjs` | 驱动脚本，无产出 JSON |

---

### 漏检样本（judge=`ok`，人工看是假成功）

| # | 来源 + 成员 | status | len | 原文前 200 字 | judgeOutput | 为何漏了 |
|---|-------------|--------|-----|---------------|-------------|---------|
| 1 | `run-1790658473692.json` · `claude/s2` | ok | 587 | 测试文件已写入 `tests/trace.test.mjs`…但**我无法确认全部通过**：…均被权限拦截返回 "This command requires approval"，没有真正执行… | `{"level":"ok","codes":[],"note":""}` | ① 无「假完成/未实测」规则；② 用的是 `This command requires approval` / `权限拦截`，不在 `ENV_ERROR_PATTERNS`；③ 即便写成 `permission denied`，len>400 也会被环境词长度门关掉。另：`raw.stdout` 里已有 `permission_denials[]`，判定未读 |
| 2 | 同上 · `claude/s1` | ok | 1027 | 测试文件已写好…**但测试没能跑起来**…都被权限拦截…返回 "This command requires approval"…我不能声称它通过了…**请批准执行** | 同上 ok | 同 #1；长解释性正文把失败包在「覆盖说明」里 |
| 3 | 同上 · `claude/s3` | ok | 475 | …**状态**：两份测试尚未实际执行（会话内 node 命令被权限拦截），以上为静态核对结论… | 同上 ok | 同 #1；措辞是「尚未实际执行 / 权限拦截」，现有推诿/环境 regex 都打不中 |

整次 run 报 **3/3 成功 · 0 失败**，与这三条一致——典型假成功。

---

### 类别缺口总表

| 缺口类型 | 真实数据 | 说明 |
|----------|----------|------|
| **假成功：写了但验收命令被审批拦截** | **有 3 条**（上表） | 最大实证缺口 |
| **结构化信号被忽略**（`permission_denials`） | 同批 run 的 `raw.stdout` 里有 | `judgeOutput` 只看 `text` |
| 推诿短模板（「还没有具体内容」等） | mcp-1790668720650 s1/s2 | **已拦住**，非缺口 |
| 经典环境错误（Not logged in / Workspace Trust / command not found） | **真实数据中未发现** | 仅 `quality.test.mjs` 构造样本 |
| 长文包裹推诿（>800）漏检 | **真实数据中未发现** | 仅防误报构造设计 |
| 长文包裹现有环境词（>400）漏检 | **真实数据中未发现** | — |
| 上游已废、下游仍吐合法短答案（mcp 失败链 s3=`"5"`） | 有文本，但单看不像假成功 | 链级问题；s1/s2 已被标 suspect |

---

### 脚本实际执行输出（节选）

```
===== 最终漏检样本（judge=ok 且确认为假成功/环境/推诿）=====

#1
来源: .agenthub/runs/run-1790658473692.json
成员: claude / 步骤: s2
status: ok | len: 587
原文前200: 测试文件已写入 `tests/trace.test.mjs`…但**我无法确认全部通过**：`node --tes
judgeOutput: {"level":"ok","codes":[],"note":""}
命中假成功信号: This command requires approval | 权限拦截 | 无法确认通过 | 未真正执行 | 要求放行 | 无实测输出

#2
来源: .agenthub/runs/run-1790658473692.json
成员: claude / 步骤: s1
status: ok | len: 1027
原文前200: 测试文件已写好：`tests/plan.test.mjs`…**但测试没能跑起来** —— …权限拦截… "This command requires approval"
judgeOutput: {"level":"ok","codes":[],"note":""}
命中假成功信号: This command requires approval | 权限拦截 | 未真正执行 | 要求放行 | 否认通过

#3
来源: .agenthub/runs/run-1790658473692.json
成员: claude / 步骤: s3
status: ok | len: 475
原文前200: **覆盖模块** … **状态**：两份测试尚未实际执行（会话内 node 命令被权限拦截）…
judgeOutput: {"level":"ok","codes":[],"note":""}
命中假成功信号: 权限拦截 | 未真正执行

合计漏检样本: 3

===== 类别缺口（相对真实数据）=====
1. 假成功/权限审批拦截: 真实数据有 3 条
2. 经典环境错误 Not logged in / Workspace Trust: 真实数据中未发现，仅构造样本
3. 长文包裹推诿(>800) 漏检: 真实数据中未发现
4. 长文包裹现有环境词(>400) 漏检: 真实数据中未发现
5. 推诿短模板: mcp 失败样本已被拦住
```

临时脚本已删，未改 `src/`。调研已完成：真实产物里 `judgeOutput` 漏掉 **3 条假成功**（全在 `.agenthub/runs/run-1790658473692.json` 的 claude s1/s2/s3）——写了测试但被 `This command requires approval` 拦住，仍判 `ok`。经典推诿已能拦住；`Not logged in` 等环境类、长文长度门漏检在真实数据中未发现。临时脚本已清理。