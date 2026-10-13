"""Grasshopper「HB Direct Sun Hours」：lbt-recipes direct-sun-hours + Radiance (ab=0)。"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict, List

from hb_build import build_honeybee_model, sensor_space_ids
from grid_pack import make_legend, pack_grid_with_attribution, pack_grids_with_hours, grid_sensor_areas
from sunlight_metrics import package_results
from wea_from_config import build_wea

ENGINE_ID = "lbt-direct-sun-hours@4"


def _radiance_on_path() -> bool:
    return shutil.which("rtrace") is not None and shutil.which("oconv") is not None


def _configure_honeybee_radiance() -> None:
    """让 honeybee_radiance / lbt-recipes 识别 vendor 或环境变量中的 Radiance。"""
    import os

    from honeybee_radiance.config import folders as rad_folders

    if rad_folders.radiance_path:
        return
    for key in ("SDD_RADIANCE_PATH", "RADIANCE_PATH"):
        root = os.environ.get(key, "").strip()
        if root:
            rad_folders.radiance_path = root
            return
    bundled = Path(__file__).resolve().parent / "vendor" / "radiance" / "radiance"
    if (bundled / "bin" / "rtrace").is_file():
        rad_folders.radiance_path = str(bundled)


def run_radiance_recipe(model: Dict[str, Any], config: Dict[str, Any], output_dir: Path) -> Dict[str, Any]:
    _configure_honeybee_radiance()
    if not _radiance_on_path():
        return _fail(
            "未找到 Radiance（rtrace/oconv）。请安装 Radiance 并加入 PATH，"
            "或取消 SDD_SUNLIGHT_USE_RADIANCE 使用 LB 直射算法。"
        )
    try:
        from lbt_recipes.recipe import Recipe
        from lbt_recipes.settings import RecipeSettings
    except ImportError:
        return _fail(
            "未安装 lbt-recipes。GH 一致模式请: pip install lbt-recipes "
            "(建议 Python 3.10+ 虚拟环境)，并安装 Radiance。"
        )

    hb, grids = build_honeybee_model(model, config)
    if not grids:
        return _fail("Honeybee 未生成任何 SensorGrid")

    try:
        wea = build_wea(config)
    except ValueError as e:
        return _fail(str(e))

    recipe = Recipe("direct-sun-hours")
    recipe.input_value_by_name("model", hb)
    recipe.input_value_by_name("wea", wea)
    step_min = int(config["timestepMinutes"])
    if step_min <= 0 or 60 % step_min != 0:
        return _fail("timestepMinutes 须为 60 的整除因子（如 60、30、15）")
    recipe.input_value_by_name("timestep", 60 // step_min)
    recipe.input_value_by_name("north", float(config.get("northDegrees", 0)))

    work = output_dir / "direct-sun-hours-recipe"
    work.mkdir(parents=True, exist_ok=True)
    settings = RecipeSettings(folder=str(work), workers=1)
    try:
        project_folder = recipe.run(
            settings=settings, radiance_check=True, silent=True
        )
    except Exception as e:
        return _fail(f"direct-sun-hours recipe 运行失败: {e}")

    try:
        hours_merged = recipe.output_value_by_name("cumulative-sun-hours", project_folder)
    except Exception as e:
        return _fail(f"读取 cumulative-sun-hours 失败: {e}")

    # 展平为与 grids.sensors 相同顺序（recipe 按 grid 输出）
    flat: List[float] = []
    if isinstance(hours_merged, dict):
        for grid in grids:
            key = grid.identifier
            vals = hours_merged.get(key) or hours_merged.get(grid.full_identifier)
            if vals is None:
                for k, v in hours_merged.items():
                    if key in k or grid.identifier in k:
                        vals = v
                        break
            if vals is None:
                return _fail(f"recipe 结果中缺少网格 {grid.identifier}")
            flat.extend([float(x) for x in vals])
    elif isinstance(hours_merged, (list, tuple)):
        for item in hours_merged:
            if isinstance(item, (list, tuple)):
                flat.extend(float(x) for x in item)
            else:
                flat.append(float(item))
    else:
        return _fail("无法解析 cumulative-sun-hours 结果格式")

    expected = sum(len(g.sensors) for g in grids)
    if len(flat) != expected:
        return _fail(f"传感器数不一致: recipe {len(flat)} vs 模型 {expected}")

    legend, legend_par = make_legend(config)
    grid = grids[0]
    residential = bool(model.get("model", {}).get("residentialBrief"))
    space_ids = [g.room_identifier for g in grids for _ in g.sensors] if residential else sensor_space_ids(model, grid.sensors)
    grid_exports = pack_grids_with_hours(grids,flat,legend_par) if residential else pack_grid_with_attribution(grid, space_ids, flat, legend_par)

    result = package_results(
        space_ids, flat, grid_sensor_areas(grids, model), config, ENGINE_ID, model.get("spaces", []),
    )
    result["legend"] = legend
    result["grids"] = grid_exports
    result["verification"]["checks"].insert(
        0,
        "计算：Grasshopper HB Direct Sun Hours（lbt-recipes + Radiance ab=0）",
    )
    result["verification"]["checks"].append(
        "着色：Ladybug Legend.value_colors（Ecotect，与 GH 图例一致）"
    )
    (output_dir / "honeybee_grids.json").write_text(
        __import__("json").dumps(grid_exports, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return result


def _fail(msg: str) -> Dict[str, Any]:
    return {
        "schemaVersion": "1",
        "status": "failed",
        "engineVersion": ENGINE_ID,
        "error": msg,
        "metrics": {"unit": "hour", "sensorCount": 0, "targetAreaRatio": None},
        "spaces": [],
        "grids": [],
        "verification": {"status": "failed", "checks": [msg]},
    }
