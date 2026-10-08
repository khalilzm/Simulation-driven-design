import { useRef } from 'react';

export function Upload({ onFile, disabled, kind = 'sketch', onError }: {
  onFile: (name: string, base64: string) => void; disabled: boolean; kind?: 'sketch' | 'dxf'; onError?: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) {
      onError?.('文件过大，请上传不超过 12 MB 的文件');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      onFile(file.name, base64);
    };
    reader.onerror = () => onError?.(`无法读取文件 ${file.name}`);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={kind === 'dxf' ? '.dxf,application/dxf' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'}
        aria-label={kind === 'dxf' ? '选择住宅 DXF 文件' : '选择草图文件'}
        style={{ display: 'none' }}
        onChange={handleChange}
      />
      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} title={kind === 'dxf' ? '上传含固定轮廓、入户口、承重墙和窗洞的住宅 DXF，直接解析显示' : '上传 PNG、JPEG 或 WebP 草图'}>
        {kind === 'dxf' ? '上传 DXF' : '上传草图'}
      </button>
    </>
  );
}
