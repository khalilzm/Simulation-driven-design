"""将逐传感器小时写回 Honeybee 网格，并生成 Ladybug 图例着色（与 GH 一致）。"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

from honeybee_radiance.sensorgrid import SensorGrid
from ladybug.legend import LegendParameters

from ladybug_legend import legend_parameters_direct_sun, value_colors_hex


def grid_sensor_areas(grids: Sequence[SensorGrid], model: Dict[str, Any]) -> List[float]:
    """One sensor per mesh face; return its actual face area in square metres."""
    scale = 0.001 if model.get("model", {}).get("units") == "mm" else 1.0
    areas = []
    for grid in grids:
        if grid.mesh is None or len(grid.mesh.faces) != len(grid.sensors):
            raise ValueError(f"SensorGrid {grid.identifier} 的网格面与传感器不一一对应")
        areas.extend(area * scale ** 2 for area in grid.mesh.face_areas)
    return areas


def _export_grid_mesh(grid: SensorGrid) -> Dict[str, Any]:
    mesh = grid.mesh
    if mesh is None:
        raise ValueError(f"SensorGrid {grid.identifier} 无 mesh")
    return {
        "gridId": grid.identifier,
        "spaceId": grid.room_identifier,
        "vertices": [[v.x, v.y, v.z] for v in mesh.vertices],
        "faces": [list(f) for f in mesh.faces],
    }


def pack_grids_with_hours(
    grids: Sequence[SensorGrid],
    sensor_hours: List[float],
    legend_par: LegendParameters,
) -> List[Dict[str, Any]]:
    """sensor_hours 顺序与 grids 内 sensors 遍历顺序一致。"""
    out: List[Dict[str, Any]] = []
    if sum(len(grid.sensors) for grid in grids) != len(sensor_hours):
        raise ValueError("传感器与日照时长数量不一致")
    idx = 0
    for grid in grids:
        n_sens = len(grid.sensors)
        sens_h = sensor_hours[idx : idx + n_sens]
        idx += n_sens
        gex = _export_grid_mesh(grid)
        n_faces = len(gex["faces"])
        if n_faces != len(sens_h):
            raise ValueError(f"SensorGrid {grid.identifier} 的网格面与传感器不一一对应")
        face_hours = sens_h
        gex["hours"] = face_hours
        gex["faceColors"] = value_colors_hex(face_hours, legend_par)
        out.append(gex)
    return out


def target_min_hours(config: Dict[str, Any]) -> float | None:
    targets = config.get("targets") or []
    if not targets:
        return None
    return float(targets[0].get("minHours", 2))


def make_legend(config: Dict[str, Any]) -> tuple[Dict[str, Any], LegendParameters]:
    th = target_min_hours(config)
    par = legend_parameters_direct_sun(th)
    from ladybug_legend import legend_dict

    return legend_dict(th), par
