#!/usr/bin/env python3
"""重新计算 ~/.workbuddy/mcp.json 里各 server 的信任指纹，并补写进 mcp-approvals.json。

背景（来自 WorkBuddy 应用内实现，packages/workbuddy-server/src/agent-harness/mcp/trust/）：

    function trustMaterial(transport) {
      if (transport.kind === "stdio") return [
        transport.command,
        (transport.args ?? []).map(String).sort().join(","),
        Object.keys(transport.env ?? {}).sort().join(","),
        ...transport.cwd ? [transport.cwd] : []
      ].join("|");
      return safeOrigin(transport.url);          // new URL(url).origin
    }
    configHash = sha256(trustMaterial)
    approvalKey = `${configHash}::${serverName}`  // 裸名，不带 custom-mcp: 前缀

只要 command / args / env(keys) / cwd 任意一个字节变了，configHash 就变，
旧的批准记录命不中，该 server 会在下次启动被判为「未授信」并被**静默丢弃**
（不报错、不弹窗、管理面板里也看不到）。

用法：
    python tools/mcp-trust-refresh.py [--dry-run]
"""
import hashlib
import json
import os
import sys
import time
from urllib.parse import urlsplit


def config_dir() -> str:
    home = os.path.expanduser("~")
    return os.path.join(home, ".workbuddy")


def safe_origin(url: str) -> str:
    """等价于 JS 的 new URL(url).origin；解析失败退回原文。"""
    try:
        p = urlsplit(url)
        if not p.scheme or not p.hostname:
            return url
        host = p.hostname.lower()
        port = p.port
        default = {"http": 80, "https": 443}.get(p.scheme.lower())
        netloc = host if (port is None or port == default) else f"{host}:{port}"
        return f"{p.scheme.lower()}://{netloc}"
    except Exception:
        return url


def trust_material(entry: dict) -> str:
    if entry.get("command"):
        args = sorted(str(a) for a in (entry.get("args") or []))
        env_keys = sorted((entry.get("env") or {}).keys())
        parts = [entry["command"], ",".join(args), ",".join(env_keys)]
        if entry.get("cwd"):
            parts.append(entry["cwd"])
        return "|".join(parts)
    if entry.get("url"):
        return safe_origin(entry["url"])
    return ""


def main() -> int:
    dry = "--dry-run" in sys.argv
    root = config_dir()
    mcp_path = os.path.join(root, "mcp.json")
    approvals_path = os.path.join(root, "mcp-approvals.json")

    with open(mcp_path, encoding="utf-8") as f:
        mcp = json.load(f)
    servers = mcp.get("mcpServers") or {}

    approvals = {}
    if os.path.exists(approvals_path):
        try:
            with open(approvals_path, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                approvals = {k: v for k, v in loaded.items() if isinstance(v, (int, float))}
        except Exception as e:
            print(f"[warn] 读 {approvals_path} 失败，按空表处理: {e}")

    now = int(time.time() * 1000)
    added = []
    for name, entry in servers.items():
        if not isinstance(entry, dict):
            continue
        material = trust_material(entry)
        if not material:
            continue
        h = hashlib.sha256(material.encode("utf-8")).hexdigest()
        key = f"{h}::{name}"
        status = "already" if key in approvals else "ADD"
        if status == "ADD":
            approvals[key] = now
            added.append(name)
        print(f"[{status:7}] {name:12} {h[:16]}  <- {material}")

    if dry:
        print("\n[dry-run] 未写盘。")
        return 0

    with open(approvals_path, "w", encoding="utf-8") as f:
        json.dump(approvals, f, indent=2, ensure_ascii=False)
    print(f"\n已写入 {approvals_path}（新增/更新 {len(added)} 条：{', '.join(added) or '无'}）")
    print("下一步：从托盘彻底退出 WorkBuddy 再启动，状态才会重新装填。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
