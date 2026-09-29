import { inputFileUrl } from './api';

export interface ChatImage {
  url: string;
  alt: string;
}

export function chatImageFromInputPath(sessionId: string, filePath: string): ChatImage {
  const name = filePath.includes('/') ? filePath.split('/').pop()! : filePath;
  return {
    url: `${inputFileUrl(sessionId, name)}?t=${Date.now()}`,
    alt: name === 'sketch-preview.png' ? '矢量化预览' : name,
  };
}
