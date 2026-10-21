import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalTooltip } from '../components/common/GlobalTooltip';

describe('GlobalTooltip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows rounded tooltip on hover and hides on mouseout', async () => {
    render(
      <div>
        <button title="Double-click to rename">Tab Name</button>
        <GlobalTooltip />
      </div>
    );

    const button = screen.getByRole('button', { name: 'Tab Name' });
    expect(button).toBeDefined();

    // Hover over button
    act(() => {
      fireEvent.mouseOver(button);
      vi.advanceTimersByTime(200);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeDefined();
    expect(tooltip.textContent).toBe('Double-click to rename');
    expect(tooltip.className).toContain('rounded-2xl');
    expect(tooltip.className).toContain('border-border');
    expect(tooltip.className).toContain('bg-surface-overlay/95');
    expect(tooltip.className).toContain('shadow-xl');

    // Mouse out
    act(() => {
      fireEvent.mouseOut(button);
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
    // Verify title attribute is restored
    expect(button.getAttribute('title')).toBe('Double-click to rename');
  });

  it('works with data-tooltip attribute', async () => {
    render(
      <div>
        <button data-tooltip="Saved commands">Bookmark</button>
        <GlobalTooltip />
      </div>
    );

    const button = screen.getByRole('button', { name: 'Bookmark' });

    act(() => {
      fireEvent.mouseOver(button);
      vi.advanceTimersByTime(200);
    });

    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toBeDefined();
    expect(tooltip.textContent).toBe('Saved commands');
    expect(tooltip.className).toContain('rounded-2xl');
  });
});
