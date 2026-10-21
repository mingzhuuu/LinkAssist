export type BleFilterLayoutStage =
  | 'compress-gaps'
  | 'half-name'
  | 'icon-name'
  | 'icon-services'
  | 'icon-connectable'
  | 'hide-rssi-value'
  | 'compress-controls';

export interface BleFilterLayout {
  stage: BleFilterLayoutStage;
  outerGap: number;
  rssiGap: number;
  toggleGap: number;
  nameWidth: number;
  rssiWidth: number;
  rssiValueWidth: number;
  rssiValueOpacity: number;
  hasNameToggle: BleFilterToggleLayout;
  hasServicesToggle: BleFilterToggleLayout;
  connectableToggle: BleFilterToggleLayout;
}

export interface BleFilterToggleLayout {
  iconOpacity: number;
  iconWidth: number;
  labelOpacity: number;
  labelWidth: number;
  paddingInline: number;
  progress: number;
}

export const BLE_FILTER_TOGGLE_LABEL_WIDTHS = {
  connectable: 58,
  hasServices: 60,
  hasName: 46,
} as const;

// Each adjacent pair is a continuous compression phase. Its pixel span equals
// the space removed during that phase, keeping the row fitted without jumps.
const MAX_GAP_LAYOUT_WIDTH = 596;
const MIN_GAP_LAYOUT_WIDTH = 568;
const MIN_HALF_NAME_LAYOUT_WIDTH = 468;
const MIN_ICON_NAME_LAYOUT_WIDTH = 428;
const MIN_ICON_SERVICES_LAYOUT_WIDTH = 374;
const MIN_ICON_CONNECTABLE_LAYOUT_WIDTH = 322;
const MIN_RSSI_VALUE_LAYOUT_WIDTH = 286;

const MAX_OUTER_GAP = 12;
const MIN_OUTER_GAP = 4;
const MAX_INNER_GAP = 8;
const MIN_INNER_GAP = 4;

const MAX_NAME_WIDTH = 200;
const HALF_NAME_WIDTH = MAX_NAME_WIDTH / 2;
const MIN_NAME_WIDTH = 56;
const MAX_RSSI_WIDTH = 96;
const MIN_RSSI_WIDTH = 48;
const RSSI_VALUE_WIDTH = 32;
const FILTER_TOGGLE_ICON_WIDTH = 12;
const FILTER_TOGGLE_FULL_PADDING = 8;
const FILTER_TOGGLE_ICON_PADDING = 5;
// MainLayout keeps the center pane at least 300 px wide. After CenterPanel's
// padding and the scan button, the filter controls retain 192 px.
const MIN_FILTER_LAYOUT_WIDTH = 192;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function lerp(minimum: number, maximum: number, progress: number): number {
  return minimum + (maximum - minimum) * progress;
}

function compressionProgress(width: number, phaseStart: number, phaseEnd: number): number {
  return clamp((phaseStart - width) / (phaseStart - phaseEnd), 0, 1);
}

function resolveStage(width: number): BleFilterLayoutStage {
  if (width >= MIN_GAP_LAYOUT_WIDTH) return 'compress-gaps';
  if (width >= MIN_HALF_NAME_LAYOUT_WIDTH) return 'half-name';
  if (width >= MIN_ICON_NAME_LAYOUT_WIDTH) return 'icon-name';
  if (width >= MIN_ICON_SERVICES_LAYOUT_WIDTH) return 'icon-services';
  if (width >= MIN_ICON_CONNECTABLE_LAYOUT_WIDTH) return 'icon-connectable';
  if (width >= MIN_RSSI_VALUE_LAYOUT_WIDTH) return 'hide-rssi-value';
  return 'compress-controls';
}

function resolveToggleLayout(progress: number, fullLabelWidth: number): BleFilterToggleLayout {
  return {
    iconOpacity: progress,
    iconWidth: lerp(0, FILTER_TOGGLE_ICON_WIDTH, progress),
    labelOpacity: 1 - progress,
    labelWidth: lerp(fullLabelWidth, 0, progress),
    paddingInline: lerp(FILTER_TOGGLE_FULL_PADDING, FILTER_TOGGLE_ICON_PADDING, progress),
    progress,
  };
}

export function resolveBleFilterLayout(availableWidth: number): BleFilterLayout {
  const width = Math.max(availableWidth, 0);
  const gapCompression = compressionProgress(
    width,
    MAX_GAP_LAYOUT_WIDTH,
    MIN_GAP_LAYOUT_WIDTH,
  );
  const halfNameProgress = compressionProgress(
    width,
    MIN_GAP_LAYOUT_WIDTH,
    MIN_HALF_NAME_LAYOUT_WIDTH,
  );
  const hasNameProgress = compressionProgress(
    width,
    MIN_HALF_NAME_LAYOUT_WIDTH,
    MIN_ICON_NAME_LAYOUT_WIDTH,
  );
  const hasServicesProgress = compressionProgress(
    width,
    MIN_ICON_NAME_LAYOUT_WIDTH,
    MIN_ICON_SERVICES_LAYOUT_WIDTH,
  );
  const connectableProgress = compressionProgress(
    width,
    MIN_ICON_SERVICES_LAYOUT_WIDTH,
    MIN_ICON_CONNECTABLE_LAYOUT_WIDTH,
  );
  const rssiValueProgress = compressionProgress(
    width,
    MIN_ICON_CONNECTABLE_LAYOUT_WIDTH,
    MIN_RSSI_VALUE_LAYOUT_WIDTH,
  );
  const finalControlProgress = compressionProgress(
    width,
    MIN_RSSI_VALUE_LAYOUT_WIDTH,
    MIN_FILTER_LAYOUT_WIDTH,
  );
  const baseInnerGap = lerp(MAX_INNER_GAP, MIN_INNER_GAP, gapCompression);

  return {
    stage: resolveStage(width),
    outerGap: lerp(MAX_OUTER_GAP, MIN_OUTER_GAP, gapCompression),
    rssiGap: rssiValueProgress > 0
      ? lerp(MIN_INNER_GAP, 0, rssiValueProgress)
      : baseInnerGap,
    toggleGap: baseInnerGap,
    nameWidth: finalControlProgress > 0
      ? lerp(HALF_NAME_WIDTH, MIN_NAME_WIDTH, finalControlProgress)
      : lerp(MAX_NAME_WIDTH, HALF_NAME_WIDTH, halfNameProgress),
    rssiWidth: lerp(MAX_RSSI_WIDTH, MIN_RSSI_WIDTH, finalControlProgress),
    rssiValueWidth: lerp(RSSI_VALUE_WIDTH, 0, rssiValueProgress),
    rssiValueOpacity: 1 - rssiValueProgress,
    hasNameToggle: resolveToggleLayout(
      hasNameProgress,
      BLE_FILTER_TOGGLE_LABEL_WIDTHS.hasName,
    ),
    hasServicesToggle: resolveToggleLayout(
      hasServicesProgress,
      BLE_FILTER_TOGGLE_LABEL_WIDTHS.hasServices,
    ),
    connectableToggle: resolveToggleLayout(
      connectableProgress,
      BLE_FILTER_TOGGLE_LABEL_WIDTHS.connectable,
    ),
  };
}
