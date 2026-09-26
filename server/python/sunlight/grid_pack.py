"""将逐传感器小时写回 Honeybee 网格，并生成 Ladybug 图例着色（与 GH 一致）。"""

from __future__ import annotations

from typing import Any, Dict, List, Sequence

from honeybee_radiance.sensorgrid import SensorGrid
from ladybug.legend import LegendParameters

from ladybug_legend import legend_parameters_direct_sun, value_colors_hex


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
    idx = 0
    for grid in grids:
        n_sens = len(grid.sensors)
        sens_h = sensor_hours[idx : idx + n_sens]
        idx += n_sens
        gex = _export_grid_mesh(grid)
        n_faces = len(gex["faces"])
        if n_faces == len(sens_h):
            face_hours = sens_h
        elif len(sens_h) == 0:
            face_hours = [0.0] * n_faces
        else:
            # 面数与传感器数不一致时，按面索引映射到最近传感器（与 mesh 细分一致）
            face_hours = [sens_h[min(fi, len(sens_h) - 1)] for fi in range(n_faces)]
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
