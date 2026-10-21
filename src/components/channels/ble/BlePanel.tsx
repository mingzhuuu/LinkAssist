import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useBle } from '../../../hooks';
import { useBleStore } from '../../../stores';
import { DEFAULT_BLE_FILTERS } from '../../../stores/bleStore';
import type { BlePairingStatus } from '../../../types';
import {
  BluetoothIcon,
  SignalIcon,
  ChevronDownIcon,
  SearchIcon,
  LinkIcon,
  GridIcon,
  PhoneIcon,
  ComputerIcon,
  WatchIcon,
  ClockIcon,
  DisplayIcon,
  RemoteIcon,
  GlassesIcon,
  TagIcon,
  KeyIcon,
  MediaIcon,
  ThermometerIcon,
  HeartIcon,
  BloodPressureIcon,
  HidIcon,
  SensorIcon,
  LightIcon,
  FanIcon,
  HvacIcon,
  LockIcon,
  PowerIcon,
  SpeakerIcon,
  MicIcon,
  HeadphoneIcon,
  GamepadIcon,
  GlucoseIcon,
  RunningIcon,
  CyclingIcon,
  WeightIcon,
  PulseIcon,
  WheelchairIcon,
  InsulinIcon,
} from '../../common/Icons';
import { GattExplorer } from '../../parser';
import { toast } from '../../../stores/toastStore';
import {
  AD_TYPE_NAMES,
  COMPANY_IDENTIFIERS,
  formatBleAppearance,
  formatBleAppearanceValue,
  getAppearanceIconName,
  getAppearanceName,
  getServiceName,
  inferAppearanceFromServices,
  resolveBleDeviceAppearance,
} from '../../../lib';
import {
  BLE_FILTER_TOGGLE_LABEL_WIDTHS,
  resolveBleFilterLayout,
  type BleFilterToggleLayout,
} from './bleFilterLayout';
import {
  didBlePanelWidthChange,
  resolveBleDeviceNameColumnWidth,
  resolveBleDeviceRowLayout,
} from './bleDeviceRowLayout';

const APPEARANCE_ICONS = {
  PhoneIcon,
  ComputerIcon,
  WatchIcon,
  ClockIcon,
  DisplayIcon,
  RemoteIcon,
  GlassesIcon,
  TagIcon,
  KeyIcon,
  MediaIcon,
  ThermometerIcon,
  HeartIcon,
  BloodPressureIcon,
  HidIcon,
  SensorIcon,
  LightIcon,
  FanIcon,
  HvacIcon,
  LockIcon,
  PowerIcon,
  SpeakerIcon,
  MicIcon,
  HeadphoneIcon,
  GamepadIcon,
  GlucoseIcon,
  RunningIcon,
  CyclingIcon,
  WeightIcon,
  PulseIcon,
  WheelchairIcon,
  InsulinIcon,
  BluetoothIcon,
} as const;

const APPEARANCE_ICONS_RECORD: Record<string, React.FC<React.SVGProps<SVGSVGElement> & { size?: number }>> = APPEARANCE_ICONS;
const COMPANY_IDENTIFIERS_RECORD: Record<number, string> = COMPANY_IDENTIFIERS;

function applyDeviceRowLayoutVariables(
  element: HTMLDivElement,
  panelWidth: number,
  nameColumnWidth: number,
  twelveCharacterNameColumnWidth: number,
) {
  const layout = resolveBleDeviceRowLayout(
    panelWidth,
    nameColumnWidth,
    twelveCharacterNameColumnWidth,
  );
  element.style.setProperty('--ble-device-name-width', `${layout.nameWidth}px`);
  element.style.setProperty('--ble-device-name-full-width', `${nameColumnWidth}px`);
  element.style.setProperty('--ble-device-row-gap', `${layout.rowGap}px`);
  element.style.setProperty('--ble-device-mac-margin-left', `${layout.macMarginLeft}px`);
  element.style.setProperty('--ble-device-mac-opacity', `${layout.macOpacity}`);
  element.style.setProperty('--ble-device-mac-width', `${layout.macWidth}px`);
  element.style.setProperty('--ble-device-service-margin-left', `${layout.serviceMarginLeft}px`);
  element.style.setProperty('--ble-device-service-opacity', `${layout.serviceOpacity}`);
  element.style.setProperty('--ble-device-service-width', `${layout.serviceWidth}px`);
  element.style.setProperty('--ble-device-signal-margin-left', `${layout.signalMarginLeft}px`);
  element.style.setProperty('--ble-device-signal-opacity', `${layout.signalOpacity}`);
  element.style.setProperty('--ble-device-signal-width', `${layout.signalWidth}px`);
}

const DEFAULT_DEVICE_NAME_COLUMN_WIDTH = 120;
const DEFAULT_TWELVE_CHARACTER_NAME_COLUMN_WIDTH = 96;
const DEVICE_NAME_MEASUREMENT_SETTLE_MS = 140;

interface DeviceNameColumnWidths {
  full: number;
  twelveCharacters: number;
}

function measureDeviceNameColumnWidths(
  container: HTMLDivElement | null,
): DeviceNameColumnWidths | null {
  if (!container) return null;

  const renderedNameWidths = Array.from(
    container.querySelectorAll<HTMLElement>('[data-ble-device-name-text="full"]'),
    (nameElement) => nameElement.getBoundingClientRect().width,
  );
  if (renderedNameWidths.length === 0) return null;

  const renderedTwelveCharacterNameWidths = Array.from(
    container.querySelectorAll<HTMLElement>('[data-ble-device-name-text="twelve"]'),
    (nameElement) => nameElement.getBoundingClientRect().width,
  );
  const full = resolveBleDeviceNameColumnWidth(renderedNameWidths);
  const twelveCharacters = renderedTwelveCharacterNameWidths.length > 0
    ? Math.min(full, resolveBleDeviceNameColumnWidth(renderedTwelveCharacterNameWidths))
    : Math.min(full, DEFAULT_TWELVE_CHARACTER_NAME_COLUMN_WIDTH);

  return { full, twelveCharacters };
}

function formatHexBytes(data: number[]): string {
  return data.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

type PanelSizeTier = 'full' | 'medium' | 'compact' | 'tight';

const TIER_ORDER: PanelSizeTier[] = ['full', 'medium', 'compact', 'tight'];
// Boundary between TIER_ORDER[i] and TIER_ORDER[i + 1], in px.
const TIER_BOUNDARIES = [680, 560, 460];
// Widths within this distance of a boundary keep the current tier, so chips
// don't flap open/closed while the divider sits right on a breakpoint.
const TIER_HYSTERESIS_PX = 6;

function resolveSizeTier(width: number, previous: PanelSizeTier): PanelSizeTier {
  const previousIndex = TIER_ORDER.indexOf(previous);
  let index = 0;
  for (let i = 0; i < TIER_BOUNDARIES.length; i += 1) {
    const bias = previousIndex > i ? TIER_HYSTERESIS_PX : -TIER_HYSTERESIS_PX;
    if (width < TIER_BOUNDARIES[i] + bias) index = i + 1;
  }
  return TIER_ORDER[index];
}

// Width collapse for breakpoint-driven chips: content stays mounted and its
// grid track animates 1fr -> 0fr, so resizing slides it closed instead of
// unmounting with a layout jump. `hiddenMargin` must be the negative of the
// parent flex gap (gap-2 -> -ml-2) so the gap slot collapses along with it.
const Collapse: React.FC<{
  hidden: boolean;
  hiddenMargin: string;
  visibleMargin?: string;
  className?: string;
  children: React.ReactNode;
}> = ({ hidden, hiddenMargin, visibleMargin = 'ml-0', className = '', children }) => (
  <div
    aria-hidden={hidden}
    className={`grid transition-[grid-template-columns,margin,opacity,visibility] duration-200 ease-out motion-reduce:transition-none ${
      hidden
        ? `grid-cols-[0fr] opacity-0 invisible ${hiddenMargin}`
        : `grid-cols-[1fr] opacity-100 visible ${visibleMargin}`
    } ${className}`}
  >
    <div className="flex min-w-0 items-center overflow-hidden">{children}</div>
  </div>
);

// Pill toggle whose label, icon, and padding consume interpolated CSS variables.
// This makes the full-label -> icon-only change follow panel width continuously.
const FilterToggle: React.FC<{
  active: boolean;
  label: string;
  layoutKey: 'connectable' | 'has-services' | 'has-name';
  fullLabelWidth: number;
  icon: React.FC<React.SVGProps<SVGSVGElement> & { size?: number }>;
  onClick: () => void;
}> = ({ active, label, layoutKey, fullLabelWidth, icon: Icon, onClick }) => {
  const variablePrefix = `--ble-filter-${layoutKey}`;
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-6 shrink-0 items-center overflow-hidden rounded-full border transition-[padding,background-color,border-color,color] duration-200 ease-out motion-reduce:transition-none ${
        active
          ? 'bg-accent-blue/15 border-accent-blue/30 text-accent-blue'
          : 'bg-transparent border-border text-text-muted hover:bg-[var(--layer-hover)]'
      }`}
      style={{ paddingInline: `var(${variablePrefix}-padding, 8px)` }}
    >
      <span
        aria-hidden
        className="flex shrink-0 items-center overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{
          opacity: `var(${variablePrefix}-icon-opacity, 0)`,
          width: `var(${variablePrefix}-icon-width, 0px)`,
        }}
      >
        <Icon className="h-3 w-3 shrink-0" />
      </span>
      <span
        className="overflow-hidden whitespace-nowrap text-[10px] transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{
          opacity: `var(${variablePrefix}-label-opacity, 1)`,
          width: `var(${variablePrefix}-label-width, ${fullLabelWidth}px)`,
        }}
      >
        {label}
      </span>
    </button>
  );
};

export const BlePanel = React.memo(function BlePanel({ channelId }: { channelId: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const filterAreaRef = useRef<HTMLDivElement>(null);
  const deviceNameMeasureRef = useRef<HTMLDivElement>(null);
  const gattCardRef = useRef<HTMLDivElement>(null);
  const deviceNameColumnWidthsRef = useRef<DeviceNameColumnWidths>({
    full: DEFAULT_DEVICE_NAME_COLUMN_WIDTH,
    twelveCharacters: DEFAULT_TWELVE_CHARACTER_NAME_COLUMN_WIDTH,
  });
  const previousPanelWidthRef = useRef<number | null>(null);
  const pairingQueryIdsRef = useRef(new Set<string>());
  const pairingGenerationRef = useRef(0);
  const {
    startScan,
    stopScan,
    connectDevice,
    disconnectDevice,
    getPairingStatuses,
    scanning,
    devices,
  } = useBle();
  const { scanningChannelId, channelStates, bleFilters, lastConnectedDevices, setBleFilters } = useBleStore();
  const [sizeTier, setSizeTier] = useState<PanelSizeTier>('full');
  const [pairingStatuses, setPairingStatuses] = useState<Record<string, BlePairingStatus>>({});
  const channelState = channelStates[channelId];
  const channelDevices = channelState?.devices ?? devices;
  const connectedDeviceId = channelState?.connectedDeviceId ?? null;
  const gattServices = channelState?.gattServices ?? [];
  const isChannelScanning = scanning && scanningChannelId === channelId;

  // Initialize filters from store (fall back to defaults)
  const storedFilters = bleFilters[channelId] ?? DEFAULT_BLE_FILTERS;
  const [nameFilter, setNameFilter] = useState(storedFilters.nameFilter);
  const [rssiFilter, setRssiFilter] = useState(storedFilters.rssiFilter);
  const [hasServicesFilter, setHasServicesFilter] = useState(storedFilters.hasServicesFilter);
  const [hasNameFilter, setHasNameFilter] = useState(storedFilters.hasNameFilter);
  const [connectableFilter, setConnectableFilter] = useState(storedFilters.connectableFilter);
  const [expandedDevices, setExpandedDevices] = useState<Record<string, boolean>>({});

  useEffect(() => {
    pairingGenerationRef.current += 1;
    pairingQueryIdsRef.current.clear();
    setPairingStatuses({});
  }, [channelId]);

  useEffect(() => {
    if (!isChannelScanning) return;
    pairingGenerationRef.current += 1;
    pairingQueryIdsRef.current.clear();
    setPairingStatuses({});
  }, [isChannelScanning]);

  useEffect(() => {
    const newDeviceIds = channelDevices
      .map((device) => device.id)
      .filter((deviceId) => !pairingQueryIdsRef.current.has(deviceId));
    if (newDeviceIds.length === 0) return;

    newDeviceIds.forEach((deviceId) => pairingQueryIdsRef.current.add(deviceId));
    const generation = pairingGenerationRef.current;

    void getPairingStatuses(newDeviceIds)
      .then((statuses) => {
        if (generation !== pairingGenerationRef.current) return;
        setPairingStatuses((current) => {
          const next = { ...current };
          statuses.forEach((status) => {
            next[status.deviceId] = status;
          });
          return next;
        });
      })
      .catch((error) => {
        if (generation !== pairingGenerationRef.current) return;
        newDeviceIds.forEach((deviceId) => pairingQueryIdsRef.current.delete(deviceId));
        console.warn('Failed to query BLE pairing status:', error);
      });
  }, [channelDevices, getPairingStatuses]);

  // Sync filter changes to store for persistence
  useEffect(() => {
    setBleFilters(channelId, { nameFilter, rssiFilter, hasServicesFilter, hasNameFilter, connectableFilter });
  }, [nameFilter, rssiFilter, hasServicesFilter, hasNameFilter, connectableFilter, channelId, setBleFilters]);

  // Scanning only updates the hidden measurement text. Keep the default/current
  // name column stable while the panel is moving. Once resizing settles, measure
  // every current device name once and animate toward the resulting width.
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;

    const applyWidth = (width: number) => {
      const nameWidths = deviceNameColumnWidthsRef.current;
      applyDeviceRowLayoutVariables(
        element,
        width,
        nameWidths.full,
        nameWidths.twelveCharacters,
      );
      setSizeTier((previous) => resolveSizeTier(width, previous));
    };

    // Measure before first paint so a narrow panel never flashes the full layout.
    const initialWidth = element.getBoundingClientRect().width;
    previousPanelWidthRef.current = null;
    applyWidth(initialWidth);

    let receivedInitialObservation = false;
    let latestObservedWidth = initialWidth;
    let resizeInProgress = false;
    let measurementTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (!receivedInitialObservation) {
        receivedInitialObservation = true;
        latestObservedWidth = width;
        previousPanelWidthRef.current = width;
        applyWidth(width);
        return;
      }

      const observerWidthChanged = Math.abs(width - latestObservedWidth) >= 0.01;
      latestObservedWidth = width;
      const previousWidth = previousPanelWidthRef.current;
      const wasResized = didBlePanelWidthChange(previousWidth, width);
      if (wasResized) {
        resizeInProgress = true;
        previousPanelWidthRef.current = width;
      }
      applyWidth(width);

      if (resizeInProgress && observerWidthChanged) {
        if (measurementTimer) clearTimeout(measurementTimer);
        measurementTimer = setTimeout(() => {
          const measuredWidths = measureDeviceNameColumnWidths(deviceNameMeasureRef.current);
          if (measuredWidths) deviceNameColumnWidthsRef.current = measuredWidths;
          resizeInProgress = false;
          measurementTimer = null;
          applyWidth(latestObservedWidth);
        }, DEVICE_NAME_MEASUREMENT_SETTLE_MS);
      }
    });

    observer.observe(element);

    return () => {
      if (measurementTimer) clearTimeout(measurementTimer);
      observer.disconnect();
    };
  }, []);

  // The filter area is the space left after the scan button, so measuring it
  // directly keeps the reduction order correct at every panel width. Every gap,
  // label, icon, and control width is written as an interpolated CSS variable so
  // dragging stays continuous without re-rendering the device list each frame.
  useLayoutEffect(() => {
    const element = filterAreaRef.current;
    if (!element) return;

    const setToggleVariables = (
      key: 'connectable' | 'has-services' | 'has-name',
      toggle: BleFilterToggleLayout,
    ) => {
      const prefix = `--ble-filter-${key}`;
      element.style.setProperty(`${prefix}-padding`, `${toggle.paddingInline}px`);
      element.style.setProperty(`${prefix}-icon-opacity`, `${toggle.iconOpacity}`);
      element.style.setProperty(`${prefix}-icon-width`, `${toggle.iconWidth}px`);
      element.style.setProperty(`${prefix}-label-opacity`, `${toggle.labelOpacity}`);
      element.style.setProperty(`${prefix}-label-width`, `${toggle.labelWidth}px`);
    };

    const applyWidth = (width: number) => {
      const layout = resolveBleFilterLayout(width);
      element.style.setProperty('--ble-filter-outer-gap', `${layout.outerGap}px`);
      element.style.setProperty('--ble-filter-rssi-gap', `${layout.rssiGap}px`);
      element.style.setProperty('--ble-filter-toggle-gap', `${layout.toggleGap}px`);
      element.style.setProperty('--ble-filter-name-width', `${layout.nameWidth}px`);
      element.style.setProperty('--ble-filter-rssi-width', `${layout.rssiWidth}px`);
      element.style.setProperty('--ble-filter-rssi-value-width', `${layout.rssiValueWidth}px`);
      element.style.setProperty('--ble-filter-rssi-value-opacity', `${layout.rssiValueOpacity}`);
      setToggleVariables('has-name', layout.hasNameToggle);
      setToggleVariables('has-services', layout.hasServicesToggle);
      setToggleVariables('connectable', layout.connectableToggle);
    };

    applyWidth(element.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => {
      applyWidth(entry.contentRect.width);
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  const filteredDevices = useMemo(() => {
    return channelDevices.filter(d => {
      if (nameFilter && !(d.name || '').toLowerCase().includes(nameFilter.toLowerCase())) return false;
      if (d.rssi < rssiFilter) return false;
      if (hasServicesFilter && (!d.serviceUuids || d.serviceUuids.length === 0)) return false;
      if (hasNameFilter && !d.name) return false;
      if (connectableFilter && d.isConnectable === false) return false;
      return true;
    });
  }, [channelDevices, nameFilter, rssiFilter, hasServicesFilter, hasNameFilter, connectableFilter]);
  const measurableDeviceNames = channelDevices.map((device) => device.name || 'Unknown');

  const toggleDeviceExpanded = useCallback((id: string) => {
    setExpandedDevices(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const handleConnect = useCallback(async (deviceId: string) => {
    try {
      // Stop scanning before connecting
      if (isChannelScanning) {
        await stopScan();
      }
      await connectDevice(deviceId, channelId);
      toast.success('Connected to BLE device');
    } catch (e) {
      toast.error(String(e));
    }
  }, [connectDevice, channelId, isChannelScanning, stopScan]);

  const handleDisconnect = useCallback(async () => {
    if (connectedDeviceId) {
      try {
        await disconnectDevice(connectedDeviceId, channelId);
        toast.info('Disconnected from BLE device');
      } catch (e) {
        toast.error(String(e));
      }
    }
  }, [connectedDeviceId, disconnectDevice, channelId]);

  const showGatt = !!connectedDeviceId;
  const connectedScannedDevice = useMemo(() => channelDevices.find(d => d.id === connectedDeviceId) ?? null, [channelDevices, connectedDeviceId]);
  const lastConnectedDevice = connectedDeviceId && lastConnectedDevices[channelId]?.id === connectedDeviceId
    ? lastConnectedDevices[channelId]
    : null;
  const connectedDeviceDisplay = connectedScannedDevice ?? lastConnectedDevice;
  const connectedPairingStatus = connectedDeviceId ? pairingStatuses[connectedDeviceId] : undefined;
  const isNarrow = sizeTier !== 'full';
  const isCompact = sizeTier === 'compact' || sizeTier === 'tight';
  const isTight = sizeTier === 'tight';

  return (
    <div ref={panelRef} className="flex w-full max-h-full flex-col items-stretch">
      {/* Top Bar: Filter / Connected Info + Scan / Disconnect Button */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 mb-2 min-h-[40px]">
        <div ref={filterAreaRef} className="min-w-0 overflow-hidden">
          {connectedDeviceId ? (
            <div className="flex min-w-0 items-center gap-4 overflow-hidden animate-fade-in">
                <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <span className="min-w-0 flex-1 truncate text-text-primary font-medium text-lg">
                  {connectedDeviceDisplay?.name || connectedDeviceDisplay?.advertisementName || 'Connected BLE Device'}
                </span>
                {connectedPairingStatus?.isPaired && (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded bg-accent-green/15 px-2 py-1 text-[10px] text-accent-green">
                    <LockIcon className="h-3 w-3" /> Paired
                  </span>
                )}
                <Collapse hidden={isTight} hiddenMargin="-ml-2" visibleMargin="ml-2" className="min-w-0">
                  <span className="min-w-0 truncate text-text-muted font-mono text-sm">
                    {connectedDeviceDisplay?.id ?? connectedDeviceId}
                  </span>
                </Collapse>
              </div>
              {connectedScannedDevice && (
                <Collapse hidden={isCompact} hiddenMargin="-ml-4">
                  <div className="shrink-0 flex items-center gap-1 whitespace-nowrap bg-surface-overlay/30 px-2 py-1 rounded">
                    <SignalIcon className={`w-4 h-4 ${connectedScannedDevice.rssi > -60 ? 'text-accent-green' : connectedScannedDevice.rssi > -80 ? 'text-accent-yellow' : 'text-accent-red'}`} />
                    <span className="text-text-muted font-mono text-xs">{connectedScannedDevice.rssi} dBm</span>
                    </div>
                </Collapse>
              )}
              {gattServices.length > 0 && (
                <Collapse hidden={isNarrow} hiddenMargin="-ml-4">
                  <span className="shrink-0 whitespace-nowrap bg-accent-blue/15 text-accent-blue px-2 py-1 rounded text-xs font-mono">
                    {gattServices.length} service{gattServices.length !== 1 ? 's' : ''}
                  </span>
                </Collapse>
              )}
            </div>
          ) : (
            <div
              className="flex min-w-0 items-center overflow-hidden animate-fade-in transition-[gap] duration-200 ease-out motion-reduce:transition-none"
              style={{ gap: 'var(--ble-filter-outer-gap, 12px)' }}
            >
              <div
                className="relative min-w-0 shrink-0 transition-[width] duration-200 ease-out motion-reduce:transition-none"
                style={{ width: 'var(--ble-filter-name-width, 200px)' }}
              >
                <SearchIcon className={`absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted transition-opacity duration-200 ${nameFilter ? 'opacity-0' : 'opacity-100'}`} />
                <input
                  type="text"
                  placeholder="Filter..."
                  value={nameFilter}
                  onChange={e => setNameFilter(e.target.value)}
                  className={`w-full bg-surface-tertiary border border-border rounded-full pr-2 py-1 text-xs text-text-primary focus:border-accent-blue/40 outline-none transition-[padding] duration-200 ease-out ${nameFilter ? 'pl-3' : 'pl-7'}`}
                />
              </div>

              <div
                className="flex shrink-0 items-center transition-[gap] duration-200 ease-out motion-reduce:transition-none"
                style={{ gap: 'var(--ble-filter-rssi-gap, 8px)' }}
              >
                <div
                  aria-hidden
                  className="flex shrink-0 items-center overflow-hidden transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    opacity: 'var(--ble-filter-rssi-value-opacity, 1)',
                    width: 'var(--ble-filter-rssi-value-width, 32px)',
                  }}
                >
                  <span className="w-8 shrink-0 whitespace-nowrap text-right text-[10px] text-text-muted font-mono">{rssiFilter}</span>
                </div>
                <input
                  type="range"
                  min="-100" max="-20"
                  value={rssiFilter}
                  onChange={e => setRssiFilter(parseInt(e.target.value))}
                  title={`${rssiFilter} dBm`}
                  className="min-w-0 shrink-0 accent-accent-blue transition-[width] duration-200 ease-out motion-reduce:transition-none"
                  style={{ width: 'var(--ble-filter-rssi-width, 96px)' }}
                />
              </div>

              <div
                className="flex shrink-0 items-center transition-[gap] duration-200 ease-out motion-reduce:transition-none"
                style={{ gap: 'var(--ble-filter-toggle-gap, 8px)' }}
              >
                <FilterToggle
                  active={connectableFilter}
                  label="Connectable"
                  layoutKey="connectable"
                  fullLabelWidth={BLE_FILTER_TOGGLE_LABEL_WIDTHS.connectable}
                  icon={LinkIcon}
                  onClick={() => setConnectableFilter(!connectableFilter)}
                />
                <FilterToggle
                  active={hasServicesFilter}
                  label="Has Services"
                  layoutKey="has-services"
                  fullLabelWidth={BLE_FILTER_TOGGLE_LABEL_WIDTHS.hasServices}
                  icon={GridIcon}
                  onClick={() => setHasServicesFilter(!hasServicesFilter)}
                />
                <FilterToggle
                  active={hasNameFilter}
                  label="Has Name"
                  layoutKey="has-name"
                  fullLabelWidth={BLE_FILTER_TOGGLE_LABEL_WIDTHS.hasName}
                  icon={TagIcon}
                  onClick={() => setHasNameFilter(!hasNameFilter)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0">
          {connectedDeviceId ? (
            <button
              onClick={handleDisconnect}
              className={`btn-channel-action appearance-none border-0 shadow-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-text-primary/30 bg-accent-red hover:bg-accent-red/80 text-surface animate-fade-in ${isTight ? 'min-w-[76px] text-xs' : 'min-w-[88px]'}`}
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={isChannelScanning ? stopScan : () => startScan(channelId)}
              className={`btn-channel-action appearance-none border-0 shadow-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-text-primary/30 animate-fade-in ${isTight ? 'min-w-[76px] text-xs' : 'min-w-[88px]'} ${isChannelScanning ? 'bg-accent-red hover:bg-accent-red/80 text-surface' : 'bg-accent-blue hover:bg-accent-blue/80 text-surface'}`}
            >
              {isChannelScanning ? 'Stop Scan' : 'Start Scan'}
            </button>
          )}
        </div>
      </div>

      {/* Scanner area (Device list container) */}
      <div
        ref={gattCardRef}
        className="relative isolate bg-surface border border-border rounded-lg p-2 flex min-h-0 flex-col overflow-hidden"
      >
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-stable">
          {showGatt ? (
            <div>
              <GattExplorer channelId={channelId} overlayContainerRef={gattCardRef} />
            </div>
          ) : (
            <div className="pr-2 space-y-1">
            <div
              ref={deviceNameMeasureRef}
              aria-hidden
              className="pointer-events-none fixed left-0 top-0 invisible select-none"
            >
              {measurableDeviceNames.map((name, index) => (
                <React.Fragment key={`${name}-${index}`}>
                  <span
                    data-ble-device-name-text="full"
                    className="inline-block whitespace-nowrap text-sm font-sans"
                  >
                    {name}
                  </span>
                  <span
                    data-ble-device-name-text="twelve"
                    className="inline-block whitespace-nowrap text-sm font-sans"
                  >
                    {Array.from(name).length > 12
                      ? `${Array.from(name).slice(0, 12).join('')}…`
                      : name}
                  </span>
                </React.Fragment>
              ))}
            </div>
            {filteredDevices.map(device => {
              const isExpanded = !!expandedDevices[device.id];
              const resolvedAppearance = resolveBleDeviceAppearance(device);
              const appearance = resolvedAppearance?.value;
              const appearanceIconName = appearance != null ? getAppearanceIconName(appearance) : 'BluetoothIcon';
              const DeviceIcon = APPEARANCE_ICONS_RECORD[appearanceIconName] ?? BluetoothIcon;
              const appearanceLabel = appearance != null ? getAppearanceName(appearance) : undefined;
              const appearanceTitle = appearance != null
                ? `${formatBleAppearance(appearance)}${resolvedAppearance?.source === 'inferred' ? ' — inferred from service UUID' : ''}`
                : undefined;
              const pairingStatus = pairingStatuses[device.id];
              
              return (
                <div key={device.id} className="animate-fade-in flex flex-col border-b border-border last:border-b-0">
                  <div
                    className="flex w-full items-center overflow-hidden py-1.5 pl-3 pr-1 hover:bg-[var(--layer-hover)] transition-[column-gap,background-color] duration-200 ease-out motion-reduce:transition-none"
                    style={{ columnGap: 'var(--ble-device-row-gap, 4px)' }}
                  >
                    <div className="contents">
                      <span
                        aria-label={appearanceTitle ?? 'Appearance unavailable'}
                        className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                        role="img"
                        title={appearanceTitle}
                      >
                        <DeviceIcon className="h-3.5 w-3.5 text-accent-blue" />
                      </span>
                      <span
                        className="grow shrink-0 truncate text-text-primary text-sm font-sans transition-[width,min-width,max-width] duration-150 ease-out motion-reduce:transition-none"
                        style={{
                          width: 'var(--ble-device-name-width, 120px)',
                          minWidth: 'var(--ble-device-name-width, 120px)',
                          maxWidth: 'var(--ble-device-name-full-width, 120px)',
                        }}
                        title={device.name || 'Unknown Device'}
                      >
                        {device.name || 'Unknown'}
                      </span>
                      {pairingStatus?.isPaired && (
                        <Collapse hidden={isCompact} hiddenMargin="-ml-1">
                          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-accent-green/15 px-1.5 py-0.5 text-[10px] text-accent-green" title="Paired and bonded in Windows">
                            <LockIcon className="h-3 w-3" /> Paired
                          </span>
                        </Collapse>
                      )}
                      <div
                        className="flex min-w-0 shrink-0 items-center overflow-hidden transition-[width,margin,opacity] duration-150 ease-out motion-reduce:transition-none"
                        style={{
                          marginLeft: 'var(--ble-device-mac-margin-left, 0px)',
                          opacity: 'var(--ble-device-mac-opacity, 1)',
                          width: 'var(--ble-device-mac-width, 128px)',
                        }}
                      >
                        <span className="min-w-0 truncate whitespace-nowrap text-text-muted font-mono text-xs" title={device.id}>
                          {device.id}
                        </span>
                      </div>
                    </div>
                    <div className="contents">
                      <div
                        className="flex shrink-0 items-center overflow-hidden transition-[width,margin,opacity] duration-150 ease-out motion-reduce:transition-none"
                        style={{
                          marginLeft: 'var(--ble-device-signal-margin-left, 0px)',
                          opacity: 'var(--ble-device-signal-opacity, 1)',
                          width: 'var(--ble-device-signal-width, 64px)',
                        }}
                      >
                        <div className="flex items-center gap-1 w-16 shrink-0">
                          <SignalIcon className={`w-3.5 h-3.5 ${device.rssi > -60 ? 'text-accent-green' : device.rssi > -80 ? 'text-accent-yellow' : 'text-accent-red'}`} />
                          <span className="text-text-muted font-mono text-xs">{device.rssi}</span>
                        </div>
                      </div>

                      <div
                        className="shrink-0 overflow-hidden transition-[width,margin,opacity] duration-150 ease-out motion-reduce:transition-none"
                        style={{
                          marginLeft: 'var(--ble-device-service-margin-left, 0px)',
                          opacity: 'var(--ble-device-service-opacity, 1)',
                          width: 'var(--ble-device-service-width, 48px)',
                        }}
                      >
                        <span className="flex w-12 shrink-0 items-center justify-center whitespace-nowrap rounded bg-[var(--layer-hover)] px-1.5 py-0.5 text-center font-mono text-[10px] text-text-secondary">
                          {device.serviceUuids?.length || 0} SVC
                        </span>
                      </div>

                      <div className="ml-auto flex shrink-0 items-center gap-1">
                        <div className="flex w-12 justify-end">
                          {connectedDeviceId === device.id ? (
                            <button onClick={(e) => { e.stopPropagation(); handleDisconnect(); }} className="bg-[var(--layer-hover)] hover:bg-[var(--layer-active)] text-accent-red px-2 py-0.5 rounded text-xs transition-all duration-150">Drop</button>
                          ) : (
                            <button onClick={(e) => { e.stopPropagation(); handleConnect(device.id); }} className="bg-accent-blue/15 hover:bg-accent-blue/25 text-accent-blue px-2 py-0.5 rounded text-xs transition-all duration-150">Conn</button>
                          )}
                        </div>

                        <button
                          aria-expanded={isExpanded}
                          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${device.name || device.id}`}
                          onClick={() => toggleDeviceExpanded(device.id)}
                          className="shrink-0 p-1 hover:bg-[var(--layer-hover)] rounded"
                        >
                          <ChevronDownIcon className={`w-3.5 h-3.5 text-text-muted transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                      </div>
                    </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border px-4 py-2 text-xs font-mono space-y-1.5 animate-slide-down">
                    <div className="text-text-muted">
                      <span className="text-text-muted">ID:</span> {device.id}
                    </div>
                    {device.advertisementName && (
                      <div className="text-text-secondary">
                        <span className="text-text-muted">Local Name:</span> {device.advertisementName}
                      </div>
                    )}
                    {device.addressType && (
                      <div className="text-text-secondary">
                        <span className="text-text-muted">{AD_TYPE_NAMES[0x1b]} / Address Type:</span> {device.addressType}
                      </div>
                    )}
                    <div className="text-text-secondary">
                      <span className="text-text-muted">Pairing / Bond:</span>{' '}
                      {!pairingStatus
                        ? 'Checking...'
                        : pairingStatus.supported
                          ? pairingStatus.isPaired
                            ? <span className="text-accent-green">Paired</span>
                            : pairingStatus.error
                              ? <span className="text-accent-red">{pairingStatus.error}</span>
                              : pairingStatus.canPair
                                ? 'Not paired'
                                : 'Not available'
                          : 'Not supported on this platform'}
                    </div>
                    {appearance != null && (
                      <div className="text-text-secondary">
                        <span className="text-text-muted">
                          {resolvedAppearance?.source === 'reported'
                            ? AD_TYPE_NAMES[0x19]
                            : `${AD_TYPE_NAMES[0x19]} (inferred from service UUID)`}:
                        </span>{' '}
                        {appearanceLabel}{' '}
                        <span className="text-accent-blue">({formatBleAppearanceValue(appearance)})</span>
                      </div>
                    )}

                    {device.manufacturerData && Object.keys(device.manufacturerData).length > 0 && (
                      <div className="text-text-secondary break-words">
                        <span className="text-text-muted">{AD_TYPE_NAMES[0xff]}:</span>{' '}
                        {Object.entries(device.manufacturerData).map(([compId, data]) => (
                          <span key={compId} className="mr-3 inline-block">
                            <span className="text-accent-yellow">0x{parseInt(compId, 10).toString(16).padStart(4, '0')}</span>
                            {' '}
                            <span className="text-text-primary">{COMPANY_IDENTIFIERS_RECORD[parseInt(compId, 10)] ?? 'Unknown Company'}</span>
                            {' '}
                            {formatHexBytes(data)}
                          </span>
                        ))}
                      </div>
                    )}
                    {device.serviceData && Object.keys(device.serviceData).length > 0 && (
                      <div className="text-text-secondary break-words">
                        <span className="text-text-muted">Service Data:</span>{' '}
                        {Object.entries(device.serviceData).map(([uuid, data]) => (
                          <span key={uuid} className="mr-3 inline-block">
                            <span className="text-accent-blue">{uuid}</span>
                            {getServiceName(uuid) ? ` (${getServiceName(uuid)})` : ''}
                            {' '}
                            {formatHexBytes(data)}
                          </span>
                        ))}
                      </div>
                    )}
                    {device.txPowerLevel != null && (
                      <div className="text-text-secondary">
                        <span className="text-text-muted">TX Power:</span> {device.txPowerLevel} dBm
                      </div>
                    )}
                    {device.serviceUuids && device.serviceUuids.length > 0 && (
                      <div className="text-text-secondary break-words">
                        <span className="text-text-muted">List of Service UUIDs:</span>{' '}
                        {device.serviceUuids.map((uuid) => {
                          const serviceName = getServiceName(uuid);
                          const inferredAppearance = resolvedAppearance?.source === 'reported'
                            ? undefined
                            : inferAppearanceFromServices([uuid]);
                          const inferredAppearanceText = inferredAppearance != null
                            ? ` → ${AD_TYPE_NAMES[0x19]}: ${getAppearanceName(inferredAppearance)}`
                            : '';

                          return (
                            <span key={uuid} className="mr-3 inline-block">
                              <span className="text-accent-blue">{uuid}</span>
                              {serviceName ? ` (${serviceName})` : ''}
                              {inferredAppearanceText}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {resolvedAppearance == null && (
                      <div className="text-text-faint italic">Appearance not reported and could not be inferred from service UUIDs.</div>
                    )}
                    {(!device.manufacturerData || Object.keys(device.manufacturerData).length === 0) && (!device.serviceUuids || device.serviceUuids.length === 0) && (!device.serviceData || Object.keys(device.serviceData).length === 0) && device.txPowerLevel == null && device.appearance == null && (
                      <div className="text-text-faint italic">No additional advertising data</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {filteredDevices.length === 0 && (
            <div className="text-center text-text-muted py-4 text-sm font-sans">
              {channelDevices.length > 0
                ? `${channelDevices.length} device${channelDevices.length === 1 ? '' : 's'} hidden by filters`
                : isChannelScanning
                  ? 'Scanning for devices...'
                  : 'No devices found'}
            </div>
          )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
