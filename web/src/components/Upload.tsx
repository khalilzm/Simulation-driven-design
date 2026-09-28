import { useRef } from 'react';

export function Upload({ onFile, disabled }: { onFile: (name: string, base64: string) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      onFile(file.name, base64);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        style={{ display: 'none' }}
        onChange={handleChange}
      />
      <button type="button" disabled={disabled} onClick={() => inputRef.current?.click()} title="可选；也可仅用文字描述">
        上传草图
      </button>
    </>
  );
}
