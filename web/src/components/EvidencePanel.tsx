import type { ReactNode } from 'react';

export function EvidencePanel({ title, collapsed, onToggle, children }: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <aside className={`evidence-panel${collapsed ? ' collapsed' : ''}`} aria-label={title}>
      <button
        type="button"
        className="evidence-panel-toggle"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? '展开证据面板' : '折叠证据面板'}
      >
        <span className="evidence-panel-title">{title}</span>
        <span className="evidence-panel-chevron">{collapsed ? '⟨' : '⟩'}</span>
      </button>
      {!collapsed && <div className="evidence-panel-body">{children}</div>}
    </aside>
  );
}
