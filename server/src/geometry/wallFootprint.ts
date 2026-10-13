import type { Vec2, Wall } from '@sdd/shared';

export function footprint(wall: Wall, a: Vec2, b: Vec2): Vec2[] {
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
  const nx=-(b[1]-a[1])/length*wall.thickness/2,ny=(b[0]-a[0])/length*wall.thickness/2;
  return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny],[a[0]+nx,a[1]+ny]];
}
