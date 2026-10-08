"""人流/疏散引擎：由 model.json 构建 walkable 几何，跑 JuPedSim egress，产出结果指标。"""

from __future__ import annotations

import math
import random
from typing import Any, Dict, List, Tuple

from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

EPS = 1e-6
ENGINE_ID = "jupedsim-1.4"


def _ring_polygon(ring: List[List[float]]) -> Polygon:
    pts = [(float(p[0]), float(p[1])) for p in ring]
    if len(pts) < 3:
        raise ValueError("多边形顶点不足")
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    return Polygon(pts)


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


def _wall_obstacles(model: Dict[str, Any]) -> List[Polygon]:
    """墙体中心线按厚度 buffer，扣除门洞 gap；门洞可通行，窗洞不可。"""
    door_ops = {d["openingId"] for d in model.get("doors", [])}
    obstacles: List[Polygon] = []
    for wall in model.get("walls", []):
        pts = wall["geometry"]["points"]
        thickness = float(wall.get("thickness", 0.12))
        gaps: List[Tuple[float, float]] = []
        for op in model.get("openings", []):
            if op.get("hostWallId") == wall["id"] and op.get("id") in door_ops:
                pos = float(op["position"])
                w = float(op["width"])
                gaps.append((pos - w / 2, pos + w / 2))
        gaps.sort()
        cumulative = 0.0
        for i in range(len(pts) - 1):
            x0, y0 = float(pts[i][0]), float(pts[i][1])
            x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
            seg_len = math.hypot(x1 - x0, y1 - y0)
            if seg_len < EPS:
                continue
            seg_start = cumulative
            seg_end = cumulative + seg_len
            intervals = [(seg_start, seg_end)]
            for g0, g1 in gaps:
                intervals = _subtract_interval(intervals, g0, g1)
            for a, b in intervals:
                if b - a < EPS:
                    continue
                t0 = (a - seg_start) / seg_len
                t1 = (b - seg_start) / seg_len
                line = LineString([
                    (x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0),
                    (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1),
                ])
                obstacles.append(line.buffer(thickness / 2))
        cumulative = seg_end
    return obstacles


def _door_center(model: Dict[str, Any], op: Dict[str, Any]) -> Tuple[float, float] | None:
    wall = next((w for w in model.get("walls", []) if w["id"] == op.get("hostWallId")), None)
    if wall is None:
        return None
    pts = wall["geometry"]["points"]
    target = float(op["position"])
    cumulative = 0.0
    for i in range(len(pts) - 1):
        x0, y0 = float(pts[i][0]), float(pts[i][1])
        x1, y1 = float(pts[i + 1][0]), float(pts[i + 1][1])
        seg_len = math.hypot(x1 - x0, y1 - y0)
        if target <= cumulative + seg_len + EPS:
            t = (target - cumulative) / seg_len if seg_len > EPS else 0.0
            return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
        cumulative += seg_len
    return None


def build_geometry(model: Dict[str, Any], strict: bool = False) -> Tuple[Polygon, List[Dict[str, Any]], List[Dict[str, Any]]]:
    """返回 (walkable, exits, spaces)。exits = 外墙门洞；spaces 供密度采样。"""
    floor = _ring_polygon(model["floor"]["boundary"])
    obstacles = _wall_obstacles(model)
    walkable = floor.difference(unary_union(obstacles)) if obstacles else floor
    if strict and (walkable.geom_type != "Polygon" or walkable.is_empty or not walkable.is_valid):
        raise ValueError("优化要求可行走区域有效且连通；不能丢弃断开的区域，请检查门洞与墙连接")
    if walkable.geom_type == "MultiPolygon":
        walkable = max(walkable.geoms, key=lambda g: g.area)

    centroid = walkable.centroid
    door_ops = {d["openingId"] for d in model.get("doors", [])}
    exits: List[Dict[str, Any]] = []
    for op in model.get("openings", []):
        if op.get("id") not in door_ops:
            continue
        center = _door_center(model, op)
        if center is None:
            continue
        # 外墙门洞：门中心落在楼板边界上（距边界 < 2*墙厚量级）。
        d = floor.boundary.distance(Point(*center))
        thickness = next(
            (float(w.get("thickness", 0.12)) for w in model.get("walls", []) if w["id"] == op.get("hostWallId")),
            0.12,
        )
        if d > max(thickness, 0.2):
            continue
        # 外向法向 = 门中心 - 楼板质心；切向沿墙。出口多边形须落在 walkable 内，故向内延伸。
        nx, ny = center[0] - centroid.x, center[1] - centroid.y
        norm = math.hypot(nx, ny) or 1.0
        n = (nx / norm, ny / norm)
        t = (-n[1], n[0])
        in_dir = (-n[0], -n[1])
        w = float(op["width"])
        hw = w / 2
        inset = 0.05
        depth = 0.4
        base = (center[0] + inset * in_dir[0], center[1] + inset * in_dir[1])
        poly = Polygon([
            (base[0] - hw * t[0], base[1] - hw * t[1]),
            (base[0] + hw * t[0], base[1] + hw * t[1]),
            (base[0] + hw * t[0] + depth * in_dir[0], base[1] + hw * t[1] + depth * in_dir[1]),
            (base[0] - hw * t[0] + depth * in_dir[0], base[1] - hw * t[1] + depth * in_dir[1]),
        ])
        exits.append({"exitId": f"exit-{len(exits) + 1}", "openingId": op["id"], "center": center, "polygon": poly})

    spaces = [{"id": s["id"], "polygon": _ring_polygon(s["boundary"])} for s in model.get("spaces", [])]
    return walkable, exits, spaces


def _sample_points(poly: Polygon, n: int, rng: random.Random, min_sep: float = 0.4, inset: float = 0.25) -> List[Tuple[float, float]]:
    region = poly.buffer(-inset)
    if region.is_empty or region.area <= 1e-6:
        region = poly
    pts: List[Tuple[float, float]] = []
    minx, miny, maxx, maxy = region.bounds
    attempts = 0
    while len(pts) < n and attempts < n * 2000:
        x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
        p = Point(x, y)
        if region.contains(p) and all(p.distance(Point(q)) >= min_sep for q in pts):
            pts.append((x, y))
        attempts += 1
    rp = region.representative_point()
    while len(pts) < n:
        pts.append((rp.x + rng.uniform(-0.05, 0.05), rp.y + rng.uniform(-0.05, 0.05)))
    return pts


def _grid_cells(walkable: Polygon, spacing: float) -> List[Dict[str, Any]]:
    minx, miny, maxx, maxy = walkable.bounds
    cols = max(1, int(math.ceil((maxx - minx) / spacing)))
    rows = max(1, int(math.ceil((maxy - miny) / spacing)))
    cells: List[Dict[str, Any]] = []
    for r in range(rows):
        for c in range(cols):
            x0 = minx + c * spacing
            y0 = miny + r * spacing
            x1 = min(x0 + spacing, maxx)
            y1 = min(y0 + spacing, maxy)
            rect = Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])
            eff = rect.intersection(walkable)
            if eff.is_empty or eff.area <= 1e-6:
                continue
            cells.append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "eff": eff, "peak": 0.0})
    return cells


def _density_grid_mesh(cells: List[Dict[str, Any]]) -> Dict[str, Any]:
    vertices: List[List[float]] = []
    faces: List[List[int]] = []
    density: List[float] = []
    for cell in cells:
        x0, y0, x1, y1 = cell["x0"], cell["y0"], cell["x1"], cell["y1"]
        base = len(vertices)
        vertices.append([x0, y0])
        vertices.append([x1, y0])
        vertices.append([x1, y1])
        vertices.append([x0, y1])
        faces.append([base, base + 1, base + 2])
        faces.append([base, base + 2, base + 3])
        d = round(cell["peak"], 3)
        density.append(d)
        density.append(d)
    return {"gridId": "density", "vertices": vertices, "faces": faces, "density": density}


def run(model: Dict[str, Any], config: Dict[str, Any], output_dir: Any, strict_geometry: bool = False) -> Dict[str, Any]:
    import jupedsim as jps

    walkable, exits, spaces = build_geometry(model, strict_geometry)
    if not exits:
        return _failed("未找到连接室外的出口（外墙门洞）")

    rng = random.Random(int(config.get("seed", 1)))
    space_by_id = {s["id"]: s for s in spaces}
    spawn: List[Tuple[float, float, str]] = []
    for load in config.get("agents", []):
        sid = load["spaceId"]
        if sid not in space_by_id:
            return _failed(f"agents 引用了不存在的空间 {sid}")
        region = space_by_id[sid]["polygon"].intersection(walkable)
        if region.is_empty:
            return _failed(f"空间 {sid} 无可通行区域")
        for x, y in _sample_points(region, int(load["count"]), rng):
            spawn.append((x, y, sid))

    model_name = config.get("model", "collision-free")
    sim_model = jps.GeneralizedCentrifugalForceModel() if model_name == "gcfm" else jps.CollisionFreeSpeedModel()
    dt = float(config.get("dt", 0.05))
    max_dur = float(config.get("maxDurationSec", 300))
    sim = jps.Simulation(dt=dt, model=sim_model, geometry=walkable)

    exit_stage = {}
    for ex in exits:
        exit_stage[ex["exitId"]] = sim.add_exit_stage(ex["polygon"])

    agent_exit: Dict[int, str] = {}
    agent_space: Dict[int, str] = {}
    agent_by_exit: Dict[str, List[int]] = {ex["exitId"]: [] for ex in exits}
    for x, y, sid in spawn:
        target = min(exits, key=lambda e: (e["center"][0] - x) ** 2 + (e["center"][1] - y) ** 2)
        eid = exit_stage[target["exitId"]]
        wp = sim.add_waypoint_stage((x, y), distance=0.01)
        journey = jps.JourneyDescription([wp, eid])
        journey.set_transition_for_stage(wp, jps.Transition.create_fixed_transition(eid))
        jid = sim.add_journey(journey)
        aid = sim.add_agent(jps.CollisionFreeSpeedModelAgentParameters(position=(x, y), journey_id=jid, stage_id=wp))
        agent_exit[aid] = target["exitId"]
        agent_space[aid] = sid
        agent_by_exit[target["exitId"]].append(aid)

    total = len(spawn)
    removed_at: Dict[int, float] = {}
    accounted: set[int] = set()
    arrival_by_exit: Dict[str, List[float]] = {ex["exitId"]: [] for ex in exits}

    # 轨迹（时间 0 起点）与密度网格。
    traj_times: Dict[int, List[float]] = {}
    traj_points: Dict[int, List[Tuple[float, float]]] = {}
    for a in sim.agents():
        traj_times[a.id] = [0.0]
        traj_points[a.id] = [tuple(a.position)]
    bb = walkable.bounds
    grid_spacing = max(0.5, min(bb[2] - bb[0], bb[3] - bb[1]) / 40)
    cells = _grid_cells(walkable, grid_spacing)

    # 密度采样：每 0.5s 统计各空间与出口缓冲区人数，用于瓶颈/峰值密度。
    space_area = {s["id"]: s["polygon"].area for s in spaces}
    space_peak: Dict[str, float] = {s["id"]: 0.0 for s in spaces}
    exit_peak: Dict[str, float] = {ex["exitId"]: 0.0 for ex in exits}
    exit_area = {ex["exitId"]: ex["polygon"].area for ex in exits}
    sample_every = 0.5
    next_sample = sample_every

    while sim.agent_count() > 0 and sim.elapsed_time() < max_dur:
        sim.iterate()
        now = sim.elapsed_time()
        for aid in sim.removed_agents():
            if aid in accounted:
                continue
            accounted.add(aid)
            removed_at[aid] = now
            arrival_by_exit[agent_exit[aid]].append(now)
            exit_center = next(e["center"] for e in exits if e["exitId"] == agent_exit[aid])
            traj_times[aid].append(now)
            traj_points[aid].append((exit_center[0], exit_center[1]))
        if now >= next_sample:
            next_sample += sample_every
            pos = {a.id: a.position for a in sim.agents()}
            for aid, p in pos.items():
                traj_times[aid].append(now)
                traj_points[aid].append((p[0], p[1]))
            for cell in cells:
                cnt = sum(1 for p in pos.values() if cell["eff"].contains(Point(p[0], p[1])))
                cell["peak"] = max(cell["peak"], cnt / cell["eff"].area)
            for s in spaces:
                cnt = sum(1 for (_, p) in pos.items() if s["polygon"].contains(Point(p[0], p[1])))
                dens = cnt / max(space_area[s["id"]], 1e-6)
                space_peak[s["id"]] = max(space_peak[s["id"]], dens)
            for ex in exits:
                cnt = sum(1 for aid in agent_by_exit[ex["exitId"]] if aid not in accounted and Point(pos[aid]).within(ex["polygon"]))
                exit_peak[ex["exitId"]] = max(exit_peak[ex["exitId"]], cnt / max(exit_area[ex["exitId"]], 1e-6))

    egress_time = sim.elapsed_time() if sim.agent_count() == 0 else None
    egress_times = list(removed_at.values())
    mean_egress = sum(egress_times) / len(egress_times) if egress_times else None

    peak_door: List[Dict[str, Any]] = []
    for ex in exits:
        arr = arrival_by_exit[ex["exitId"]]
        if len(arr) >= 2:
            flow = len(arr) / max(arr[-1] - arr[0], 1e-6)
        else:
            flow = len(arr) / max(egress_time or 1.0, 1e-6)
        peak_door.append({"exitId": ex["exitId"], "peakDensity": round(exit_peak[ex["exitId"]], 3), "flowRate": round(flow, 3)})

    bottleneck = [sid for sid, dens in space_peak.items() if dens >= 1.5]

    trajectories = [
        {"agentId": aid, "spaceId": agent_space[aid], "times": traj_times[aid], "points": traj_points[aid]}
        for aid in sorted(agent_space)
    ]

    return {
        "schemaVersion": "1",
        "status": "completed",
        "engineVersion": ENGINE_ID,
        "scenario": "egress",
        "metrics": {
            "unit": "second",
            "totalAgents": total,
            "egressTimeSec": round(egress_time, 2) if egress_time is not None else None,
            "meanEgressTimeSec": round(mean_egress, 2) if mean_egress is not None else None,
            "peakDoorDensity": peak_door,
            "bottleneckSpaceIds": bottleneck,
        },
        "densityGrid": _density_grid_mesh(cells),
        "trajectories": trajectories,
        "verification": {"status": "needs_review", "checks": []},
    }


def _failed(message: str) -> Dict[str, Any]:
    return {
        "schemaVersion": "1",
        "status": "failed",
        "engineVersion": ENGINE_ID,
        "scenario": "egress",
        "metrics": {
            "unit": "second",
            "totalAgents": 0,
            "egressTimeSec": None,
            "meanEgressTimeSec": None,
            "peakDoorDensity": [],
            "bottleneckSpaceIds": [],
        },
        "verification": {"status": "failed", "checks": [message]},
        "error": message,
    }
