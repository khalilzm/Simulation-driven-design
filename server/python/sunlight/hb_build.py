"""由 model.json 构建 Honeybee Model 与 Ladybug/Honeybee 传感器网格。"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Sequence, Tuple

from honeybee.model import Model
from honeybee.shade import Shade
from honeybee_radiance.sensorgrid import SensorGrid
from ladybug_geometry.geometry3d.face import Face3D
from ladybug_geometry.geometry3d.pointvector import Point3D, Vector3D


def _ring_to_face3d(ring: List[List[float]], z: float) -> Face3D:
    pts = [Point3D(float(p[0]), float(p[1]), z) for p in ring[:-1] if len(p) >= 2]
    if len(pts) < 3:
        raise ValueError("多边形顶点不足")
    face = Face3D(pts)
    # 水平采样面始终朝上；旧模型和图片 Y 轴翻转后的边界可能为顺时针。
    # Radiance 沿面法向生成测点，朝下会让白天直射日照全部变成零。
    return face.flip() if face.normal.z < 0 else face


OPEN_SPACE_ID = "open"


def _point_in_polygon(x: float, y: float, ring: List[List[float]]) -> bool:
    inside = False
    n = len(ring)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = float(ring[i][0]), float(ring[i][1])
        xj, yj = float(ring[j][0]), float(ring[j][1])
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def sensor_space_ids(model: Dict[str, Any], sensors: Sequence[Any]) -> List[str]:
    """每个传感器归到包含它的 space；不在任何 space 内则归为开放区域。"""
    spaces = model.get("spaces", [])
    ids: List[str] = []
    for sens in sensors:
        x, y = float(sens.pos[0]), float(sens.pos[1])
        sid = OPEN_SPACE_ID
        for space in spaces:
            if _point_in_polygon(x, y, space["boundary"]):
                sid = space["id"]
                break
        ids.append(sid)
    return ids


def _wall_shades(model: Dict[str, Any], elevation: float, floor_h: float) -> List[Shade]:
    door_ops = {d["openingId"] for d in model.get("doors", [])}
    shades: List[Shade] = []
    for wall in model.get("walls", []):
        pts = wall["geometry"]["points"]
        wh = float(wall.get("height", floor_h))
        z0 = elevation
        # 透光洞口：窗 + 过道（凡不是门的开口）；门保持不透明遮挡。
        transparent_ops = [
            op
            for op in model.get("openings", [])
            if op["hostWallId"] == wall["id"] and op.get("id") not in door_ops
        ]
        cumulative = 0.0
        for i in range(len(pts) - 1):
            x0, y0 = float(pts[i][0]), float(pts[i][1])
            x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
            seg_len = math.hypot(x1 - x0, y1 - y0)
            if seg_len < 1e-6:
                continue
            cuts = []
            for op in transparent_ops:
                pos = float(op["position"]) - cumulative
                w = float(op["width"])
                a = max(0.0, pos - w / 2)
                b = min(seg_len, pos + w / 2)
                sill = float(op.get("sillHeight", 0))
                bottom = max(0.0, sill)
                top = min(wh, sill + float(op["height"]))
                if b <= a or top <= bottom:
                    continue
                cuts.append((a, b, bottom, top))
            cumulative += seg_len
            # 沿窗底、窗顶分层，保留窗下墙与过梁；每层只扣除该高度的窗洞。
            levels = sorted({0.0, wh, *(z for _, _, bottom, top in cuts for z in (bottom, top))})
            for bottom, top in zip(levels, levels[1:]):
                opaque = [(0.0, seg_len)]
                for a, b, low, high in cuts:
                    if low < top and high > bottom:
                        opaque = _subtract_interval(opaque, a, b)
                for a, b in opaque:
                    if b - a < 1e-6:
                        continue
                    t0, t1 = a / seg_len, b / seg_len
                    q0 = (x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, z0 + bottom)
                    q1 = (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, z0 + bottom)
                    q2 = (q1[0], q1[1], z0 + top)
                    q3 = (q0[0], q0[1], z0 + top)
                    face = Face3D([Point3D(*q0), Point3D(*q1), Point3D(*q2), Point3D(*q3)])
                    shades.append(Shade(f"shade-{wall['id']}-{len(shades)}", face))
    for item in model.get("externalContext", []):
        pts = item.get("geometry", {}).get("points", [])
        for i in range(len(pts) - 1):
            x0, y0 = float(pts[i][0]), float(pts[i][1])
            x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
            face = Face3D(
                [
                    Point3D(x0, y0, elevation),
                    Point3D(x1, y1, elevation),
                    Point3D(x1, y1, elevation + floor_h),
                    Point3D(x0, y0, elevation + floor_h),
                ]
            )
            shades.append(Shade(f"ctx-{len(shades)}", face))
    return shades


def _subtract_interval(segments: List[Tuple[float, float]], a: float, b: float) -> List[Tuple[float, float]]:
    out: List[Tuple[float, float]] = []
    for s0, s1 in segments:
        if b <= s0 or a >= s1:
            out.append((s0, s1))
            continue
        if a > s0:
            out.append((s0, a))
        if b < s1:
            out.append((b, s1))
    return out


def build_honeybee_model(model: Dict[str, Any], config: Dict[str, Any]) -> Tuple[Model, List[SensorGrid]]:
    floor = model["floor"]
    elevation = float(floor.get("elevation", 0))
    floor_h = float(floor.get("height", 3))
    spacing = float(config["sensors"]["gridSpacing"])
    ref_h = float(config["sensors"]["referenceHeightAboveFloor"])
    sensor_z = elevation + ref_h

    # 整块楼板布点（含开放区域），传感器再按所属空间归属，避免开放区出现空洞。
    floor_face = _ring_to_face3d(floor["boundary"], sensor_z)
    grid = SensorGrid.from_face3d("grid-floor", [floor_face], spacing, None, 0, False)
    grid.room_identifier = "floor"
    grids: List[SensorGrid] = [grid]

    shades = _wall_shades(model, elevation, floor_h)
    if floor.get("topObstruction", False):
        top = _ring_to_face3d(floor["boundary"], elevation + floor_h)
        shades.append(Shade("roof-slab", top))

    hb = Model(model["model"]["revisionId"], [], orphaned_shades=shades)
    for g in grids:
        hb.properties.radiance.add_sensor_grid(g)
    return hb, grids
