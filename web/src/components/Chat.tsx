import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';

export function Chat({
  messages,
  scrollAnchor,
}: {
  messages: ChatMessage[];
  /** 变化时滚到底部，便于留在对话区 */
  scrollAnchor?: unknown;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollAnchor === undefined) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [scrollAnchor, messages.length]);

  return (
    <div className="chat">
      {messages.length === 0 && (
        <div className="empty">在这里补充图纸信息或改造要求，助手的说明会保留在对话记录中。</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message ${m.role}`}>
          <div className="role">{m.role === 'user' ? '你' : 'Agent'}</div>
          {m.thinking && <div className="thinking-block">{m.thinking}</div>}
          <div className="bubble">
            {m.images?.map((img) => (
              <img key={img.url} className="chat-image" src={img.url} alt={img.alt} />
            ))}
            {m.content || (m.status === 'thinking' ? <span className="thinking">思考中…</span> : '')}
          </div>
          {m.progress && <div className="progress">{m.progress}</div>}
          {m.status === 'failed' && <div className="failed-mark">失败</div>}
        </div>
      ))}
      <div ref={endRef} className="chat-scroll-anchor" aria-hidden />
    </div>
  );
}
