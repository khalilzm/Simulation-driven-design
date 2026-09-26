import { useState } from 'react';

export function Composer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (message: string) => void;
}) {
  const [text, setText] = useState('');

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder="描述你的空间设计需求…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button disabled={disabled || !text.trim()} onClick={submit}>
        发送
      </button>
    </div>
  );
}
