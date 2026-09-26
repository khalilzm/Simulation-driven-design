"""Resolve civil analysis times once, then integrate intervals on the UTC timeline."""

from __future__ import annotations

from calendar import isleap
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterator, Tuple
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ladybug.dt import DateTime
from ladybug.location import Location
from ladybug.sunpath import Sunpath


def _resolve_local(value: str, zone: ZoneInfo) -> datetime:
    local = datetime.fromisoformat(value)
    candidates = set()
    for fold in (0, 1):
        utc = local.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) == local:
            candidates.add(utc)
    if len(candidates) != 1:
        reason = "不存在" if not candidates else "有歧义"
        raise ValueError(f"当地时间 {value} 在 {zone.key} 中{reason}（夏令时切换），请调整分析时段")
    return candidates.pop()


def analysis_period(config: Dict[str, Any]) -> Tuple[datetime, datetime, ZoneInfo, int]:
    try:
        zone = ZoneInfo(config["location"]["timezone"].strip())
    except (ZoneInfoNotFoundError, ValueError) as error:
        raise ValueError("location.timezone 不是有效的 IANA 时区") from error
    date = config["analysisDate"]
    start, end = (_resolve_local(f"{date}T{clock.strip()}", zone)
                  for clock in config["localTimeRange"])
    if end <= start:
        raise ValueError("localTimeRange 结束须晚于开始")
    step = config["timestepMinutes"]
    if isinstance(step, bool) or not isinstance(step, (int, float)) or not 1 <= step <= 120 or int(step) != step:
        raise ValueError("timestepMinutes 须为 1～120 的整数")
    return start, end, zone, int(step)


def sun_intervals(config: Dict[str, Any]) -> Iterator[Tuple[tuple | None, float]]:
    """Sample at each interval's start; clip its weight to the actual end time."""
    start, end, _zone, step_minutes = analysis_period(config)
    loc = config["location"]
    sunpath = Sunpath.from_location(Location(
        latitude=float(loc["latitude"]), longitude=float(loc["longitude"]), time_zone=0,
    ), north_angle=float(config.get("northDegrees", 0)))
    step = timedelta(minutes=step_minutes)
    current = start
    while current < end:
        next_time = min(current + step, end)
        sunpath.is_leap_year = isleap(current.year)
        dt = DateTime(current.month, current.day, current.hour, current.minute,
                      leap_year=isleap(current.year))
        sun = sunpath.calculate_sun_from_date_time(dt)
        # Rays originate at the sensor and travel towards the sky/solar disc.
        vec = sun.sun_vector_reversed
        direction = (float(vec.x), float(vec.y), float(vec.z)) if sun.altitude > 0 else None
        yield direction, (next_time - current).total_seconds() / 3600
        current = next_time
