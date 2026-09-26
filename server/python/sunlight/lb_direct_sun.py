"""Honeybee 传感器网格 + Ladybug 太阳路径；遮挡几何来自 Honeybee Shade。"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Sequence, Tuple

from honeybee.model import Model
from honeybee_radiance.sensorgrid import SensorGrid
from ladybug.dt import DateTime
from ladybug.location import Location
from ladybug.sunpath import Sunpath
from ladybug_geometry.geometry3d.pointvector import Point3D

from grid_pack import make_legend, pack_grids_with_hours
from hb_build import build_honeybee_model

Vec3 = Tuple[float, float, float]
Triangle = Tuple[Vec3, Vec3, Vec3]

# LB Direct Sun Hours 同款太阳/遮挡逻辑（无 Radiance）；着色走 Ladybug Legend
ENGINE_ID = "ladybug-lb-direct-sun-hours@2"


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


def _parse_local_range(date_str: str, start_hm: str, end_hm: str) -> Tuple[datetime, datetime]:
    y, m, d = (int(x) for x in date_str.split("-"))
    sh, sm = (int(x) for x in start_hm.split(":"))
    eh, em = (int(x) for x in end_hm.split(":"))
    return datetime(y, m, d, sh, sm), datetime(y, m, d, eh, em)


def _sun_direction(sunpath: Sunpath, dt: DateTime) -> Vec3 | None:
    sun = sunpath.calculate_sun_from_date_time(dt)
    if sun.is_during_day is False or sun.altitude <= 0:
        return None
    vec = sun.sun_vector
    return (float(vec.x), float(vec.y), float(vec.z))


def run_honeybee_direct_sun(
    model: Dict[str, Any],
    config: Dict[str, Any],
    output_dir: Any = None,
) -> Dict[str, Any]:
    hb, grids = build_honeybee_model(model, config)
    if not grids:
        return _fail("Honeybee 未生成任何 SensorGrid")

    all_sensors: List[Tuple[str, str, Vec3]] = []
    for grid in grids:
        sid = grid.room_identifier or ""
        for sens in grid.sensors:
            all_sensors.append((sid, grid.identifier, sens.pos))

    triangles = _shade_triangles(hb)
    loc_cfg = config["location"]
    location = Location(
        latitude=float(loc_cfg["latitude"]),
        longitude=float(loc_cfg["longitude"]),
        time_zone=0,
    )
    north = float(config.get("northDegrees", 0))
    sunpath = Sunpath.from_location(location, north_angle=north)

    start_local, end_local = _parse_local_range(
        config["analysisDate"],
        config["localTimeRange"][0],
        config["localTimeRange"][1],
    )
    step_min = int(config["timestepMinutes"])
    step = timedelta(minutes=step_min)

    hours: List[float] = [0.0] * len(all_sensors)
    t = start_local
    while t < end_local:
        dt = DateTime(t.month, t.day, t.hour, t.minute)
        sun_dir = _sun_direction(sunpath, dt)
        if sun_dir is not None:
            for i, (_sid, _gid, pos) in enumerate(all_sensors):
                origin = pos
                blocked = any(_ray_triangle(origin, sun_dir, tri) is not None for tri in triangles)
                if not blocked:
                    hours[i] += step_min / 60.0
        t += step

    legend, legend_par = make_legend(config)
    grid_exports = pack_grids_with_hours(grids, hours, legend_par)

    from ray_engine import _package_results  # 空间汇总与 targets 校验

    sensor_points = [
        type("S", (), {"space_id": sid, "x": pos[0], "y": pos[1], "z": pos[2]})()
        for sid, _gid, pos in all_sensors
    ]
    result = _package_results(sensor_points, hours, config, ENGINE_ID)
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
