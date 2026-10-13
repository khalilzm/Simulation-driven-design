"""Geometry/material contract tests; actual recipe smoke test runs separately."""
import unittest,copy,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from daylight_engine import _window_shades
class DaylightGeometryTests(unittest.TestCase):
 def model(self):
  return {'floor':{'elevation':0,'height':2.8},'walls':[{'id':'wall','geometry':{'points':[[0,0],[4,0]]},'height':2.8}],'openings':[{'id':'window','hostWallId':'wall','position':2,'width':1.8,'height':1.2,'sillHeight':.9},{'id':'door','hostWallId':'wall','position':.5,'width':.9,'height':2.1}],'doors':[{'openingId':'door'}],'windows':[{'openingId':'window'}]}
 def test_glass_matches_real_window_geometry_and_transmittance(self):
  shades=_window_shades(self.model(),.65)
  self.assertEqual(len(shades),1);self.assertAlmostEqual(shades[0].area,1.8*1.2)
  self.assertAlmostEqual(shades[0].properties.radiance.modifier.average_transmittance,.65,delta=.002)
 def test_door_stays_opaque_and_no_window_means_no_glazing(self):
  m=self.model();m['openings']=m['openings'][1:];self.assertEqual(_window_shades(m,.65),[])
 def test_mm_window_preserves_native_geometry(self):
  m=self.model()
  for w in m['walls']:
   w['geometry']['points']=[[v*1000 for v in p] for p in w['geometry']['points']];w['height']*=1000
  m['floor']['height']*=1000
  for op in m['openings']:
   for key in ['position','width','height','sillHeight']:
    if key in op:op[key]*=1000
  self.assertAlmostEqual(_window_shades(m,.65)[0].area/1e6,2.16)
if __name__=='__main__':unittest.main()
