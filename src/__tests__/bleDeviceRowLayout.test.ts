import { describe, expect, it } from 'vitest';
import {
  didBlePanelWidthChange,
  resolveBleDeviceNameColumnWidth,
  resolveBleDeviceRowLayout,
} from '../components/channels/ble/bleDeviceRowLayout';

describe('BLE device row responsive layout', () => {
  it('only enables name measurement after an actual panel resize', () => {
    expect(didBlePanelWidthChange(null, 620)).toBe(false);
    expect(didBlePanelWidthChange(620, 620)).toBe(false);
    expect(didBlePanelWidthChange(620, 620.25)).toBe(false);
    expect(didBlePanelWidthChange(620, 621)).toBe(true);
  });

  it('derives a shared name-column maximum from the longest visible name', () => {
    expect(resolveBleDeviceNameColumnWidth([])).toBe(64);
    expect(resolveBleDeviceNameColumnWidth([42, 108.2, 76])).toBe(113);
    expect(resolveBleDeviceNameColumnWidth([400])).toBe(320);
  });

  it('keeps the full name and fields while the row can distribute its gaps', () => {
    expect(resolveBleDeviceRowLayout(650)).toEqual({
      macMarginLeft: 0,
      macOpacity: 1,
      macWidth: 128,
      nameWidth: 120,
      rowGap: 4,
      serviceMarginLeft: 0,
      serviceOpacity: 1,
      serviceWidth: 48,
      signalMarginLeft: 0,
      signalOpacity: 1,
      signalWidth: 64,
    });
  });

  it('gradually compresses a long name to its twelve-character width first', () => {
    expect(resolveBleDeviceRowLayout(556, 120, 96)).toMatchObject({
      nameWidth: 108,
      macWidth: 128,
      signalWidth: 64,
    });
    expect(resolveBleDeviceRowLayout(544, 120, 96)).toMatchObject({
      nameWidth: 96,
      macWidth: 128,
      signalWidth: 64,
    });
  });

  it('then gradually removes the SVC tag and its extra gap', () => {
    expect(resolveBleDeviceRowLayout(518, 120, 96)).toMatchObject({
      nameWidth: 96,
      macWidth: 128,
      serviceMarginLeft: -2,
      serviceOpacity: 0.5,
      serviceWidth: 24,
    });
    expect(resolveBleDeviceRowLayout(492, 120, 96)).toMatchObject({
      macWidth: 128,
      serviceMarginLeft: -4,
      serviceOpacity: 0,
      serviceWidth: 0,
    });
  });

  it('then gradually compacts the MAC address while keeping XX:XX visible', () => {
    expect(resolveBleDeviceRowLayout(452, 120, 96)).toMatchObject({
      nameWidth: 96,
      macMarginLeft: 0,
      macOpacity: 1,
      macWidth: 88,
      signalWidth: 64,
    });
    expect(resolveBleDeviceRowLayout(412, 120, 96)).toMatchObject({
      macMarginLeft: 0,
      macOpacity: 1,
      macWidth: 48,
      signalWidth: 64,
    });
  });

  it('then gradually hides the RSSI number while retaining its signal icon', () => {
    expect(resolveBleDeviceRowLayout(389, 120, 96)).toMatchObject({
      nameWidth: 96,
      macWidth: 48,
      signalMarginLeft: 0,
      signalOpacity: 1,
      signalWidth: 41,
    });
    expect(resolveBleDeviceRowLayout(366, 120, 96)).toMatchObject({
      nameWidth: 96,
      signalMarginLeft: 0,
      signalOpacity: 1,
      signalWidth: 18,
    });
  });

  it('performs the final name compression after the fixed fields are compact', () => {
    expect(resolveBleDeviceRowLayout(350, 120, 96)).toMatchObject({
      nameWidth: 80,
      macWidth: 48,
      signalWidth: 18,
    });
    expect(resolveBleDeviceRowLayout(334, 120, 96)).toMatchObject({
      nameWidth: 64,
      macWidth: 48,
      signalWidth: 18,
    });
  });

  it('uses measured full and twelve-character widths to shift the sequence', () => {
    expect(resolveBleDeviceRowLayout(598, 120, 96)).toMatchObject({ nameWidth: 120 });
    expect(resolveBleDeviceRowLayout(598, 200, 100)).toMatchObject({
      nameWidth: 150,
      macWidth: 128,
    });
    expect(resolveBleDeviceRowLayout(548, 200, 100)).toMatchObject({
      nameWidth: 100,
      macWidth: 128,
    });
  });

  it('does not shorten names whose measured width already fits the compact target', () => {
    expect(resolveBleDeviceRowLayout(548, 90, 90)).toMatchObject({
      nameWidth: 90,
      macWidth: 128,
    });
  });

  it('changes every animated field continuously across the full shrink range', () => {
    const fields = [
      'nameWidth',
      'macWidth',
      'signalWidth',
      'serviceWidth',
      'serviceOpacity',
      'serviceMarginLeft',
    ] as const;

    for (let width = 598; width > 300; width -= 1) {
      const wider = resolveBleDeviceRowLayout(width, 120, 96);
      const narrower = resolveBleDeviceRowLayout(width - 1, 120, 96);
      fields.forEach((field) => {
        expect(Math.abs(wider[field] - narrower[field])).toBeLessThanOrEqual(1);
      });
    }
  });
});
