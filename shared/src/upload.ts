export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export type DroppedUploadKind = 'dxf' | 'image';

/** DXF often arrives without a useful mime type, so the extension decides. Images accept either. */
export function classifyDroppedFile(name: string, type: string): DroppedUploadKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.dxf') || type === 'application/dxf' || type === 'image/vnd.dxf') return 'dxf';
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || /\.(png|jpe?g|webp)$/.test(lower)) return 'image';
  return null;
}
