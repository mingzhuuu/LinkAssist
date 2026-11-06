interface ChannelSelectionCircleProps {
  selected: number;
  total: number;
  filled?: boolean;
  unselectedColor?: string;
  className: string;
}

export function ChannelSelectionCircle({
  selected, total, filled = true, unselectedColor = 'color-mix(in srgb, currentColor 35%, transparent)', className,
}: ChannelSelectionCircleProps) {
  const coverage = total > 0 ? selected / total : 0;
  let background = 'currentColor';
  if (coverage > 0 && coverage < 1) {
    const stop = `${coverage * 100}%`;
    background = `conic-gradient(currentColor 0 ${stop}, ${unselectedColor} ${stop} 100%)`;
  } else if (!coverage && !filled) {
    background = unselectedColor;
  }
  return <span
    aria-hidden="true"
    className={`block shrink-0 rounded-full ${className}`}
    style={{ background, maskImage: filled ? undefined : 'radial-gradient(closest-side, transparent calc(100% - 1.5px), black calc(100% - 0.5px))' }}
  />;
}
