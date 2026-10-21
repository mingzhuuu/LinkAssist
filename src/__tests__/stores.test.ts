import { describe, it, expect, beforeEach } from 'vitest';
import { LEFT_PANEL_MAX_WIDTH, LEFT_PANEL_MIN_WIDTH, normalizeBleUuidNames, useChannelStore, useUIStore, useBleStore, useSerialStore, useTcpStore } from '../stores';
import { BleDevice } from '../types';

describe('Store Tests', () => {
  beforeEach(() => {
    useChannelStore.setState({ channels: [], activeChannelId: null });
    useBleStore.setState({
      scanning: false,
      scanningChannelId: null,
      devices: [],
      connectedDeviceId: null,
      connectedChannelId: null,
      gattServices: [],
      channelStates: {},
      deviceChannelMap: {},
      bleFilters: {},
      subscribedCharacteristics: [],
      lastConnectedDeviceIds: {},
      lastConnectedDevices: {},
      customUuidNames: { services: {}, characteristics: {} },
    });
    useUIStore.setState({
      leftPanelWidth: 260,
      rightPanelWidth: 360,
      dataViewMode: 'text',
      showAddChannelMenu: false,
      terminalChannelSettings: {},
    });
    useSerialStore.setState({
      ports: [],
      openConnections: [],
      activeConfig: {
        path: '',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        receiveTimeoutMs: 50,
      },
    });
    useTcpStore.setState({
      mode: 'client',
      clientConnections: [],
      serverClients: [],
      serverListening: false,
      serverAddr: '',
      udpBound: false,
      udpAddr: '',
    });
  });

  it('channelStore: should add, remove and select channels', () => {
    const store = useChannelStore.getState();
    expect(store.channels.length).toBe(0);

    const firstId = store.addChannel('ble', 'Test BLE Device');
    const newState = useChannelStore.getState();
    expect(newState.channels.length).toBe(1);
    expect(newState.channels[0].type).toBe('ble');
    expect(newState.channels[0].name).toBe('Test BLE Device');
    expect(newState.channels[0].state).toBe('disconnected');

    const id = newState.channels[0].id;
    expect(id).toBe(firstId);
    newState.renameChannel(id, 'Renamed BLE Device');
    expect(useChannelStore.getState().channels[0].name).toBe('Renamed BLE Device');

    const secondId = useChannelStore.getState().addChannel('serial', 'UART');
    useChannelStore.getState().reorderChannel(secondId, id);
    expect(useChannelStore.getState().channels.map(channel => channel.id)).toEqual([secondId, id]);

    newState.setActiveChannel(id);
    expect(useChannelStore.getState().activeChannelId).toBe(id);

    useChannelStore.getState().removeChannel(id);
    const finalState = useChannelStore.getState();
    expect(finalState.channels.map(channel => channel.id)).toEqual([secondId]);
    expect(finalState.activeChannelId).toBeNull();
  });

  it('channelStore: should keep channel IDs unique across adds and persistence restores', () => {
    const store = useChannelStore.getState();
    store.addChannel('ble', 'BLE', 'ble-1');
    store.addChannel('serial', 'Duplicate ID', 'ble-1');

    expect(useChannelStore.getState().channels).toHaveLength(1);
    expect(useChannelStore.getState().channels[0]).toMatchObject({
      id: 'ble-1',
      type: 'ble',
      name: 'BLE',
    });

    const persistedChannels = [
      { id: 'ble-1', type: 'ble' as const, name: 'BLE' },
      { id: 'serial-1', type: 'serial' as const, name: 'UART' },
      { id: 'ble-1', type: 'ble' as const, name: 'Duplicated BLE' },
    ];

    store.restoreChannels(persistedChannels);
    store.restoreChannels(persistedChannels);

    expect(useChannelStore.getState().channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      name: channel.name,
    }))).toEqual([
      { id: 'ble-1', type: 'ble', name: 'BLE' },
      { id: 'serial-1', type: 'serial', name: 'UART' },
    ]);
  });

  it('uiStore: should update panel widths and view mode', () => {
    const store = useUIStore.getState();
    store.setLeftPanelWidth(300);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MAX_WIDTH);
    store.setLeftPanelWidth(20);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);

    store.setRightPanelWidth(400);
    expect(useUIStore.getState().rightPanelWidth).toBe(400);

    store.setDataViewMode('image');
    expect(useUIStore.getState().dataViewMode).toBe('chart');
    
    store.setShowAddChannelMenu(true);
    expect(useUIStore.getState().showAddChannelMenu).toBe(true);

    store.setChannelQuickOpenSelectedIds(['channel-a', 'channel-b']);
    expect(useUIStore.getState().channelQuickOpenSelectedIds).toEqual(['channel-a', 'channel-b']);

    store.setFileDialogDir('mcp', 'D:\\Workspace\\mcp');
    expect(useUIStore.getState().fileDialogDirs).toMatchObject({
      layout: '',
      mcp: 'D:\\Workspace\\mcp',
      protocol: '',
      script: '',
    });
  });

  it('uiStore: should publish a new canvas viewport reset signal', () => {
    const previousVersion = useUIStore.getState().canvasViewportResetVersion;

    useUIStore.getState().resetCanvasViewport();

    expect(useUIStore.getState().canvasViewportResetVersion).toBe(previousVersion + 1);
  });

  it('uiStore: keeps terminal display settings isolated per channel', () => {
    const store = useUIStore.getState();
    store.setTerminalChannelSettings('serial-a', {
      sendFormat: 'hex',
      receiveFormat: 'ascii',
      showInputPrefix: false,
      showTimestamp: true,
    });
    store.setTerminalChannelSettings('serial-b', {
      sendFormat: 'ascii',
      receiveFormat: 'hex',
      showInputPrefix: true,
      showTimestamp: false,
    });

    expect(useUIStore.getState().terminalChannelSettings).toEqual({
      'serial-a': {
        sendFormat: 'hex',
        receiveFormat: 'ascii',
        showInputPrefix: false,
        showTimestamp: true,
      },
      'serial-b': {
        sendFormat: 'ascii',
        receiveFormat: 'hex',
        showInputPrefix: true,
        showTimestamp: false,
      },
    });
  });

  it('bleStore: should update devices correctly', () => {
    const store = useBleStore.getState();
    const testDevice: BleDevice = {
      id: 'test-id',
      name: 'Test Device',
      rssi: -50,
      serviceUuids: [],
      manufacturerData: {}
    };

    store.setDevices([testDevice]);
    expect(useBleStore.getState().devices.length).toBe(1);
    expect(useBleStore.getState().devices[0].name).toBe('Test Device');

    store.clearDevices();
    expect(useBleStore.getState().devices.length).toBe(0);
  });

  it('bleStore: should keep channel subscription state and last connected device snapshot', () => {
    const store = useBleStore.getState();
    const channelId = 'ch-ble-1';
    const testDevice: BleDevice = {
      id: 'test-id',
      name: 'Test Device',
      rssi: -50,
      serviceUuids: ['180D'],
      manufacturerData: {},
    };

    store.setDevices([testDevice], channelId);
    store.setLastConnectedDeviceId(channelId, testDevice.id);
    store.setLastConnectedDevice(channelId, testDevice);
    store.addSubscription('180D', '2A37', channelId);

    const bleState = useBleStore.getState();
    expect(bleState.getChannelState(channelId).subscribedCharacteristics).toEqual([
      { serviceUuid: '180D', charUuid: '2A37' },
    ]);
    expect(bleState.lastConnectedDevices[channelId]).toEqual({
      id: 'test-id',
      name: 'Test Device',
      advertisementName: null,
      serviceUuids: ['180D'],
    });
  });

  describe('serialStore', () => {
    it('should manage ports, connections, and config', () => {
      const store = useSerialStore.getState();

      const ports = [{ path: 'COM1', portType: 'usb' }];
      store.setPorts(ports);
      expect(useSerialStore.getState().ports).toEqual(ports);

      store.addConnection('COM1', 'ch-serial-1');
      expect(useSerialStore.getState().openConnections).toEqual(['COM1']);
      expect(useSerialStore.getState().connectionMap['COM1']).toBe('ch-serial-1');

      store.removeConnection('COM1');
      expect(useSerialStore.getState().openConnections).toEqual([]);

      store.setActiveConfig({ baudRate: 9600, parity: 'even' });
      expect(useSerialStore.getState().activeConfig.baudRate).toBe(9600);
      expect(useSerialStore.getState().activeConfig.parity).toBe('even');
    });
  });

  it('bleStore: should normalize, replace, and remove custom UUID names', () => {
    const store = useBleStore.getState();

    store.replaceCustomUuidNames(normalizeBleUuidNames({
      services: { ' 0000ABCD-0000-1000-8000-00805F9B34FB ': ' Private Service ' },
      characteristics: { EF01: 'Private Characteristic', ignored: 42 },
    }));
    store.setCustomUuidName('characteristic', ' EF02 ', ' Control Point ');

    expect(useBleStore.getState().customUuidNames).toEqual({
      services: { abcd: 'Private Service' },
      characteristics: {
        ef01: 'Private Characteristic',
        ef02: 'Control Point',
      },
    });

    store.setCustomUuidName('service', 'ABCD', '   ');
    expect(useBleStore.getState().customUuidNames.services).toEqual({});
  });

  describe('tcpStore', () => {
    it('should manage mode, connections, listening, and binding', () => {
      const store = useTcpStore.getState();

      store.setMode('udp');
      expect(useTcpStore.getState().mode).toBe('udp');

      store.addClientConnection({ id: 'c1', addr: '127.0.0.1:8000' }, 'ch-tcp-1');
      expect(useTcpStore.getState().clientConnections).toEqual([{ id: 'c1', addr: '127.0.0.1:8000' }]);
      expect(useTcpStore.getState().connectionMap['c1']).toBe('ch-tcp-1');

      store.setServerListening(true, '0.0.0.0:9000');
      expect(useTcpStore.getState().serverListening).toBe(true);
      expect(useTcpStore.getState().serverAddr).toBe('0.0.0.0:9000');

      store.setUdpBound(true, '0.0.0.0:7000');
      expect(useTcpStore.getState().udpBound).toBe(true);
      expect(useTcpStore.getState().udpAddr).toBe('0.0.0.0:7000');
    });
  });
});
