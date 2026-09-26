import type { SpaceModel } from '@sdd/shared';
import { closePolygon } from './geometry';
import { inferSpaceTypes } from './inferSpaceTypes';

/** 校验前规范化 Agent 几何（补闭合点、推断 spaceTypes） */
export function normalizeAgentGeometry(model: SpaceModel): SpaceModel {
  const m = structuredClone(model);
  m.floor.boundary = closePolygon(m.floor.boundary);
  for (const space of m.spaces) {
    space.boundary = closePolygon(space.boundary);
  }
  inferSpaceTypes(m);
  return m;
}
