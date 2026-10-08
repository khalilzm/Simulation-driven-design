#!/usr/bin/env python3
"""人流/疏散：默认 JuPedSim egress。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from engine import ENGINE_ID, run


def check_deps() -> int:
    try:
        import jupedsim  # noqa: F401
        import pedpy  # noqa: F401
        import shapely  # noqa: F401
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"缺少依赖: {e}。请 pip install -r requirements.txt"}))
        return 1
    print(json.dumps({"ok": True, "jupedsim": True, "pedpy": True, "engine": ENGINE_ID}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="检查 Python 依赖")
    parser.add_argument("--strict-geometry", action="store_true", help="优化时拒绝丢弃不连通区域")
    parser.add_argument("--model", type=Path, help="model.json 路径")
    parser.add_argument("--config", type=Path, help="pedestrian.json 路径")
    parser.add_argument("--output", type=Path, help="输出目录")
    args = parser.parse_args()

    if args.check:
        return check_deps()

    if not args.model or not args.config or not args.output:
        print("model, config, output 必填", file=sys.stderr)
        return 2

    args.output.mkdir(parents=True, exist_ok=True)

    model = json.loads(args.model.read_text(encoding="utf-8"))
    config = json.loads(args.config.read_text(encoding="utf-8"))

    result = run(model, config, args.output, strict_geometry=args.strict_geometry)

    out_file = args.output / "result.json"
    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result.get("status") == "completed", "resultPath": str(out_file)}))
    return 0 if result.get("status") == "completed" else 3


if __name__ == "__main__":
    sys.exit(main())
