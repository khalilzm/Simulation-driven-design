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


def _point_on_segment(x: float, y: float, a: List[float], b: List[float], eps: float = 1e-8) -> bool:
    cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])
    if abs(cross) > eps * max(1.0, math.hypot(b[0] - a[0], b[1] - a[1])):
        return False
    return min(a[0], b[0]) - eps <= x <= max(a[0], b[0]) + eps and min(a[1], b[1]) - eps <= y <= max(a[1], b[1]) + eps


def _segments_intersect(a: List[float], b: List[float], c: List[float], d: List[float]) -> bool:
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    values = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b))
    proper = ((values[0] > 1e-8 and values[1] < -1e-8) or (values[0] < -1e-8 and values[1] > 1e-8)) and ((values[2] > 1e-8 and values[3] < -1e-8) or (values[2] < -1e-8 and values[3] > 1e-8))
    touching = any(abs(v) <= 1e-8 and _point_on_segment(p[0], p[1], q, r) for v, p, q, r in ((values[0], c, a, b), (values[1], d, a, b), (values[2], a, c, d), (values[3], b, c, d)))
    return proper or touching


def _cell_intersects_ring(x0: float, y0: float, x1: float, y1: float, ring: List[List[float]]) -> bool:
    corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    if any(_point_in_polygon(p[0], p[1], ring) or any(_point_on_segment(p[0], p[1], a, b) for a, b in zip(ring, ring[1:])) for p in corners):
        return True
    edges = list(zip(corners, corners[1:] + corners[:1]))
    return any(_segments_intersect(a, b, c, d) for a, b in edges for c, d in zip(ring, ring[1:]))


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
                    quad = [q0,q1,q2,q3]
                    thickness = float(wall.get("thickness",0)) if model.get("model",{}).get("residentialBrief") else 0
                    if thickness > 0:
                        nx,ny = -(y1-y0)/seg_len*thickness/2,(x1-x0)/seg_len*thickness/2
                        front = [(p[0]+nx,p[1]+ny,p[2]) for p in quad]
                        back = [(p[0]-nx,p[1]-ny,p[2]) for p in quad]
                        quads = [front,back]+[[front[j],front[(j+1)%4],back[(j+1)%4],back[j]] for j in range(4)]
                    else:
                        quads = [quad]
                    for surface in quads:
                        face = Face3D([Point3D(*p) for p in surface])
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

    unit_scale = 1000.0 if model.get("model", {}).get("units") == "mm" else 1.0
    spacing *= unit_scale
    sensor_z = elevation + ref_h * unit_scale
    if model.get("model", {}).get("residentialBrief"):
        grids = residential_sensor_grids(model, spacing, sensor_z, config)
    else:
        floor_face = _ring_to_face3d(floor["boundary"], sensor_z)
        grid = SensorGrid.from_face3d("grid-floor", [floor_face], spacing, None, 0, False)
        grid.room_identifier = "floor"
        grids = [grid]

    shades = _wall_shades(model, elevation, floor_h)
    if floor.get("topObstruction", False):
        top = _ring_to_face3d(floor["boundary"], elevation + floor_h)
        shades.append(Shade("roof-slab", top))

    hb = Model(model["model"]["revisionId"], [], orphaned_shades=shades)
    for g in grids:
        hb.properties.radiance.add_sensor_grid(g)
    return hb, grids


def residential_sensor_grids(model: Dict[str, Any], spacing: float, z: float, config=None) -> List[SensorGrid]:
    """Exact orthogonal room tiling, retaining edge area and excluding wall footprints."""
    from ladybug_geometry.geometry3d.mesh import Mesh3D
    from residential_sampling import sun_projection_bounds, subdivide_cell
    unit_scale = 1000 if model.get("model",{}).get("units")=="mm" else 1
    bounds = sun_projection_bounds(model,config) if config and not config.get('daylightMode') else []
    fine_step = min(spacing,(config.get('_residentialSampling',{}).get('fineStep',.1)*unit_scale)) if config else spacing
    grids = []
    total_faces = 0
    for index, space in enumerate(model.get("spaces", [])):
        ring = space["boundary"]
        xs, ys = [], []
        for axis, values in [(0,xs),(1,ys)]:
            low, high = min(p[axis] for p in ring), max(p[axis] for p in ring)
            values.extend(p[axis] for p in ring)
            value = low + spacing
            while value < high - 1e-8:
                values.append(value)
                value += spacing
            values[:] = sorted(set(round(v,8) for v in values))
        if len(xs)*len(ys)>100000:
            raise ValueError("住宅日照网格规模超出预算，请增大测点间距")
        vertices, faces = [], []
        for x0,x1 in zip(xs,xs[1:]):
            for y0,y1 in zip(ys,ys[1:]):
                if x1-x0<1e-8 or y1-y0<1e-8 or (not _point_in_polygon((x0+x1)/2,(y0+y1)/2,ring) and not _cell_intersects_ring(x0,y0,x1,y1,ring)):
                    continue
                cell_bounds = list(subdivide_cell(x0,y0,x1,y1,fine_step,bounds))
                if _cell_intersects_ring(x0,y0,x1,y1,ring) and any(abs(a[0]-b[0]) > 1e-7 and abs(a[1]-b[1]) > 1e-7 for a,b in zip(ring,ring[1:])):
                    cell_bounds = list(subdivide_cell(x0,y0,x1,y1,min(fine_step,0.1*unit_scale),bounds))
                for xx0,yy0,xx1,yy1 in cell_bounds:
                    if not _point_in_polygon((xx0+xx1)/2,(yy0+yy1)/2,ring):
                        continue
                    start = len(vertices)
                    vertices.extend([Point3D(xx0,yy0,z),Point3D(xx1,yy0,z),Point3D(xx1,yy1,z),Point3D(xx0,yy1,z)])
                    faces.append((start,start+1,start+2,start+3))
                    if len(faces)+total_faces>30000:
                        raise ValueError("自适应日照测点超过30000预算，无法确认采样精度")
        total_faces += len(faces)
        if total_faces>30000:
            raise ValueError("住宅日照测点总量超出预算，请增大测点间距")
        if not faces:
            continue
        grid = SensorGrid.from_mesh3d(f"grid-room-{index}",Mesh3D(tuple(vertices),tuple(faces)))
        grid.room_identifier = space["id"]
        grids.append(grid)
    return grids
