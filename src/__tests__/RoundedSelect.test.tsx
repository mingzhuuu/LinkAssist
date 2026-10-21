import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RoundedSelect } from '../components/common/RoundedSelect';

describe('RoundedSelect', () => {
  it('shows the selected option information while disabled', () => {
    const { container } = render(
      <RoundedSelect
        value="COM3"
        options={[{ value: 'COM3', label: 'COM3', title: 'USB Serial Device' }]}
        onChange={() => undefined}
        disabled
      />
    );

    const selectContainer = container.firstElementChild;
    expect(selectContainer).not.toBeNull();

    fireEvent.mouseEnter(selectContainer!);

    const tooltip = screen.getByText('USB Serial Device');
    expect(tooltip.className).toContain('z-[10010]');
  });
});
