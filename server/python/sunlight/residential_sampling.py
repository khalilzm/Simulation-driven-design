"""Conservative window sun-projection bounds and bounded two-resolution verification."""
from __future__ import annotations
import copy
import math
from pathlib import Path
from sunlight_time import sun_intervals

BASE_FINE_STEP = .1
REFINED_STEP = .05
RATIO_TOLERANCE = .01
MEAN_TOLERANCE = .05

def _inside(x,y,ring):
    value=False
    for a,b in zip(ring,ring[1:]):
        if (a[1]>y)!=(b[1]>y) and x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:value=not value
    return value

def sun_projection_bounds(model,config):
    """Every window-to-sensor direct ray lies in these bounds; no shade is removed."""
    floor=model['floor'];scale=1000 if model.get('model',{}).get('units')=='mm' else 1
    if not floor.get('topObstruction',False):
        ps=floor['boundary'];return [(min(p[0] for p in ps),min(p[1] for p in ps),max(p[0] for p in ps),max(p[1] for p in ps))]
    ref=config['sensors']['referenceHeightAboveFloor']*scale
    directions=[d for d,_ in sun_intervals(config) if d is not None and d[2]>1e-6]
    doors={d['openingId'] for d in model.get('doors',[])};boxes=[]
    for opening in model.get('openings',[]):
        if opening['id'] in doors:continue
        wall=next((w for w in model['walls'] if w['id']==opening['hostWallId']),None)
        if not wall:continue
        lo=opening['position']-opening['width']/2;hi=opening['position']+opening['width']/2;offset=0
        low=max(0,opening.get('sillHeight',0));high=min(wall.get('height',floor['height']),low+opening['height'])
        for a,b in zip(wall['geometry']['points'],wall['geometry']['points'][1:]):
            length=math.hypot(b[0]-a[0],b[1]-a[1]);left=max(0,lo-offset);right=min(length,hi-offset);offset+=length
            if length<1e-8 or right<=left:continue
            dx,dy=(b[0]-a[0])/length,(b[1]-a[1])/length;nx,ny=-dy,dx;thickness=wall.get('thickness',0)
            mid=((a[0]+b[0])/2,(a[1]+b[1])/2)
            outward=[sign for sign in [-1,1] if not _inside(mid[0]+sign*nx*(thickness/2+.01*scale),mid[1]+sign*ny*(thickness/2+.01*scale),floor['boundary'])]
            for d in directions:
                sides=outward or [-1,1]
                for sign in sides:
                    if outward and d[0]*nx*sign+d[1]*ny*sign<=0:continue
                    projected=[]
                    for t in [left,right]:
                        x=a[0]+dx*t+sign*nx*thickness/2;y=a[1]+dy*t+sign*ny*thickness/2
                        for z in [low,high]:projected.append((x-d[0]/d[2]*(z-ref),y-d[1]/d[2]*(z-ref)))
                    margin=.05*scale
                    boxes.append((min(p[0] for p in projected)-margin,min(p[1] for p in projected)-margin,max(p[0] for p in projected)+margin,max(p[1] for p in projected)+margin))
    return boxes

def subdivide_cell(x0,y0,x1,y1,step,bounds):
    fine=any(x1>bx0 and x0<bx1 and y1>by0 and y0<by1 for bx0,by0,bx1,by1 in bounds)
    nx=max(1,math.ceil((x1-x0)/step-1e-8)) if fine else 1
    ny=max(1,math.ceil((y1-y0)/step-1e-8)) if fine else 1
    for x in range(nx):
        for y in range(ny):yield (x0+(x1-x0)*x/nx,y0+(y1-y0)*y/ny,x0+(x1-x0)*(x+1)/nx,y0+(y1-y0)*(y+1)/ny)

def _rows(result):
    rows=result.get('allocations') or [{**r,'allocationId':r.get('allocationId') or r['spaceId']} for r in result.get('spaces',[])]
    return {r['allocationId']:r for r in rows}

def _positive_ratios(result,model):
    owners={s['id']:s.get('allocationId') or s['id'] for s in model.get('spaces',[])};areas={};scale=1e6 if model.get('model',{}).get('units')=='mm' else 1
    for grid in result.get('grids',[]):
        aid=owners.get(grid['spaceId'],grid['spaceId']);total,positive=areas.get(aid,(0,0))
        for face,hours in zip(grid['faces'],grid['hours']):
            ps=[grid['vertices'][i] for i in face];ps.append(ps[0]);area=abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(ps,ps[1:])))/2/scale
            total+=area
            if hours>1e-9:positive+=area
        areas[aid]=(total,positive)
    return {aid:positive/total if total else 0 for aid,(total,positive) in areas.items()}

def sampling_comparison(base,fine,model,config):
    a,b=_rows(base),_rows(fine);positive_a,positive_b=_positive_ratios(base,model),_positive_ratios(fine,model);rows=[]
    for space in model.get('spaces',[]):
        aid=space.get('allocationId') or space['id']
        if any(r['allocationId']==aid for r in rows):continue
        first,last=a.get(aid),b.get(aid);reason=None
        if not first or not last:reason='缺少一轮房间采样结果'
        mean_delta=abs(first['meanHours']-last['meanHours']) if first and last else None
        ratio_delta=abs(first['targetMetRatio']-last['targetMetRatio']) if first and last and first.get('targetMetRatio') is not None and last.get('targetMetRatio') is not None else None
        positive_delta=abs(positive_a.get(aid,0)-positive_b.get(aid,0))
        if mean_delta is not None and (mean_delta>MEAN_TOLERANCE or (ratio_delta is not None and ratio_delta>RATIO_TOLERANCE) or positive_delta>RATIO_TOLERANCE):reason='两级采样的房间指标变化超过容差'
        if first and last and (first['maxHours']<=1e-9)!=(last['maxHours']<=1e-9):reason='两级采样对是否存在日照的判断不一致'
        rows.append({'allocationId':aid,'status':'needs_review' if reason else 'converged','reason':reason,'baseTargetRatio':first.get('targetMetRatio') if first else None,'refinedTargetRatio':last.get('targetMetRatio') if last else None,'meanHoursDelta':mean_delta,'targetRatioDelta':ratio_delta,'positiveAreaRatioDelta':positive_delta})
    return {'method':'window-projection-adaptive','status':'needs_review' if any(r['status']!='converged' for r in rows) else 'converged','baseGridSpacing':config['sensors']['gridSpacing'],'baseFineStep':min(config['sensors']['gridSpacing'],BASE_FINE_STEP),'refinedFineStep':min(config['sensors']['gridSpacing']/2,REFINED_STEP),'ratioTolerance':RATIO_TOLERANCE,'meanHoursTolerance':MEAN_TOLERANCE,'rooms':rows}

def run_verified_residential(model,config,output_dir,engine):
    first_config=copy.deepcopy(config);first_config['_residentialSampling']={'fineStep':min(config['sensors']['gridSpacing'],BASE_FINE_STEP)}
    first=engine(model,first_config,Path(output_dir)/'sampling-base')
    import json
    base_dir=Path(output_dir)/'sampling-base';base_dir.mkdir(parents=True,exist_ok=True)
    (base_dir/'result.json').write_text(json.dumps(first),encoding='utf-8')
    if first.get('status')!='completed':return first
    second_config=copy.deepcopy(config);second_config['_residentialSampling']={'fineStep':min(config['sensors']['gridSpacing']/2,REFINED_STEP)}
    try:
        fine=engine(model,second_config,Path(output_dir)/'sampling-refined')
        if fine.get('status')!='completed':raise ValueError(fine.get('error','细化计算失败'))
    except Exception as error:
        first['sampling']={'method':'window-projection-adaptive','status':'needs_review','rooms':[{'allocationId':s.get('allocationId') or s['id'],'status':'needs_review','reason':str(error)} for s in model.get('spaces',[])]}
        first.setdefault('verification',{})['status']='needs_review';return first
    fine_dir=Path(output_dir)/'sampling-refined';fine_dir.mkdir(parents=True,exist_ok=True)
    (fine_dir/'result.json').write_text(json.dumps(fine),encoding='utf-8')
    fine['sampling']=sampling_comparison(first,fine,model,config)
    fine['verification']['checks'].append('住宅窗投影区域采用0.1m/0.05m两级细化，检查房间面积比例及日照时长变化')
    if fine['sampling']['status']!='converged':fine['verification']['status']='needs_review'
    return fine
