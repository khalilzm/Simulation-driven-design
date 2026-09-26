"""Area-weighted sensor results, with stable logical allocation targets."""

from __future__ import annotations

import math
from typing import Any, Dict, Sequence


def package_results(
    space_ids: Sequence[str], hours: Sequence[float], areas: Sequence[float],
    config: Dict[str, Any], engine: str, model_spaces: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    if not len(space_ids) == len(hours) == len(areas):
        raise ValueError("传感器、日照时长和网格面积数量不一致")
    if any(not math.isfinite(a) or a <= 0 for a in areas):
        raise ValueError("传感器代表面积须为有限正数")
    if any(not math.isfinite(h) or h < 0 for h in hours):
        raise ValueError("日照时长须为有限非负数")

    by_space: Dict[str, list[int]] = {}
    for i, sid in enumerate(space_ids):
        by_space.setdefault(sid, []).append(i)
    allocations: Dict[str, list[str]] = {}
    owners = {}
    for space in model_spaces:
        sid = space["id"]
        aid = space.get("allocationId") or sid
        owners[sid] = aid
        allocations.setdefault(aid, []).append(sid)

    thresholds: Dict[int, float] = {}
    target_checks = []
    targets = config.get("targets") or []
    missing_targets = False
    missing_target_spaces = set()

    def meets(index: int, minimum: float) -> bool:
        # Repeated fractional-hour integration can undershoot an exact threshold.
        return hours[index] >= minimum or math.isclose(hours[index], minimum, rel_tol=0, abs_tol=1e-9)

    for target in targets:
        requested = list(dict.fromkeys(target["spaceIds"]))
        # An allocation ID takes precedence over its same-named first fragment.
        resolved = set(sid for key in requested for sid in allocations.get(key, [key]))
        missing = sorted(sid for sid in resolved if not by_space.get(sid))
        indices = [i for sid in sorted(resolved) for i in by_space.get(sid, [])]
        minimum = float(target["minHours"])
        for i in indices:
            thresholds[i] = max(thresholds.get(i, minimum), minimum)
        worst = min(indices, key=lambda i: hours[i]) if indices else None
        missing_targets |= bool(missing) or not requested
        missing_target_spaces.update(missing)
        target_checks.append({
            "spaceIds": requested, "minHours": minimum,
            "met": bool(indices) and not missing and all(meets(i, minimum) for i in indices),
            "worstSpaceId": space_ids[worst] if worst is not None else None,
            "worstMinHours": hours[worst] if worst is not None else None,
            "missingSpaceIds": missing,
        })

    def summarize(indices: list[int]) -> Dict[str, Any]:
        area = math.fsum(areas[i] for i in indices)
        targeted = [i for i in indices if i in thresholds]
        target_area = math.fsum(areas[i] for i in targeted)
        return {
            "sensorCount": len(indices), "sampledArea": area,
            "meanHours": math.fsum(hours[i] * areas[i] for i in indices) / area,
            "minHours": min(hours[i] for i in indices),
            "maxHours": max(hours[i] for i in indices),
            "targetMetRatio": (math.fsum(areas[i] for i in targeted if meets(i, thresholds[i]))
                               / target_area) if target_area else None,
        }

    spaces_out = [{"spaceId": sid, "allocationId": owners.get(sid, sid), **summarize(indices)}
                  for sid, indices in sorted(by_space.items())]
    allocations_out = []
    for aid, members in sorted(allocations.items()):
        indices = [i for sid in members for i in by_space.get(sid, [])]
        if indices:
            row = {"allocationId": aid, "spaceIds": members, **summarize(indices)}
            if missing_target_spaces.intersection(members):
                row["targetMetRatio"] = None
            allocations_out.append(row)

    target_area = math.fsum(areas[i] for i in thresholds)
    ratio = (math.fsum(areas[i] for i, minimum in thresholds.items() if meets(i, minimum))
             / target_area) if target_area and not missing_targets else None
    status = "needs_review" if not targets else "passed" if all(t["met"] for t in target_checks) else "failed"
    checks = ["未配置 targets，仅输出指标" if not targets else
              "全部目标空间满足 minHours" if status == "passed" else "部分空间未满足日照目标"]
    if missing_targets:
        checks.append("目标空间不存在或缺少测点，无法计算完整的达标面积比例")
    return {
        "schemaVersion": "1", "status": "completed", "engineVersion": engine,
        "metrics": {"unit": "hour", "sensorCount": len(hours), "targetAreaRatio": ratio},
        "spaces": spaces_out, "allocations": allocations_out,
        "targets": target_checks if targets else None,
        "verification": {"status": status, "checks": checks},
    }
