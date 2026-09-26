/** 可由 Agent 通过改墙/改 space boundary 修正的校验错误关键词 */
const GEOMETRY_ERROR_MARKERS = [
  '超出 floor 外轮廓',
  '边线穿出 floor',
  '几何超出 floor 外轮廓',
  '区域重叠',
];

export function isGeometryValidationError(message: string): boolean {
  return GEOMETRY_ERROR_MARKERS.some((m) => message.includes(m));
}

export function filterGeometryValidationErrors(errors: string[]): string[] {
  return errors.filter(isGeometryValidationError);
}

export function hasGeometryValidationErrors(errors: string[]): boolean {
  return filterGeometryValidationErrors(errors).length > 0;
}
