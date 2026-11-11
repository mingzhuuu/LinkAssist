import React from 'react';

export const SettingGroup: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <section className="settings-group mb-6">
    {title && <h3 className="mb-3 text-[14px] font-semibold text-text-primary">{title}</h3>}
    <div className="settings-card rounded-2xl border border-border bg-surface-secondary dark:bg-surface-overlay px-4 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.08)] dark:shadow-[0_4px_12px_-2px_rgba(0,0,0,0.35)]">
      {React.Children.toArray(children).map((child, index) => (
        <div key={React.isValidElement(child) ? child.key ?? index : index} className="settings-group-item">
          {child}
        </div>
      ))}
    </div>
  </section>
);

export const ToggleSetting: React.FC<{
  title: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
}> = ({ title, description, checked, onChange, disabled, pending }) => (
  <div className="settings-row">
    <div className="min-w-0">
      <div className="text-[13px] font-semibold text-text-primary">{title}</div>
      {description && <div className="mt-1 text-[12px] leading-5 text-text-secondary">{description}</div>}
    </div>
    <SettingSwitch label={title} checked={checked} disabled={disabled} pending={pending} onChange={onChange} />
  </div>
);


export const SettingSwitch: React.FC<{
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
}> = ({ label, checked, onChange, disabled, pending }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      aria-disabled={disabled || pending || undefined}
      className={`relative shrink-0 h-5 w-9 rounded-full transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-blue disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? 'bg-accent-blue' : 'bg-[var(--layer-active)]'
      }`}
      onClick={() => { if (!pending) onChange(!checked); }}
    >
      <div
        className={`absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
);
