import { useState } from 'react';

export function Composer({
  disabled,
  onSend,
  placeholder = '向设计助手补充本轮要求…',
}: {
  disabled: boolean;
  onSend: (message: string) => void;
  placeholder?: string;
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
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
