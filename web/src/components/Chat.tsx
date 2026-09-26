import type { ChatMessage } from '../types';

export function Chat({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="chat">
      {messages.length === 0 && (
        <div className="empty">选择一个提供方并输入需求，开始空间设计对话。</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message ${m.role}`}>
          <div className="role">{m.role === 'user' ? '你' : 'Agent'}</div>
          {m.thinking && <div className="thinking-block">{m.thinking}</div>}
          <div className="bubble">
            {m.content || (m.status === 'thinking' ? <span className="thinking">思考中…</span> : '')}
          </div>
          {m.progress && <div className="progress">{m.progress}</div>}
          {m.status === 'failed' && <div className="failed-mark">失败</div>}
        </div>
      ))}
    </div>
  );
}
