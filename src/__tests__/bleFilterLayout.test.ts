import { describe, expect, it } from 'vitest';
import { resolveBleFilterLayout } from '../components/channels/ble/bleFilterLayout';

const layout = resolveBleFilterLayout;

describe('BLE filter layout', () => {
  it('compresses only spacing while every control remains at maximum width', () => {
    const wide = layout(596);
    const compressed = layout(582);
    const dense = layout(568);

    expect(wide).toMatchObject({
      stage: 'compress-gaps',
      outerGap: 12,
      rssiGap: 8,
      toggleGap: 8,
      nameWidth: 200,
      rssiWidth: 96,
      rssiValueWidth: 32,
    });
    expect(compressed).toMatchObject({ outerGap: 8, rssiGap: 6, toggleGap: 6 });
    expect(compressed.nameWidth).toBe(200);
    expect(compressed.rssiWidth).toBe(96);
    expect(dense).toMatchObject({ outerGap: 4, rssiGap: 4, toggleGap: 4 });
  });

  it('gradually compresses the name filter from maximum width to one half', () => {
    expect(layout(568)).toMatchObject({ nameWidth: 200 });
    expect(layout(518)).toMatchObject({
      stage: 'half-name',
      nameWidth: 150,
      rssiWidth: 96,
    });
    expect(layout(468)).toMatchObject({
      nameWidth: 100,
    });
  });

  it('gradually morphs the three text toggles into icons in order', () => {
    const halfName = layout(448);
    expect(halfName).toMatchObject({
      stage: 'icon-name',
      hasNameToggle: {
        progress: 0.5,
        labelWidth: 23,
        iconWidth: 6,
        paddingInline: 6.5,
      },
    });
    expect(halfName.hasServicesToggle.progress).toBe(0);
    expect(halfName.connectableToggle.progress).toBe(0);

    const halfServices = layout(401);
    expect(halfServices).toMatchObject({
      stage: 'icon-services',
      hasNameToggle: { progress: 1 },
      hasServicesToggle: {
        progress: 0.5,
        labelWidth: 30,
        iconWidth: 6,
      },
    });

    const halfConnectable = layout(348);
    expect(halfConnectable).toMatchObject({
      stage: 'icon-connectable',
      hasNameToggle: { progress: 1 },
      hasServicesToggle: { progress: 1 },
      connectableToggle: {
        progress: 0.5,
        labelWidth: 29,
        iconWidth: 6,
      },
    });
  });

  it('gradually collapses the RSSI value before resizing the final controls', () => {
    expect(layout(304)).toMatchObject({
      stage: 'hide-rssi-value',
      rssiGap: 2,
      rssiValueOpacity: 0.5,
      rssiValueWidth: 16,
      nameWidth: 100,
      rssiWidth: 96,
    });
    expect(layout(286)).toMatchObject({
      rssiGap: 0,
      rssiValueOpacity: 0,
      rssiValueWidth: 0,
    });
  });

  it('finally compresses the name and RSSI controls together to their minima', () => {
    const fluid = layout(239);
    const minimum = layout(192);

    expect(fluid).toMatchObject({
      stage: 'compress-controls',
      nameWidth: 78,
      rssiWidth: 72,
    });
    expect(minimum).toMatchObject({ nameWidth: 56, rssiWidth: 48 });
  });

  it('keeps every phase continuous at its boundary', () => {
    const beforeBoundary = layout(468.001);
    const afterBoundary = layout(467.999);

    expect(beforeBoundary.nameWidth).toBeCloseTo(afterBoundary.nameWidth, 2);
    expect(beforeBoundary.hasNameToggle.labelWidth).toBeCloseTo(
      afterBoundary.hasNameToggle.labelWidth,
      2,
    );
  });
});
