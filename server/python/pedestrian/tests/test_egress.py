from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import build_geometry, run


def two_room_model():
    """两房间 + 一道隔墙（带内门）+ 南墙入口门。入口在 roomA 南墙 x=5。"""
    return {
        "model": {"revisionId": "smoke", "units": "m"},
        "floor": {"boundary": [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]]},
        "spaces": [
            {"id": "roomA", "boundary": [[0, 0], [9.9, 0], [9.9, 10], [0, 10], [0, 0]], "enclosed": True},
            {"id": "roomB", "boundary": [[10.1, 0], [20, 0], [20, 10], [10.1, 10], [10.1, 0]], "enclosed": True},
        ],
        "walls": [
            {"id": "w-int", "geometry": {"type": "polyline", "points": [[10, 0], [10, 10]]}, "thickness": 0.2, "height": 3},
            {"id": "w-south", "geometry": {"type": "polyline", "points": [[0, 0], [20, 0]]}, "thickness": 0.2, "height": 3},
        ],
        "openings": [
            {"id": "op-int-door", "hostWallId": "w-int", "position": 5, "width": 1.5, "height": 2.1},
            {"id": "op-entrance", "hostWallId": "w-south", "position": 5, "width": 1.5, "height": 2.1},
        ],
        "doors": [
            {"id": "d-int", "openingId": "op-int-door"},
            {"id": "d-entrance", "openingId": "op-entrance"},
        ],
        "windows": [],
    }


def config(**changes):
    value = {
        "schemaVersion": "1", "scenario": "egress", "model": "collision-free",
        "dt": 0.05, "maxDurationSec": 120, "seed": 1,
        "agents": [{"spaceId": "roomA", "count": 10}, {"spaceId": "roomB", "count": 10}],
    }
    value.update(changes)
    return value


class GeometryTests(unittest.TestCase):
    def test_optimization_does_not_discard_disconnected_regions(self):
        model = two_room_model()
        model["openings"] = [op for op in model["openings"] if op["id"] != "op-int-door"]
        model["doors"] = [d for d in model["doors"] if d["id"] != "d-int"]
        with self.assertRaisesRegex(ValueError, "不能丢弃"):
            build_geometry(model, strict=True)

    def test_walkable_is_connected_and_detects_exit(self):
        walkable, exits, spaces = build_geometry(two_room_model())
        self.assertEqual(walkable.geom_type, "Polygon")
        self.assertGreater(walkable.area, 190)
        self.assertEqual(len(exits), 1)
        self.assertEqual(exits[0]["exitId"], "exit-1")

    def test_no_exterior_door_yields_no_exit(self):
        model = two_room_model()
        # 移除南墙入口门，仅剩内门（不在楼板边界上）。
        model["openings"] = [op for op in model["openings"] if op["id"] != "op-entrance"]
        model["doors"] = [d for d in model["doors"] if d["id"] != "d-entrance"]
        _, exits, _ = build_geometry(model)
        self.assertEqual(exits, [])


class EgressTests(unittest.TestCase):
    def test_egress_completes(self):
        result = run(two_room_model(), config(), None)
        self.assertEqual(result["status"], "completed")
        metrics = result["metrics"]
        self.assertEqual(metrics["totalAgents"], 20)
        self.assertIsNotNone(metrics["egressTimeSec"])
        self.assertGreater(metrics["egressTimeSec"], 0)
        self.assertEqual(len(metrics["peakDoorDensity"]), 1)
        grid = result.get("densityGrid")
        self.assertIsNotNone(grid)
        self.assertEqual(len(grid["faces"]), len(grid["density"]))
        self.assertGreater(len(grid["vertices"]), 0)
        trajs = result.get("trajectories")
        self.assertEqual(len(trajs), 20)
        for t in trajs:
            self.assertEqual(len(t["times"]), len(t["points"]))
            self.assertGreater(len(t["points"]), 1)

    def test_missing_exit_fails(self):
        model = two_room_model()
        model["openings"] = [op for op in model["openings"] if op["id"] != "op-entrance"]
        model["doors"] = [d for d in model["doors"] if d["id"] != "d-entrance"]
        result = run(model, config(), None)
        self.assertEqual(result["status"], "failed")

    def test_unknown_space_fails(self):
        result = run(two_room_model(), config(agents=[{"spaceId": "nope", "count": 1}]), None)
        self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
    unittest.main()
