"""Ladybug 太阳位置 + 三角网格射线遮挡（默认引擎，无需 Radiance）。"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Dict, List, Sequence, Tuple
from ladybug.dt import DateTime
from ladybug.location import Location
from ladybug.sunpath import Sunpath

from model_mesh import SensorPoint, Triangle, build_scene

Vec3 = Tuple[float, float, float]


def _sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


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
    start = datetime(y, m, d, sh, sm)
    end = datetime(y, m, d, eh, em)
    return start, end


def _sun_direction(sunpath: Sunpath, dt: DateTime) -> Vec3 | None:
    sun = sunpath.calculate_sun_from_date_time(dt)
    if sun.is_during_day is False:
        return None
    if sun.altitude <= 0:
        return None
    vec = sun.sun_vector
    return (float(vec.x), float(vec.y), float(vec.z))


def run_ladybug_rays(model: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    loc_cfg = config["location"]
    start_local, end_local = _parse_local_range(
        config["analysisDate"],
        config["localTimeRange"][0],
        config["localTimeRange"][1],
    )
    # DateTime 使用当地民用时；经纬度决定太阳位置。config.location.timezone 供记录与校验，不参与 Sunpath 偏移。
    location = Location(
        latitude=float(loc_cfg["latitude"]),
        longitude=float(loc_cfg["longitude"]),
        time_zone=0,
    )
    north = float(config.get("northDegrees", 0))
    sunpath = Sunpath.from_location(location, north_angle=north)

    triangles, sensors = build_scene(model, config)
    if not sensors:
        return _fail("无室内测点")

    step_min = int(config["timestepMinutes"])
    step = timedelta(minutes=step_min)

    sensor_hours = [0.0] * len(sensors)
    t = start_local
    steps = 0
    while t < end_local:
        # 当地太阳时 → Ladybug DateTime（带时区）
        dt = DateTime(t.month, t.day, t.hour, t.minute)
        sun_dir = _sun_direction(sunpath, dt)
        if sun_dir is not None:
            steps += 1
            for i, s in enumerate(sensors):
                origin = (s.x, s.y, s.z)
                blocked = False
                for tri in triangles:
                    hit = _ray_triangle(origin, sun_dir, tri)
                    if hit is not None:
                        blocked = True
                        break
                if not blocked:
                    sensor_hours[i] += step_min / 60.0
        t += step

    if steps == 0:
        return _fail("分析时段内无有效日照步长")

    return _package_results(sensors, sensor_hours, config, engine="ladybug-core-rays@1")


def _fail(msg: str) -> Dict[str, Any]:
    return {
        "schemaVersion": "1",
        "status": "failed",
        "engineVersion": "ladybug-core-rays@1",
        "error": msg,
        "metrics": {"unit": "hour", "sensorCount": 0, "targetAreaRatio": None},
        "spaces": [],
        "verification": {"status": "failed", "checks": [msg]},
    }


def _package_results(
    sensors: Sequence[SensorPoint],
    hours: Sequence[float],
    config: Dict[str, Any],
    engine: str,
) -> Dict[str, Any]:
    by_space: Dict[str, List[float]] = {}
    for s, h in zip(sensors, hours):
        by_space.setdefault(s.space_id, []).append(h)

    spaces_out = []
    for space_id, vals in sorted(by_space.items()):
        spaces_out.append(
            {
                "spaceId": space_id,
                "sensorCount": len(vals),
                "meanHours": sum(vals) / len(vals),
                "minHours": min(vals),
                "maxHours": max(vals),
                "targetMetRatio": None,
            }
        )

    target_checks = []
    targets = config.get("targets") or []
    met_ratios: List[float] = []
    for tgt in targets:
        min_h = float(tgt["minHours"])
        ids = tgt.get("spaceIds") or []
        worst_id = None
        worst_min = None
        all_met = True
        for sid in ids:
            vals = by_space.get(sid, [])
            if not vals:
                all_met = False
                continue
            smin = min(vals)
            if worst_min is None or smin < worst_min:
                worst_min = smin
                worst_id = sid
            if smin < min_h:
                all_met = False
            ratio = sum(1 for v in vals if v >= min_h) / len(vals)
            met_ratios.append(ratio)
            for row in spaces_out:
                if row["spaceId"] == sid:
                    row["targetMetRatio"] = ratio

        target_checks.append(
            {
                "spaceIds": ids,
                "minHours": min_h,
                "met": all_met,
                "worstSpaceId": worst_id,
                "worstMinHours": worst_min,
            }
        )

    target_area_ratio = sum(met_ratios) / len(met_ratios) if met_ratios else None
    verification_status = "passed"
    checks: List[str] = []
    if targets:
        if any(not t["met"] for t in target_checks):
            verification_status = "failed"
            checks.append("部分空间未满足日照目标")
        else:
            checks.append("全部目标空间满足 minHours")
    else:
        verification_status = "needs_review"
        checks.append("未配置 targets，仅输出指标")

    return {
        "schemaVersion": "1",
        "status": "completed",
        "engineVersion": engine,
        "metrics": {
            "unit": "hour",
            "sensorCount": len(sensors),
            "targetAreaRatio": target_area_ratio,
        },
        "spaces": spaces_out,
        "targets": target_checks if target_checks else None,
        "verification": {"status": verification_status, "checks": checks},
    }
