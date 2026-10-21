import { useRef } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GattExplorer } from '../components/parser/GattExplorer';
import { useBleStore } from '../stores';

const hookMocks = vi.hoisted(() => ({
  readCharacteristic: vi.fn().mockResolvedValue([0x41, 0x00, 0x7e, 0xff]),
  writeCharacteristic: vi.fn().mockResolvedValue(undefined),
  subscribeNotifications: vi.fn().mockResolvedValue(undefined),
  unsubscribeNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../hooks', () => ({
  useBle: () => ({
    readCharacteristic: hookMocks.readCharacteristic,
    writeCharacteristic: hookMocks.writeCharacteristic,
    subscribeNotifications: hookMocks.subscribeNotifications,
    unsubscribeNotifications: hookMocks.unsubscribeNotifications,
  }),
}));

vi.mock('../stores/toastStore', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

const channelId = 'ble-test-channel';
const deviceId = 'ble-test-device';
const serviceUuid = '0000180d-0000-1000-8000-00805f9b34fb';
const characteristicUuid = '00002a37-0000-1000-8000-00805f9b34fb';
const privateServiceUuid = '8ce5cc01-0a4d-11e9-ab14-d663bd873d93';
const privateCharacteristicUuid = '8ce5cc02-0a4d-11e9-ab14-d663bd873d93';

function renderExpandedExplorer() {
  const BleCardHarness = () => {
    const cardRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={cardRef} data-testid="ble-card">
        <GattExplorer channelId={channelId} overlayContainerRef={cardRef} />
      </div>
    );
  };

  render(<BleCardHarness />);
  fireEvent.click(screen.getByRole('button', { name: /expand service/i }));
}

describe('GattExplorer characteristic actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBleStore.setState({
      subscribedCharacteristics: [],
      customUuidNames: { services: {}, characteristics: {} },
      channelStates: {
        [channelId]: {
          devices: [],
          connectedDeviceId: deviceId,
          gattServices: [
            {
              uuid: serviceUuid,
              characteristics: [
                {
                  uuid: characteristicUuid,
                  serviceUuid,
                  properties: ['read', 'write', 'notify', 'indicate'],
                },
              ],
            },
          ],
          subscribedCharacteristics: [],
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the R badge button and expands HEX and ASCII readback rows', async () => {
    renderExpandedExplorer();

    expect(screen.queryByRole('button', { name: 'Read' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Write' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /read heart rate measurement/i }));

    await waitFor(() => {
      expect(hookMocks.readCharacteristic).toHaveBeenCalledWith(
        deviceId,
        serviceUuid,
        characteristicUuid,
      );
    });
    expect(await screen.findByText('41 00 7e ff')).not.toBeNull();
    expect(screen.getByText('A.~.')).not.toBeNull();
    expect(screen.getByText('HEX')).not.toBeNull();
    expect(screen.getByText('ASCII')).not.toBeNull();
  });

  it('opens the W send dialog, writes HEX bytes, and closes after success', async () => {
    renderExpandedExplorer();

    fireEvent.click(screen.getByRole('button', { name: /write heart rate measurement/i }));
    const dialog = screen.getByRole('dialog', { name: 'Send characteristic data' });
    expect(dialog).not.toBeNull();
    expect(dialog.closest('[data-testid="ble-card"]')).toBe(screen.getByTestId('ble-card'));
    expect(dialog.parentElement?.className).toContain('backdrop-blur-sm');
    expect(dialog.parentElement?.className).toContain('bg-transparent');
    expect(dialog.parentElement?.className).toContain('inset-px');
    expect(dialog.parentElement?.className).toContain('rounded-[7px]');
    expect(dialog.parentElement?.className).not.toContain('bg-black');

    fireEvent.change(screen.getByLabelText('HEX data'), { target: { value: '41 00 7e ff' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(hookMocks.writeCharacteristic).toHaveBeenCalledWith(
        deviceId,
        serviceUuid,
        characteristicUuid,
        [0x41, 0x00, 0x7e, 0xff],
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Send characteristic data' })).toBeNull();
    });
  });

  it.each(['notifications', 'indications'])(
    'subscribes by clicking the %s property badge button',
    async (subscriptionType) => {
      renderExpandedExplorer();

      fireEvent.click(screen.getByRole('button', {
        name: new RegExp(`subscribe to ${subscriptionType}`, 'i'),
      }));

      await waitFor(() => {
        expect(hookMocks.subscribeNotifications).toHaveBeenCalledWith(
          deviceId,
          serviceUuid,
          characteristicUuid,
        );
      });
      expect(useBleStore.getState().channelStates[channelId].subscribedCharacteristics).toEqual([
        { serviceUuid, charUuid: characteristicUuid },
      ]);
    },
  );

  it('keeps characteristic names on one shared column when action counts differ', () => {
    useBleStore.setState({
      channelStates: {
        [channelId]: {
          devices: [],
          connectedDeviceId: deviceId,
          gattServices: [
            {
              uuid: serviceUuid,
              characteristics: [
                {
                  uuid: characteristicUuid,
                  serviceUuid,
                  properties: ['read'],
                },
                {
                  uuid: '00002a38-0000-1000-8000-00805f9b34fb',
                  serviceUuid,
                  properties: ['read', 'write', 'notify'],
                },
              ],
            },
          ],
          subscribedCharacteristics: [],
        },
      },
    });
    renderExpandedExplorer();

    const firstRow = screen.getByText('Heart Rate Measurement').parentElement;
    const secondRow = screen.getByText('Body Sensor Location').parentElement;

    expect(firstRow?.className).toContain('grid-cols-[minmax(0,47%)_minmax(0,1fr)_auto]');
    expect(secondRow?.className).toContain('grid-cols-[minmax(0,47%)_minmax(0,1fr)_auto]');
  });

  it('edits and remembers private service and characteristic UUID names from context menus', () => {
    useBleStore.setState({
      channelStates: {
        [channelId]: {
          devices: [],
          connectedDeviceId: deviceId,
          gattServices: [
            {
              uuid: privateServiceUuid,
              characteristics: [
                {
                  uuid: privateCharacteristicUuid,
                  serviceUuid: privateServiceUuid,
                  properties: ['write'],
                },
              ],
            },
          ],
          subscribedCharacteristics: [],
        },
      },
    });
    renderExpandedExplorer();

    fireEvent.contextMenu(screen.getByTitle(privateServiceUuid));
    expect(screen.getByRole('menu', { name: 'service UUID actions' })).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit service name…' }));
    fireEvent.change(screen.getByLabelText('Custom service name'), {
      target: { value: '私有控制服务' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('私有控制服务')).not.toBeNull();
    expect(useBleStore.getState().customUuidNames.services[privateServiceUuid]).toBe('私有控制服务');

    fireEvent.contextMenu(screen.getByTitle(privateCharacteristicUuid));
    expect(screen.getByRole('menu', { name: 'characteristic UUID actions' })).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit characteristic name…' }));
    fireEvent.change(screen.getByLabelText('Custom characteristic name'), {
      target: { value: '配置下发' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByText('配置下发')).not.toBeNull();
    expect(useBleStore.getState().customUuidNames.characteristics[privateCharacteristicUuid]).toBe('配置下发');

    fireEvent.contextMenu(screen.getByTitle(privateCharacteristicUuid));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset custom name' }));

    expect(screen.queryByText('配置下发')).toBeNull();
    expect(useBleStore.getState().customUuidNames.characteristics[privateCharacteristicUuid]).toBeUndefined();
  });
});
