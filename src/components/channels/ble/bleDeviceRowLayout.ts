export interface BleDeviceRowLayout {
  macMarginLeft: number;
  macOpacity: number;
  macWidth: number;
  nameWidth: number;
  rowGap: number;
  serviceMarginLeft: number;
  serviceOpacity: number;
  serviceWidth: number;
  signalMarginLeft: number;
  signalOpacity: number;
  signalWidth: number;
}

const MIN_NAME_COLUMN_WIDTH = 64;
const DEFAULT_NAME_COLUMN_WIDTH = 120;
const DEFAULT_TWELVE_CHARACTER_NAME_WIDTH = 96;
const MAX_NAME_COLUMN_WIDTH = 320;
const NAME_MEASUREMENT_ALLOWANCE = 4;

const MIN_ROW_GAP = 4;
// At this width a row using the default name column has exhausted the space
// distributed between its fields and reached MIN_ROW_GAP. A wider measured
// name shifts the boundary by the same number of pixels.
const BASE_FULL_NAME_FIT_WIDTH = 568;

const MAC_WIDTH = 128;
// Keep enough room for the first two octets plus the CSS ellipsis (XX:XX…).
const MIN_MAC_WIDTH = 48;
const MAC_COLLAPSE_SPAN = MAC_WIDTH - MIN_MAC_WIDTH;

const SIGNAL_WIDTH = 64;
// The numeric RSSI may disappear, but the signal icon remains useful.
const MIN_SIGNAL_WIDTH = 18;
const SIGNAL_COLLAPSE_SPAN = SIGNAL_WIDTH - MIN_SIGNAL_WIDTH;

const SERVICE_WIDTH = 48;
const SERVICE_COLLAPSE_SPAN = SERVICE_WIDTH + MIN_ROW_GAP;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function visibleProgress(width: number, collapseStart: number, collapseEnd: number): number {
  return clamp((width - collapseEnd) / (collapseStart - collapseEnd), 0, 1);
}

export function didBlePanelWidthChange(
  previousWidth: number | null,
  currentWidth: number,
): boolean {
  return previousWidth !== null && Math.abs(currentWidth - previousWidth) >= 0.5;
}

export function resolveBleDeviceNameColumnWidth(measuredWidths: number[]): number {
  const longestWidth = measuredWidths.length > 0 ? Math.max(...measuredWidths) : 0;
  const widthWithAllowance = longestWidth > 0
    ? Math.ceil(longestWidth + NAME_MEASUREMENT_ALLOWANCE)
    : MIN_NAME_COLUMN_WIDTH;
  return clamp(widthWithAllowance, MIN_NAME_COLUMN_WIDTH, MAX_NAME_COLUMN_WIDTH);
}

export function resolveBleDeviceRowLayout(
  availableWidth: number,
  nameColumnWidth = DEFAULT_NAME_COLUMN_WIDTH,
  twelveCharacterNameWidth = DEFAULT_TWELVE_CHARACTER_NAME_WIDTH,
): BleDeviceRowLayout {
  const width = Math.max(availableWidth, 0);
  const fullNameWidth = clamp(
    nameColumnWidth,
    MIN_NAME_COLUMN_WIDTH,
    MAX_NAME_COLUMN_WIDTH,
  );
  const compactNameWidth = clamp(
    twelveCharacterNameWidth,
    MIN_NAME_COLUMN_WIDTH,
    fullNameWidth,
  );
  const fullNameFitWidth = BASE_FULL_NAME_FIT_WIDTH
    + (fullNameWidth - DEFAULT_NAME_COLUMN_WIDTH);
  const primaryNameCollapseSpan = fullNameWidth - compactNameWidth;
  const primaryNameCollapseEnd = fullNameFitWidth - primaryNameCollapseSpan;
  const primaryNameProgress = primaryNameCollapseSpan > 0
    ? visibleProgress(width, fullNameFitWidth, primaryNameCollapseEnd)
    : 0;
  const serviceCollapseStart = primaryNameCollapseEnd;
  const serviceCollapseEnd = serviceCollapseStart - SERVICE_COLLAPSE_SPAN;
  const macCollapseStart = serviceCollapseEnd;
  const macCollapseEnd = macCollapseStart - MAC_COLLAPSE_SPAN;
  const signalCollapseStart = macCollapseEnd;
  const signalCollapseEnd = signalCollapseStart - SIGNAL_COLLAPSE_SPAN;
  const serviceProgress = visibleProgress(width, serviceCollapseStart, serviceCollapseEnd);
  const macProgress = visibleProgress(width, macCollapseStart, macCollapseEnd);
  const signalProgress = visibleProgress(width, signalCollapseStart, signalCollapseEnd);
  const finalNameCollapseSpan = compactNameWidth - MIN_NAME_COLUMN_WIDTH;
  const finalNameProgress = finalNameCollapseSpan > 0
    ? visibleProgress(width, signalCollapseEnd, signalCollapseEnd - finalNameCollapseSpan)
    : 0;

  return {
    macMarginLeft: 0,
    macOpacity: 1,
    macWidth: MIN_MAC_WIDTH + MAC_COLLAPSE_SPAN * macProgress,
    nameWidth: width >= primaryNameCollapseEnd
      ? compactNameWidth + primaryNameCollapseSpan * primaryNameProgress
      : MIN_NAME_COLUMN_WIDTH + finalNameCollapseSpan * finalNameProgress,
    rowGap: MIN_ROW_GAP,
    serviceMarginLeft: serviceProgress === 1 ? 0 : -MIN_ROW_GAP * (1 - serviceProgress),
    serviceOpacity: serviceProgress,
    serviceWidth: SERVICE_WIDTH * serviceProgress,
    signalMarginLeft: 0,
    signalOpacity: 1,
    signalWidth: MIN_SIGNAL_WIDTH + SIGNAL_COLLAPSE_SPAN * signalProgress,
  };
}
