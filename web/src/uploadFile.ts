export { classifyDroppedFile, MAX_UPLOAD_BYTES, type DroppedUploadKind } from '@sdd/shared';

export function readUploadFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}`));
    reader.readAsDataURL(file);
  });
}
