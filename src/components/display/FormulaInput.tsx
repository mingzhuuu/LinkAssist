import { useId } from 'react';
import { numericExpressionError } from '../../lib/numericExpression';

export function FormulaInput({ value, onChange, placeholder, containerClassName }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  containerClassName?: string;
}) {
  const id = useId();
  const error = /^@(Timestamp|ChannelName)(?:\(|$)/.test(value) ? null : numericExpressionError(value);
  return (
    <div className={containerClassName}>
      <input type="text" className="input-base w-full text-sm" value={value}
        onChange={event => onChange(event.target.value)} placeholder={placeholder}
        aria-invalid={!!error} aria-describedby={error ? id : undefined} />
      {error && <p id={id} role="alert" className="mt-1 text-xs text-accent-red">
        {error}. Use numbers, column names, arithmetic and Math functions.
      </p>}
    </div>
  );
}
