#!/usr/bin/env python3
"""
在 GitHub macOS runner 上挑一台可用的 iOS 模拟器。

为什么单独一个文件：
这段逻辑要写在 workflow 的 `run: |` 块里就得用 heredoc，而 bash 的 heredoc
终止符必须顶格、YAML 块标量又要求所有行缩进 —— 两者直接冲突。抽出来既避开
这个坑，也让"选机规则"能被单独测试。

选机规则：
  --want 指定机型名（精确匹配，如 "iPad Pro 13-inch (M4)"）
  否则优先 iPhone（最接近用户实际设备），再退到 iPad
  iOS 运行时才算数（排除 watchOS/tvOS/visionOS）

输出（stdout，制表符分隔，供 `IFS=$'\t' read` 消费）：
  <UDID>\t<设备名>

退出码：1 表示没有可用设备（通常是 runner 镜像换了、运行时没装）。
"""

from __future__ import annotations  # macOS 自带 python3 是 3.9，`X | None` 注解需要它

import argparse
import json
import subprocess
import sys


def list_candidates() -> list[dict]:
    out = subprocess.run(
        ["xcrun", "simctl", "list", "devices", "available", "-j"],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(out)

    candidates = []
    for runtime, devices in (data.get("devices") or {}).items():
        if "iOS" not in runtime:
            continue
        for d in devices:
            if d.get("isAvailable"):
                candidates.append(d)
    return candidates


def pick(candidates: list[dict], want: str) -> dict | None:
    if want:
        return next((d for d in candidates if d.get("name") == want), None)
    return (
        next((d for d in candidates if d.get("name", "").startswith("iPhone")), None)
        or next((d for d in candidates if d.get("name", "").startswith("iPad")), None)
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--want", default="", help="精确指定机型名")
    ap.add_argument("--list", action="store_true", help="只列出候选机型，便于排查")
    args = ap.parse_args()

    try:
        candidates = list_candidates()
    except Exception as e:  # noqa: BLE001 - 抛到 CI 日志里比栈回溯更好读
        print(f"::error::读取模拟器列表失败: {e}")
        return 1

    if args.list:
        for d in candidates:
            print(f"{d['udid']}\t{d['name']}\t{d.get('state', '')}")
        return 0

    picked = pick(candidates, args.want)
    if not picked:
        names = ", ".join(sorted({d.get("name", "?") for d in candidates})) or "（无）"
        print(f"::error::找不到可用模拟器（want={args.want or 'auto'}）。候选：{names}")
        return 1

    print(f"{picked['udid']}\t{picked['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
