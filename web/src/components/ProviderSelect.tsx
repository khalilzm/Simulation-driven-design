import type { ProviderId } from '@sdd/shared';

export interface ProviderOption {
  id: ProviderId;
  label: string;
  description: string;
  requiresLogin: boolean;
}

export function ProviderSelect({
  value,
  options,
  onChange,
}: {
  value: ProviderId;
  options: ProviderOption[];
  onChange: (p: ProviderId) => void;
}) {
  const current = options.find((o) => o.id === value);
  return (
    <div className="provider-select">
      <label htmlFor="provider">提供方</label>
      <select
        id="provider"
        value={value}
        onChange={(e) => onChange(e.target.value as ProviderId)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {current && <span className="hint">{current.description}</span>}
    </div>
  );
}
