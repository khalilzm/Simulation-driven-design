import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { classifyDroppedFile, MAX_UPLOAD_BYTES, readUploadFile, type DroppedUploadKind } from '../uploadFile';

export function ChatDropZone({ disabled, onFile, onError, children }: {
  disabled: boolean;
  onFile: (kind: DroppedUploadKind, name: string, base64: string) => Promise<void> | void;
  onError: (message: string) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  const hasFiles = (event: DragEvent) => {
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  };
  const dragEnter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current += 1;
    setOver(true);
  };
  const dragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };
  const dragLeave = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const drop = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setOver(false);
    if (disabled) {
      onError('当前任务进行中，请稍后再拖入文件');
      return;
    }
    void acceptDroppedFiles([...event.dataTransfer.files], onFile, onError);
  };

  return <div className={`chat-dropzone${over ? ' is-dragover' : ''}`} onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
    {children}
    {over && <div className="chat-dropzone__hint">松开以上传 DXF 或图片</div>}
  </div>;
}

async function acceptDroppedFiles(files: File[], onFile: (kind: DroppedUploadKind, name: string, base64: string) => Promise<void> | void, onError: (message: string) => void) {
  const accepted: { file: File; kind: DroppedUploadKind }[] = [];
  for (const file of files) {
    const kind = classifyDroppedFile(file.name, file.type);
    if (!kind) {
      onError(`不支持 ${file.name}。请拖入 DXF，或 PNG、JPEG、WebP 图片。`);
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      onError(`${file.name} 过大，请上传不超过 12 MB 的文件`);
      continue;
    }
    accepted.push({ file, kind });
  }
  for (const item of accepted) {
    try {
      const base64 = await readUploadFile(item.file);
      await onFile(item.kind, item.file.name, base64);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
}
