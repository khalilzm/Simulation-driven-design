"""Indoor daylight factor under CIE overcast sky, with glazing and interreflection."""
from __future__ import annotations
import json,math,sys,shutil
from pathlib import Path
from hb_build import build_honeybee_model
from grid_pack import grid_sensor_areas
from radiance_engine import _configure_honeybee_radiance,_radiance_on_path
ENGINE_ID='radiance-indoor-daylight-factor@1'

def _window_shades(model,transmittance):
    from honeybee.shade import Shade
    from ladybug_geometry.geometry3d.face import Face3D
    from ladybug_geometry.geometry3d.pointvector import Point3D
    from honeybee_radiance.modifier.material.glass import Glass
    glazing=Glass.from_single_transmittance('daylight-glazing',transmittance)
    windows={w['openingId'] for w in model.get('windows',[])};out=[];elevation=model['floor'].get('elevation',0)
    for op in model.get('openings',[]):
        if op['id'] not in windows:continue
        wall=next(w for w in model['walls'] if w['id']==op['hostWallId']);offset=0
        for a,b in zip(wall['geometry']['points'],wall['geometry']['points'][1:]):
            length=math.hypot(b[0]-a[0],b[1]-a[1]);lo=max(0,op['position']-op['width']/2-offset);hi=min(length,op['position']+op['width']/2-offset);offset+=length
            if length<1e-8 or hi<=lo:continue
            bottom=elevation+op.get('sillHeight',0);top=min(elevation+wall.get('height',model['floor']['height']),bottom+op['height'])
            p=(a[0]+(b[0]-a[0])*lo/length,a[1]+(b[1]-a[1])*lo/length);q=(a[0]+(b[0]-a[0])*hi/length,a[1]+(b[1]-a[1])*hi/length)
            shade=Shade(f'daylight-glass-{len(out)}',Face3D([Point3D(*p,bottom),Point3D(*q,bottom),Point3D(*q,top),Point3D(*p,top)]))
            shade.properties.radiance.modifier=glazing;out.append(shade)
    return out

def _run_once(model,config,folder,spacing):
    from honeybee.shade import Shade
    from honeybee_radiance.modifier.material.plastic import Plastic
    from hb_build import _ring_to_face3d
    from lbt_recipes.recipe import Recipe
    from lbt_recipes.settings import RecipeSettings
    hb_config={'sensors':{**config['sensors'],'gridSpacing':spacing},'daylightMode':True}
    hb,grids=build_honeybee_model(model,hb_config)
    hb.units='Millimeters' if model['model'].get('units')=='mm' else 'Meters'
    material=config['materials'];wall=Plastic.from_single_reflectance('daylight-wall',material['wallReflectance']);ceiling=Plastic.from_single_reflectance('daylight-ceiling',material['ceilingReflectance']);floor=Plastic.from_single_reflectance('daylight-floor',material['floorReflectance'])
    for shade in hb.orphaned_shades:
        if shade.identifier.startswith('ctx-'):continue
        shade.properties.radiance.modifier=ceiling if shade.identifier=='roof-slab' else wall
    slab=Shade('daylight-floor',_ring_to_face3d(model['floor']['boundary'],model['floor'].get('elevation',0)));slab.properties.radiance.modifier=floor;hb.add_shade(slab)
    for shade in _window_shades(model,material['windowTransmittance']):hb.add_shade(shade)
    # lbt-recipes 0.8.13 mixes timezone-aware now with naive started_at.
    # Apply the compatibility repair to a task-local copy, keeping installed packages intact.
    installed=Recipe('daylight-factor');local=folder/'recipe'/'daylight_factor'
    shutil.copytree(installed.path,local,ignore=shutil.ignore_patterns('__pycache__'),dirs_exist_ok=True)
    runner=local/'run.py';source=runner.read_text()
    source=source.replace("status['status']['started_at'], '%Y-%m-%dT%H:%M:%SZ'\n    )", "status['status']['started_at'], '%Y-%m-%dT%H:%M:%SZ'\n    ).replace(tzinfo=datetime.timezone.utc)")
    runner.write_text(source)
    recipe=Recipe(str(local.resolve()));recipe.input_value_by_name('model',hb);recipe.input_value_by_name('radiance-parameters','-ab 4 -aa 0.1 -ad 2048 -ar 128 -lw 0.00005')
    folder.mkdir(parents=True,exist_ok=True);project=recipe.run(settings=RecipeSettings(folder=str(folder),workers=4),radiance_check=True,silent=True)
    values=recipe.output_value_by_name('results',project)
    if isinstance(values,(str,Path)):
        result_folder=Path(values);info=json.loads((result_folder/'grids_info.json').read_text());mapped={}
        for entry in info:
            lines=(result_folder/(entry['full_id']+'.res')).read_text().splitlines();start=entry.get('start_ln',0)
            mapped[entry['identifier']]=[float(v) for v in lines[start:start+entry['count']]]
        values=mapped
    elif isinstance(values,list):
        if len(values)!=len(grids):raise ValueError('采光网格数量不一致')
        values={grid.identifier:row for grid,row in zip(grids,values)}
    if not isinstance(values,dict):raise ValueError('采光结果未按网格返回')
    area_list=grid_sensor_areas(grids,model);offset=0;spaces=[];exports=[];targets={t['roomId']:t for t in config.get('targets',[])}
    for grid in grids:
        data=values.get(grid.identifier)
        if data is None:raise ValueError(f'缺少采光网格{grid.identifier}')
        df=[float(v) for v in data]
        if len(df)!=len(grid.sensors) or any(not math.isfinite(v) or v<0 for v in df):raise ValueError('采光系数或网格数量无效')
        lux=[v/100*config['outdoorIlluminanceLux'] for v in df];areas=area_list[offset:offset+len(df)];offset+=len(df);total=math.fsum(areas)
        sid=grid.room_identifier;room=next(s for s in model['spaces'] if s['id']==sid);aid=room.get('allocationId') or sid;target=targets.get(aid)
        spaces.append({'spaceId':sid,'allocationId':aid,'sensorCount':len(df),'sampledArea':total,'meanLux':math.fsum(v*a for v,a in zip(lux,areas))/total,'minLux':min(lux),'maxLux':max(lux),'meanDaylightFactor':math.fsum(v*a for v,a in zip(df,areas))/total,'targetMetRatio':math.fsum(a for v,a in zip(lux,areas) if v+1e-6>=target['minIlluminanceLux'])/total if target else None})
        exports.append({'gridId':grid.identifier,'spaceId':sid,'vertices':[[v.x,v.y,v.z] for v in grid.mesh.vertices],'faces':[list(f) for f in grid.mesh.faces],'lux':lux,'daylightFactors':df})
    result={'schemaVersion':'1','status':'completed','method':'overcast-daylight-factor','engineVersion':ENGINE_ID,'outdoorIlluminanceLux':config['outdoorIlluminanceLux'],'spaces':spaces,'grids':exports,'assumptions':[f"标准CIE阴天天空，室外水平照度参考值{config['outdoorIlluminanceLux']} lx（非实际天气预测）",'Radiance包含天空光、玻璃透射及4次室内反射','门按关闭不透明处理；阳台保持当前模型的封闭状态',f"墙／顶／地反射率{material['wallReflectance']}／{material['ceilingReflectance']}／{material['floorReflectance']}，窗可见光透射率{material['windowTransmittance']}"]}
    (folder/'result.json').write_text(json.dumps(result),encoding='utf-8');return result

def run_daylight(model,config,folder):
    _configure_honeybee_radiance()
    if not _radiance_on_path():raise ValueError('室内采光需要Radiance环境，不能用直射日照结果替代')
    spacing=config['sensors']['gridSpacing'];first=_run_once(model,config,folder/'sampling-base',spacing)
    fine=_run_once(model,config,folder/'sampling-refined',spacing/2)
    baseline={s['allocationId']:s for s in first['spaces']};targets={t['roomId']:t for t in config.get('targets',[])};rows=[]
    for s in fine['spaces']:
        a=baseline[s['allocationId']];mean_delta=abs(a['meanLux']-s['meanLux']);ratio_delta=abs(a['targetMetRatio']-s['targetMetRatio']) if a['targetMetRatio'] is not None else None
        target=targets.get(s['allocationId']);cross=target and ((a['targetMetRatio']+1e-6>=target['minAreaRatio'])!=(s['targetMetRatio']+1e-6>=target['minAreaRatio']))
        unstable=mean_delta>max(15,s['meanLux']*.05) or (ratio_delta is not None and ratio_delta>.02) or bool(cross)
        rows.append({'allocationId':s['allocationId'],'status':'needs_review' if unstable else 'converged','reason':'采样变化超过容差或跨越目标阈值' if unstable else None,'meanLuxDelta':mean_delta,'targetRatioDelta':ratio_delta,'baseTargetRatio':a['targetMetRatio'],'refinedTargetRatio':s['targetMetRatio']})
    fine['sampling']={'status':'needs_review' if any(r['status']=='needs_review' for r in rows) else 'converged','baseSpacing':spacing,'refinedSpacing':spacing/2,'rooms':rows};return fine

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--model',required=True);parser.add_argument('--config',required=True);parser.add_argument('--output',required=True);args=parser.parse_args();folder=Path(args.output);folder.mkdir(parents=True,exist_ok=True)
    try:result=run_daylight(json.load(open(args.model)),json.load(open(args.config)),folder)
    except Exception as error:result={'schemaVersion':'1','status':'failed','method':'overcast-daylight-factor','engineVersion':ENGINE_ID,'outdoorIlluminanceLux':0,'error':str(error),'spaces':[],'grids':[],'assumptions':[]}
    (folder/'result.json').write_text(json.dumps(result),encoding='utf-8');print(json.dumps({'ok':result['status']=='completed','resultPath':str(folder/'result.json')}));sys.exit(0 if result['status']=='completed' else 3)
