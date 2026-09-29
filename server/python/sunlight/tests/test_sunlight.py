from __future__ import annotations

import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from grid_pack import grid_sensor_areas, make_legend, pack_grids_with_hours
from hb_build import build_honeybee_model
from lb_direct_sun import run_honeybee_direct_sun, _shade_triangles, _ray_triangle
from sunlight_metrics import package_results
from sunlight_time import analysis_period, sun_intervals
from wea_from_config import build_wea


def config(**changes):
    value = {
        "location": {"latitude": 0, "longitude": 0, "timezone": "UTC"},
        "analysisDate": "2025-03-21", "localTimeRange": ["12:00", "13:00"],
        "northDegrees": 0, "timestepMinutes": 15,
        "sensors": {"referenceHeightAboveFloor": 0.75, "gridSpacing": 1},
    }
    value.update(changes)
    return value


def rect(x0, y0, x1, y1):
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


def model(roof=False, walls=False):
    boundary = rect(-1, -1, 1, 1)
    return {
        "model": {"revisionId": "test", "units": "m"},
        "floor": {"boundary": rect(-10, -10, 10, 10), "height": 3,
                  "elevation": 0, "topObstruction": roof},
        "spaces": [{"id": "room", "boundary": boundary}],
        "walls": [{"id": "enclosure", "height": 3,
                   "geometry": {"points": boundary}}] if walls else [],
        "openings": [], "windows": [], "externalContext": [],
    }


class CivilTimeTests(unittest.TestCase):
    def test_shanghai_noon_points_towards_sky(self):
        cfg = config(location={"latitude": 31.2304, "longitude": 121.4737,
                               "timezone": "Asia/Shanghai"}, analysisDate="2025-06-21")
        direction, _ = next(sun_intervals(cfg))
        self.assertIsNotNone(direction)
        self.assertGreater(direction[2], 0.98)
        result = run_honeybee_direct_sun(model(), cfg)
        self.assertEqual(result["spaces"][0]["minHours"], 1)

    def test_same_instant_in_summer_time_and_utc(self):
        cfg = config(location={"latitude": 40.7, "longitude": -74,
                               "timezone": "America/New_York"}, analysisDate="2025-07-01")
        utc = copy.deepcopy(cfg)
        utc["location"]["timezone"] = "UTC"
        utc["localTimeRange"] = ["16:00", "17:00"]
        self.assertEqual(list(sun_intervals(cfg)), list(sun_intervals(utc)))

    def test_fractional_timezone_and_previous_utc_year(self):
        cfg = config(location={"latitude": 27.7, "longitude": 85.3,
                               "timezone": "Asia/Kathmandu"},
                     analysisDate="2025-01-01", localTimeRange=["00:00", "01:00"])
        start, end, _, _ = analysis_period(cfg)
        self.assertEqual(start.isoformat(), "2024-12-31T18:15:00+00:00")
        self.assertEqual((end - start).total_seconds(), 3600)
        self.assertEqual(len(list(sun_intervals(cfg))), 4)

    def test_dst_elapsed_time(self):
        for date, duration in [("2025-03-09", 3), ("2025-11-02", 5)]:
            cfg = config(location={"latitude": 40.7, "longitude": -74,
                                   "timezone": "America/New_York"},
                         analysisDate=date, localTimeRange=["00:00", "04:00"])
            self.assertEqual(sum(weight for _, weight in sun_intervals(cfg)), duration)

    def test_ambiguous_or_nonexistent_local_endpoint_rejected(self):
        for date, start in [("2025-03-09", "02:30"), ("2025-11-02", "01:30")]:
            cfg = config(location={"latitude": 40.7, "longitude": -74,
                                   "timezone": "America/New_York"},
                         analysisDate=date, localTimeRange=[start, "04:00"])
            with self.assertRaisesRegex(ValueError, "夏令时"):
                list(sun_intervals(cfg))

    def test_invalid_timezone_and_fractional_step_fail(self):
        for cfg in [config(location={"timezone": "Invalid/Zone"}), config(timestepMinutes=0.5),
                    config(timestepMinutes=float("nan"))]:
            result = run_honeybee_direct_sun(model(), cfg)
            self.assertEqual(result["status"], "failed")

    def test_leap_day(self):
        values = list(sun_intervals(config(analysisDate="2024-02-29")))
        self.assertEqual(len(values), 4)
        self.assertGreater(values[0][0][2], 0.9)


class SensorDirectionTests(unittest.TestCase):
    def test_horizontal_grids_point_up_for_both_boundary_windings(self):
        rings = [rect(1, 2, 5, 6),
                 [[1, 2], [5, 2], [5, 4], [3, 4], [3, 6], [1, 6], [1, 2]]]
        for ring in rings:
            positions = []
            for reverse in (False, True):
                with self.subTest(ring=ring, reverse=reverse):
                    scene = model()
                    scene['floor']['elevation'] = 4
                    scene['spaces'][0]['boundary'] = list(reversed(ring)) if reverse else ring
                    before = copy.deepcopy(scene)
                    _, grids = build_honeybee_model(scene, config())
                    self.assertEqual(scene, before)
                    self.assertEqual(len(grids), 1)
                    self.assertGreater(len(grids[0].sensors), 0)
                    positions.append(sorted(tuple(round(v, 8) for v in s.pos) for s in grids[0].sensors))
                    for sensor in grids[0].sensors:
                        self.assertEqual(sensor.dir, (0, 0, 1))
                        self.assertAlmostEqual(sensor.pos[2], 4.75)
                    self.assertTrue(all(normal.z > 0 for normal in grids[0].mesh.face_normals))
            self.assertEqual(positions[0], positions[1])


@unittest.skipUnless(os.environ.get('SDD_TEST_RADIANCE') == '1',
                     'Set SDD_TEST_RADIANCE=1 to run the real Radiance recipe')
class RadianceWindingTests(unittest.TestCase):
    def test_reversed_boundaries_preserve_sun_hours_and_roof_shading(self):
        from radiance_engine import run_radiance_recipe

        cfg = config(location={'latitude': 31.2304, 'longitude': 121.4737,
                               'timezone': 'Asia/Shanghai'}, analysisDate='2025-06-21')
        with tempfile.TemporaryDirectory(prefix='sdd-radiance-winding-') as folder:
            for roof in (False, True):
                metrics = []
                for reverse in (False, True):
                    with self.subTest(roof=roof, reverse=reverse):
                        scene = model(roof=roof)
                        if reverse:
                            scene['floor']['boundary'].reverse()
                            scene['spaces'][0]['boundary'].reverse()
                        result = run_radiance_recipe(scene, cfg, Path(folder) / f'{roof}-{reverse}')
                        self.assertEqual(result['status'], 'completed', result.get('error'))
                        self.assertEqual(result['metrics']['sensorCount'], 4)
                        for grid in result['grids']:
                            self.assertEqual(len(grid['hours']), len(grid['faces']))
                            for hours in grid['hours']:
                                self.assertAlmostEqual(hours, 0 if roof else 1)
                        metrics.append(result['spaces'])
                self.assertEqual(metrics[0], metrics[1])


class RayPhysicsTests(unittest.TestCase):
    def test_window_sill_and_head_remain_opaque_with_center_based_position(self):
        for scale in (1, 1000):
            scene = model()
            scene["model"]["units"] = "m" if scale == 1 else "mm"
            scene["floor"]["elevation"] = 2 * scale
            scene["walls"] = [{"id": "south", "height": 3 * scale,
                               "geometry": {"points": [[0, 0], [5 * scale, 0], [10 * scale, 0]]}}]
            scene["openings"] = [{"id": "win", "hostWallId": "south", "position": 5 * scale,
                                  "width": 2 * scale, "height": 1.2 * scale, "sillHeight": 0.9 * scale}]
            scene["windows"] = [{"id": "w1", "openingId": "win"}]
            hb, _ = build_honeybee_model(scene, config())
            triangles = _shade_triangles(hb)

            def blocked(x, z):
                return any(_ray_triangle((x * scale, -scale, (2 + z) * scale), (0, 1, 0), tri)
                           is not None for tri in triangles)

            self.assertFalse(blocked(4.5, 1.5))
            self.assertFalse(blocked(5.5, 1.5))
            self.assertTrue(blocked(3.5, 1.5))
            self.assertTrue(blocked(6.5, 1.5))
            self.assertTrue(blocked(4.5, 0.5))
            self.assertTrue(blocked(4.5, 2.5))
            self.assertAlmostEqual(sum(shade.area for shade in hb.orphaned_shades) / scale ** 2, 27.6)

    def test_window_without_sill_defaults_to_floor_but_keeps_wall_above(self):
        scene = model()
        scene["walls"] = [{"id": "south", "height": 3, "geometry": {"points": [[0, 0], [10, 0]]}}]
        scene["openings"] = [{"id": "win", "hostWallId": "south", "position": 5, "width": 2, "height": 1.2}]
        scene["windows"] = [{"id": "w1", "openingId": "win"}]
        hb, _ = build_honeybee_model(scene, config())
        triangles = _shade_triangles(hb)
        self.assertFalse(any(_ray_triangle((4.5, -1, 0.5), (0, 1, 0), tri) is not None for tri in triangles))
        self.assertTrue(any(_ray_triangle((4.5, -1, 2), (0, 1, 0), tri) is not None for tri in triangles))

    def test_unobstructed_duration_clips_last_step(self):
        result = run_honeybee_direct_sun(model(), config(
            localTimeRange=["12:00", "13:10"], timestepMinutes=30))
        for grid in result["grids"]:
            for hours in grid["hours"]:
                self.assertAlmostEqual(hours, 70 / 60)

    def test_roof_blocks_sun_from_above(self):
        cfg = config()
        open_result = run_honeybee_direct_sun(model(), cfg)
        roof_result = run_honeybee_direct_sun(model(roof=True), cfg)
        self.assertEqual(open_result["spaces"][0]["minHours"], 1)
        self.assertEqual(roof_result["spaces"][0]["maxHours"], 0)

    def test_exact_hour_target_is_not_failed_by_roundoff(self):
        result = run_honeybee_direct_sun(model(), config(
            timestepMinutes=10, targets=[{"spaceIds": ["room"], "minHours": 1}]))
        self.assertTrue(result["targets"][0]["met"])
        self.assertEqual(result["metrics"]["targetAreaRatio"], 1)

    def test_windowless_enclosure_receives_no_direct_sun(self):
        result = run_honeybee_direct_sun(model(roof=True, walls=True), config())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["spaces"][0]["maxHours"], 0)

    def test_night_completes_with_zero_hours(self):
        result = run_honeybee_direct_sun(model(), config(localTimeRange=["00:00", "01:00"]))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["spaces"][0]["maxHours"], 0)

    def test_north_rotation(self):
        cfg = config(localTimeRange=["09:00", "10:00"])
        a = next(sun_intervals(cfg))[0]
        b = next(sun_intervals({**cfg, "northDegrees": 180}))[0]
        self.assertAlmostEqual(a[0], -b[0])
        self.assertAlmostEqual(a[1], -b[1])
        self.assertAlmostEqual(a[2], b[2])


class AreaMetricsTests(unittest.TestCase):
    def test_actual_mesh_areas_and_strict_sensor_mapping(self):
        scene = model()
        scene["spaces"].append({"id": "large", "boundary": rect(2, 2, 5, 5)})
        _, grids = build_honeybee_model(scene, config())
        areas = grid_sensor_areas(grids, scene)
        self.assertAlmostEqual(sum(areas), 13)
        ids = [grid.room_identifier for grid in grids for _ in grid.sensors]
        hours = [2 if sid == "large" else 0 for sid in ids]
        cfg = config(targets=[{"spaceIds": ["room", "large"], "minHours": 1}])
        result = package_results(ids, hours, areas, cfg, "test", scene["spaces"])
        self.assertAlmostEqual(result["metrics"]["targetAreaRatio"], 9 / 13)
        _, legend = make_legend(cfg)
        with self.assertRaises(ValueError):
            pack_grids_with_hours(grids, hours[:-1], legend)

    def test_unequal_faces_weight_mean_and_target_ratio(self):
        cfg = config(targets=[{"spaceIds": ["room"], "minHours": 1}])
        result = package_results(["room", "room"], [2, 0], [9, 1], cfg, "test", [{"id": "room"}])
        self.assertAlmostEqual(result["spaces"][0]["meanHours"], 1.8)
        self.assertAlmostEqual(result["spaces"][0]["targetMetRatio"], 0.9)
        self.assertAlmostEqual(result["metrics"]["targetAreaRatio"], 0.9)

    def test_splitting_logical_space_does_not_change_score(self):
        cfg = config(targets=[{"spaceIds": ["room"], "minHours": 1}])
        whole = package_results(["room", "room"], [2, 0], [9, 1], cfg, "test", [{"id": "room"}])
        parts = [{"id": "room", "allocationId": "room"},
                 {"id": "room-part-2", "allocationId": "room"}]
        split = package_results(["room", "room-part-2"], [2, 0], [9, 1], cfg, "test", parts)
        self.assertEqual(whole["metrics"], split["metrics"])
        self.assertEqual(whole["allocations"][0]["meanHours"], split["allocations"][0]["meanHours"])
        self.assertFalse(split["targets"][0]["met"])
        self.assertEqual(split["targets"][0]["worstSpaceId"], "room-part-2")

    def test_overlapping_targets_count_area_once_at_strictest_threshold(self):
        cfg = config(targets=[{"spaceIds": ["a", "b"], "minHours": 1},
                              {"spaceIds": ["a", "a"], "minHours": 2}])
        result = package_results(["a", "b"], [1.5, 1.5], [9, 1], cfg, "test", [{"id": "a"}, {"id": "b"}])
        self.assertAlmostEqual(result["metrics"]["targetAreaRatio"], 0.1)
        self.assertTrue(result["targets"][0]["met"])
        self.assertFalse(result["targets"][1]["met"])
        reverse = package_results(["a", "b"], [1.5, 1.5], [9, 1],
                                  {**cfg, "targets": list(reversed(cfg["targets"]))}, "test", [{"id": "a"}, {"id": "b"}])
        self.assertEqual(result["metrics"], reverse["metrics"])

    def test_missing_fragment_cannot_report_success(self):
        cfg = config(targets=[{"spaceIds": ["room"], "minHours": 1}])
        parts = [{"id": "room", "allocationId": "room"},
                 {"id": "room-part-2", "allocationId": "room"}]
        result = package_results(["room"], [2], [9], cfg, "test", parts)
        self.assertIsNone(result["metrics"]["targetAreaRatio"])
        self.assertFalse(result["targets"][0]["met"])
        self.assertEqual(result["targets"][0]["missingSpaceIds"], ["room-part-2"])
        self.assertIsNone(result["allocations"][0]["targetMetRatio"])

    def test_no_targets_and_invalid_samples(self):
        result = package_results(["room"], [2], [1], config(), "test", [{"id": "room"}])
        self.assertIsNone(result["metrics"]["targetAreaRatio"])
        self.assertEqual(result["verification"]["status"], "needs_review")
        for hours, areas in [([2], []), ([float("nan")], [1]), ([2], [0])]:
            with self.assertRaises(ValueError):
                package_results(["room"], hours, areas, config(), "test", [{"id": "room"}])


class RadianceWeatherTests(unittest.TestCase):
    def test_local_timezone_and_complete_subhourly_interval(self):
        cfg = config(location={"latitude": 31.2304, "longitude": 121.4737,
                               "timezone": "Asia/Shanghai"}, analysisDate="2025-06-21")
        wea = build_wea(cfg)
        self.assertEqual(wea.location.time_zone, 8)
        self.assertEqual(wea.timestep, 4)
        self.assertEqual(len(wea.direct_normal_irradiance), 4)
        self.assertEqual([(dt.hour, dt.minute) for dt in wea.datetimes], [(12, 0), (12, 15), (12, 30), (12, 45)])
        self.assertTrue(all(value > 0 for value in wea.direct_normal_irradiance))

    def test_dst_offset_and_transition_rejection(self):
        cfg = config(location={"latitude": 40.7, "longitude": -74,
                               "timezone": "America/New_York"}, analysisDate="2025-07-01", timestepMinutes=60)
        self.assertEqual(build_wea(cfg).location.time_zone, -4)
        cfg.update(analysisDate="2025-03-09", localTimeRange=["00:00", "04:00"])
        with self.assertRaisesRegex(ValueError, "跨夏令时"):
            build_wea(cfg)


if __name__ == "__main__":
    unittest.main()
