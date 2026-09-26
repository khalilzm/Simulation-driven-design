"""将 model.json 转为遮挡三角网格与室内测点（米制，Z 向上）。"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

Vec3 = Tuple[float, float, float]
Triangle = Tuple[Vec3, Vec3, Vec3]


@dataclass
class SensorPoint:
    space_id: str
    x: float
    y: float
    z: float


def _wall_segments(wall: Dict[str, Any]) -> List[Tuple[Vec3, Vec3]]:
    pts = wall["geometry"]["points"]
    out: List[Tuple[Vec3, Vec3]] = []
    for i in range(len(pts) - 1):
        x0, y0 = float(pts[i][0]), float(pts[i][1])
        x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
        out.append(((x0, y0), (x1, y1)))
    return out


def _segment_length(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _point_in_polygon(x: float, y: float, ring: Sequence[Sequence[float]]) -> bool:
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


def _grid_points_in_polygon(
    ring: Sequence[Sequence[float]],
    z: float,
    spacing: float,
) -> List[Tuple[float, float, float]]:
    xs = [float(p[0]) for p in ring]
    ys = [float(p[1]) for p in ring]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    pts: List[Tuple[float, float, float]] = []
    x = xmin + spacing * 0.5
    while x <= xmax:
        y = ymin + spacing * 0.5
        while y <= ymax:
            if _point_in_polygon(x, y, ring):
                pts.append((x, y, z))
            y += spacing
        x += spacing
    if not pts:
        cx = sum(xs) / len(xs)
        cy = sum(ys) / len(ys)
        pts.append((cx, cy, z))
    return pts


def _add_wall_quad(
    triangles: List[Triangle],
    p0: Tuple[float, float],
    p1: Tuple[float, float],
    z0: float,
    z1: float,
) -> None:
    x0, y0 = p0
    x1, y1 = p1
    a = (x0, y0, z0)
    b = (x1, y1, z0)
    c = (x1, y1, z1)
    d = (x0, y0, z1)
    triangles.append((a, b, c))
    triangles.append((a, c, d))


def _opaque_intervals_on_wall(
    total_len: float,
    windows: List[Tuple[float, float]],
) -> List[Tuple[float, float]]:
    """返回墙长方向上仍不透明的区间（排除窗洞平面，整高开窗）。"""
    windows = sorted(windows, key=lambda w: w[0])
    merged: List[Tuple[float, float]] = []
    for start, end in windows:
        if not merged or start > merged[-1][1]:
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
    opaque: List[Tuple[float, float]] = []
    cursor = 0.0
    for start, end in merged:
        if start > cursor:
            opaque.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < total_len:
        opaque.append((cursor, total_len))
    return opaque


def build_scene(
    model: Dict[str, Any],
    config: Dict[str, Any],
) -> Tuple[List[Triangle], List[SensorPoint]]:
    floor = model["floor"]
    elevation = float(floor.get("elevation", 0))
    floor_height = float(floor.get("height", 3))
    top_z = elevation + floor_height

    window_opening_ids = {w["openingId"] for w in model.get("windows", [])}
    openings_by_wall: Dict[str, List[Dict[str, Any]]] = {}
    for op in model.get("openings", []):
        if op.get("id") not in window_opening_ids:
            continue
        openings_by_wall.setdefault(op["hostWallId"], []).append(op)

    triangles: List[Triangle] = []

    for wall in model.get("walls", []):
        z0 = elevation
        z1 = elevation + float(wall.get("height", floor_height))
        segs = _wall_segments(wall)
        seg_lengths = [_segment_length(p0, p1) for p0, p1 in segs]
        total_len = sum(seg_lengths)
        win_ranges = [
            (float(op["position"]), float(op["position"]) + float(op["width"]))
            for op in openings_by_wall.get(wall["id"], [])
        ]
        opaque_global = _opaque_intervals_on_wall(total_len, win_ranges)

        cumulative = 0.0
        for (p0, p1), seg_len in zip(segs, seg_lengths):
            seg_start = cumulative
            seg_end = cumulative + seg_len
            for g0, g1 in opaque_global:
                if g1 <= seg_start or g0 >= seg_end:
                    continue
                local_a = max(g0, seg_start) - seg_start
                local_b = min(g1, seg_end) - seg_start
                if local_b - local_a < 1e-6:
                    continue
                t0 = local_a / seg_len if seg_len > 0 else 0
                t1 = local_b / seg_len if seg_len > 0 else 0
                q0 = (
                    p0[0] + (p1[0] - p0[0]) * t0,
                    p0[1] + (p1[1] - p0[1]) * t0,
                )
                q1 = (
                    p0[0] + (p1[0] - p0[0]) * t1,
                    p0[1] + (p1[1] - p0[1]) * t1,
                )
                _add_wall_quad(triangles, q0, q1, z0, z1)
            cumulative += seg_len

    if floor.get("topObstruction", False):
        ring = floor["boundary"]
        if len(ring) >= 3:
            for i in range(1, len(ring) - 1):
                p0 = (float(ring[0][0]), float(ring[0][1]), top_z)
                p1 = (float(ring[i][0]), float(ring[i][1]), top_z)
                p2 = (float(ring[i + 1][0]), float(ring[i + 1][1]), top_z)
                triangles.append((p0, p1, p2))

    for item in model.get("externalContext", []):
        pts = item.get("geometry", {}).get("points", [])
        for i in range(len(pts) - 1):
            p0 = (float(pts[i][0]), float(pts[i][1]))
            p1 = (float(pts[i + 1][0]), float(pts[i + 1][1]))
            _add_wall_quad(triangles, p0, p1, elevation, elevation + floor_height)

    ref_h = float(config["sensors"]["referenceHeightAboveFloor"])
    spacing = float(config["sensors"]["gridSpacing"])
    sensor_z = elevation + ref_h
    sensors: List[SensorPoint] = []
    for space in model.get("spaces", []):
        ring = space["boundary"]
        for x, y, z in _grid_points_in_polygon(ring, sensor_z, spacing):
            sensors.append(SensorPoint(space_id=space["id"], x=x, y=y, z=z))

    return triangles, sensors
