"""Honeybee 传感器网格 + Ladybug 太阳路径；遮挡几何来自 Honeybee Shade。"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from honeybee.model import Model
from grid_pack import make_legend, pack_grid_with_attribution, pack_grids_with_hours, grid_sensor_areas
from hb_build import build_honeybee_model, sensor_space_ids
from sunlight_metrics import package_results
from sunlight_time import sun_intervals

Vec3 = Tuple[float, float, float]
Triangle = Tuple[Vec3, Vec3, Vec3]

# LB Direct Sun Hours 同款太阳/遮挡逻辑（无 Radiance）；着色走 Ladybug Legend
ENGINE_ID = "ladybug-lb-direct-sun-hours@5"


def _shade_triangles(hb: Model) -> List[Triangle]:
    tris: List[Triangle] = []
    for shade in hb.orphaned_shades:
        face = shade.geometry
        pts = face.vertices
        if len(pts) < 3:
            continue
        base = [(p.x, p.y, p.z) for p in pts]
        for i in range(1, len(base) - 1):
            tris.append((base[0], base[i], base[i + 1]))
    return tris


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _ray_triangle(origin: Vec3, direction: Vec3, tri: Triangle, eps: float = 1e-8) -> float | None:
    v0, v1, v2 = tri
    edge1 = _sub(v1, v0)
    edge2 = _sub(v2, v0)
    pvec = _cross(direction, edge2)
    det = _dot(edge1, pvec)
    if abs(det) < eps:
        return None
    inv_det = 1.0 / det
    tvec = _sub(origin, v0)
    u = _dot(tvec, pvec) * inv_det
    if u < 0 or u > 1:
        return None
    qvec = _cross(tvec, edge1)
    v = _dot(direction, qvec) * inv_det
    if v < 0 or u + v > 1:
        return None
    t = _dot(edge2, qvec) * inv_det
    if t < eps:
        return None
    return t


def run_honeybee_direct_sun(
    model: Dict[str, Any],
    config: Dict[str, Any],
    output_dir: Any = None,
) -> Dict[str, Any]:
    try:
        intervals = list(sun_intervals(config))
    except ValueError as error:
        return _fail(str(error))
    hb, grids = build_honeybee_model(model, config)
    if not grids:
        return _fail("Honeybee 未生成任何 SensorGrid")

    residential = bool(model.get("model", {}).get("residentialBrief"))
    space_ids = [g.room_identifier for g in grids for _ in g.sensors] if residential else sensor_space_ids(model, grids[0].sensors)
    all_sensors = [(space_ids[i], "", sens.pos) for i,sens in enumerate(s for g in grids for s in g.sensors)]

    triangles = _shade_triangles(hb)
    hours: List[float] = [0.0] * len(all_sensors)
    for sun_dir, duration_hours in intervals:
        if sun_dir is not None:
            for i, (_sid, _gid, pos) in enumerate(all_sensors):
                origin = pos
                blocked = any(_ray_triangle(origin, sun_dir, tri) is not None for tri in triangles)
                if not blocked:
                    hours[i] += duration_hours

    legend, legend_par = make_legend(config)
    grid_exports = pack_grids_with_hours(grids,hours,legend_par) if residential else pack_grid_with_attribution(grids[0], space_ids, hours, legend_par)

    result = package_results(
        space_ids, hours, grid_sensor_areas(grids, model),
        config, ENGINE_ID, model.get("spaces", []),
    )
    result["legend"] = legend
    result["grids"] = grid_exports
    result["verification"]["checks"].insert(
        0,
        "计算：Ladybug Sunpath + 直射遮挡（与 LB Direct Sun Hours 同源，未走 Radiance）",
    )
    result["verification"]["checks"].append(
        "着色：Ladybug Legend.value_colors（Ecotect，与 GH 图例一致）"
    )
    if output_dir is not None:
        import json
        from pathlib import Path

        Path(output_dir).mkdir(parents=True, exist_ok=True)
        (Path(output_dir) / "honeybee_grids.json").write_text(
            json.dumps(grid_exports, ensure_ascii=False, indent=2),
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
