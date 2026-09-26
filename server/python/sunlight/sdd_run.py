#!/usr/bin/env python3
"""日照：默认 LB Direct Sun Hours；SDD_SUNLIGHT_USE_RADIANCE=1 时用 GH HB Direct Sun Hours recipe。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from lb_direct_sun import ENGINE_ID as LB_ENGINE_ID, run_honeybee_direct_sun


def check_deps() -> int:
    try:
        import ladybug  # noqa: F401
        import honeybee  # noqa: F401
        import honeybee_radiance  # noqa: F401
    except ImportError as e:
        print(json.dumps({"ok": False, "error": f"缺少依赖: {e}。请 pip install -r requirements.txt"}))
        return 1
    radiance = os.environ.get("SDD_SUNLIGHT_USE_RADIANCE") == "1"
    payload = {
        "ok": True,
        "ladybug": True,
        "honeybee_radiance": True,
        "defaultEngine": LB_ENGINE_ID,
        "radianceMode": radiance,
    }
    if radiance:
        import shutil

        payload["radianceOnPath"] = bool(shutil.which("rtrace"))
        try:
            import lbt_recipes  # noqa: F401

            payload["lbt_recipes"] = True
        except ImportError:
            payload["lbt_recipes"] = False
    print(json.dumps(payload))
    return 0


def _run(model: dict, config: dict, output_dir: Path) -> dict:
    use_radiance = os.environ.get("SDD_SUNLIGHT_USE_RADIANCE") == "1"
    if use_radiance:
        from radiance_engine import run_radiance_recipe

        return run_radiance_recipe(model, config, output_dir)
    return run_honeybee_direct_sun(model, config, output_dir)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="检查 Python 依赖")
    parser.add_argument("--model", type=Path, help="model.json 路径")
    parser.add_argument("--config", type=Path, help="sunlight.json 路径")
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

    result = _run(model, config, args.output)

    out_file = args.output / "result.json"
    out_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": result.get("status") == "completed", "resultPath": str(out_file)}))
    return 0 if result.get("status") == "completed" else 3


if __name__ == "__main__":
    sys.exit(main())
