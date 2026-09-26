"""与 Grasshopper / Ladybug Legend 一致的色标（Direct Sun Hours 默认 Ecotect）。"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ladybug.color import Colorset
from ladybug.legend import Legend, LegendParameters


def legend_parameters_direct_sun(target_hours: Optional[float] = None) -> LegendParameters:
    max_h = max(8.0, (target_hours or 2) * 1.5)
    return LegendParameters(min=0, max=max_h, colors=Colorset.ecotect())


def legend_dict(target_hours: Optional[float] = None) -> Dict[str, Any]:
    lp = legend_parameters_direct_sun(target_hours)
    return {"colorSet": "ecotect", "legendParameters": lp.to_dict()}


def value_colors_rgb(hours: List[float], legend_par: LegendParameters) -> List[Tuple[int, int, int]]:
    if not hours:
        return []
    legend = Legend(tuple(hours), legend_par)
    return [(int(c.r), int(c.g), int(c.b)) for c in legend.value_colors]


def value_colors_hex(hours: List[float], legend_par: LegendParameters) -> List[str]:
    return [f"#{r:02x}{g:02x}{b:02x}" for r, g, b in value_colors_rgb(hours, legend_par)]
