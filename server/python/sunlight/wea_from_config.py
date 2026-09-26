"""由 sunlight.json 生成 HB Direct Sun Hours 所需的 Ladybug Wea（与 GH Wea 输入一致）。"""

from __future__ import annotations

from calendar import isleap
from datetime import timedelta
from typing import Any, Dict

from ladybug.dt import DateTime
from ladybug.location import Location
from ladybug.wea import Wea
from sunlight_time import analysis_period


def build_wea(config: Dict[str, Any]) -> Wea:
    start, end, zone, step_min = analysis_period(config)
    if 60 % step_min != 0:
        raise ValueError("timestepMinutes 须为 60 的整除因子（如 60、30、15）")
    local_start, local_end = start.astimezone(zone), end.astimezone(zone)
    if local_start.minute or local_end.minute:
        raise ValueError("Wea 过滤暂仅支持整点 localTimeRange（与 GH 小时步长一致）")
    samples = []
    current = start
    while current < end:
        samples.append(current.astimezone(zone))
        current += timedelta(minutes=step_min)
    offsets = {t.utcoffset() for t in [*samples, local_end]}
    if len(offsets) != 1:
        raise ValueError("Radiance Wea 暂不支持跨夏令时切换的分析时段，请拆分时段或使用 LB 引擎")
    loc_cfg = config["location"]
    location = Location(
        latitude=float(loc_cfg["latitude"]),
        longitude=float(loc_cfg["longitude"]),
        time_zone=local_start.utcoffset().total_seconds() / 3600,
    )
    leap = isleap(local_start.year)
    wea = Wea.from_ashrae_clear_sky(location, timestep=60 // step_min, is_leap_year=leap)
    # Explicit half-open interval: include e.g. 15:15/30/45 when ending at 16:00.
    hoys = [DateTime(t.month, t.day, t.hour, t.minute, leap_year=leap).hoy for t in samples]
    filtered = wea.filter_by_hoys(hoys)
    if len(filtered.direct_normal_irradiance) != len(samples):
        raise ValueError("Wea 在分析时段内无数据，请检查 analysisDate / localTimeRange")
    return filtered
