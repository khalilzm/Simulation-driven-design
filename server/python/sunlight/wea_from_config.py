"""由 sunlight.json 生成 HB Direct Sun Hours 所需的 Ladybug Wea（与 GH Wea 输入一致）。"""

from __future__ import annotations

from typing import Any, Dict, Tuple

from ladybug.analysisperiod import AnalysisPeriod
from ladybug.location import Location
from ladybug.wea import Wea


def _parse_hm(s: str) -> Tuple[int, int]:
    parts = s.strip().split(":")
    return int(parts[0]), int(parts[1])


def build_wea(config: Dict[str, Any]) -> Wea:
    loc_cfg = config["location"]
    location = Location(
        latitude=float(loc_cfg["latitude"]),
        longitude=float(loc_cfg["longitude"]),
        time_zone=0,
    )
    _y, m, d = (int(x) for x in config["analysisDate"].split("-"))
    sh, sm = _parse_hm(config["localTimeRange"][0])
    eh, em = _parse_hm(config["localTimeRange"][1])
    step_min = int(config["timestepMinutes"])
    if step_min <= 0 or 60 % step_min != 0:
        raise ValueError("timestepMinutes 须为 60 的整除因子（如 60、30、15）")
    if sm or em:
        raise ValueError("Wea 过滤暂仅支持整点 localTimeRange（与 GH 小时步长一致）")

    wea = Wea.from_ashrae_clear_sky(location)
    end_hour = eh - 1 if eh > sh else eh
    ap = AnalysisPeriod(m, d, sh, m, d, end_hour, 60 // step_min)
    filtered = wea.filter_by_analysis_period(ap)
    if filtered is None or filtered.count_timesteps == 0:
        raise ValueError("Wea 在分析时段内无数据，请检查 analysisDate / localTimeRange")
    return filtered
