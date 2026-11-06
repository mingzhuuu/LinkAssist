/**
 * Pure geometry for the floating channel settings card.
 *
 * In preview mode the card and the selected channel row read as one shape:
 * the row in the rail is drawn as an open "tab" (see `.channel-item-connected`),
 * and the card outline continues that tab across the rail edge. The tab's top
 * edge runs straight into the card's top edge, and its bottom edge curves into
 * the card's left edge with a concave fillet.
 *
 * All coordinates are CSS pixels relative to the card container (the center
 * panel root). The workspace exposes the curved join over the rail; the channel list
 * draws the rest of the selected row.
 */

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface ChannelCardGeometryInput {
  /** Card container (center panel root). */
  container: RectLike;
  /** Workspace that the preview can extend across, including the canvas. */
  workspace?: RectLike;
  previewSize?: ChannelCardSize;
  /** Selected channel row in the rail, or null when it is not rendered. */
  anchor: RectLike | null;
  /** Scroll viewport of the rail; the tab is only attached while the row is fully visible. */
  railViewport: RectLike | null;
  /** Desired card bottom as a fraction of the container height. */
  splitRatio: number;
  /** Whether the terminal is shown below the card. */
  showBottom: boolean;
}

export interface ChannelCardSize {
  width?: number;
  height?: number;
}

export interface ChannelCardBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ChannelCardGeometry {
  /** Floating card body (preview). */
  card: ChannelCardBox;
  /** Docked card body (pinned): full width, pushes the terminal down. */
  docked: ChannelCardBox;
  /** Tab vertical span in container coordinates, when the card is attached to the row. */
  tab: { top: number; bottom: number } | null;
  /** True when the tab's top edge is flush with the card's top edge. */
  tabAligned: boolean;
  /** Outline box (card plus tab bridge) and its closed path in box-local coordinates. */
  outline: ChannelCardBox & { path: string };
  /** Border radius of the card body (top-left is square when the tab is aligned). */
  bodyRadius: string;
}

export const CHANNEL_CARD_INSET = 10;
export const CHANNEL_CARD_RADIUS = 12;
export const CHANNEL_TAB_RADIUS = 7;
export const CHANNEL_TAB_FILLET = 8;
/** Vertical inset of the tab inside the 32px channel row (matches `.channel-item-active::before`). */
export const CHANNEL_TAB_INSET_Y = 2;
// Keep the body just inside the rail and expose the entire concave corner.
const RAIL_OVERLAP = 7;
export const CHANNEL_CARD_JOIN_WIDTH = RAIL_OVERLAP + CHANNEL_TAB_FILLET + 1;
const TAB_BRIDGE_LEFT = -(CHANNEL_CARD_JOIN_WIDTH + CHANNEL_TAB_RADIUS + 2);
const MIN_CARD_HEIGHT = 180;
const MIN_BELOW_TAB = 120;
const BOTTOM_GAP = 10;

const fmt = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

export interface ChannelCardPathFrame {
  cl: number;
  ct: number;
  cr: number;
  cb: number;
  tab: { tl: number; tt: number; tb: number } | null;
  aligned: boolean;
}

/** Closed clockwise outline of the card, including the connected tab when present. */
export function buildChannelCardPath({ cl, ct, cr, cb, tab, aligned }: ChannelCardPathFrame): string {
  const r = Math.max(0, Math.min(CHANNEL_CARD_RADIUS, (cr - cl) / 2, (cb - ct) / 2));
  const rightAndBottom = [
    `H ${fmt(cr - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cr)} ${fmt(ct + r)}`,
    `V ${fmt(cb - r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cr - r)} ${fmt(cb)}`,
    `H ${fmt(cl + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cl)} ${fmt(cb - r)}`,
  ];

  if (!tab) {
    return [
      `M ${fmt(cl)} ${fmt(ct + r)}`,
      `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cl + r)} ${fmt(ct)}`,
      ...rightAndBottom,
      'Z',
    ].join(' ');
  }

  const { tl, tt, tb } = tab;
  const rt = Math.max(0, Math.min(CHANNEL_TAB_RADIUS, (tb - tt) / 2));
  const rf = Math.max(0, Math.min(CHANNEL_TAB_FILLET, cl - tl - rt));
  const tabBody = [
    `V ${fmt(tb + rf)}`,
    `A ${fmt(rf)} ${fmt(rf)} 0 0 0 ${fmt(cl - rf)} ${fmt(tb)}`,
    `H ${fmt(tl + rt)}`,
    `A ${fmt(rt)} ${fmt(rt)} 0 0 1 ${fmt(tl)} ${fmt(tb - rt)}`,
    `V ${fmt(tt + rt)}`,
    `A ${fmt(rt)} ${fmt(rt)} 0 0 1 ${fmt(tl + rt)} ${fmt(tt)}`,
  ];

  if (aligned) {
    return [`M ${fmt(tl + rt)} ${fmt(tt)}`, ...rightAndBottom, ...tabBody, 'Z'].join(' ');
  }

  return [
    `M ${fmt(cl)} ${fmt(ct + r)}`,
    `A ${fmt(r)} ${fmt(r)} 0 0 1 ${fmt(cl + r)} ${fmt(ct)}`,
    ...rightAndBottom,
    ...tabBody,
    `H ${fmt(cl - rf)}`,
    `A ${fmt(rf)} ${fmt(rf)} 0 0 0 ${fmt(cl)} ${fmt(tt - rf)}`,
    'Z',
  ].join(' ');
}

export function computeChannelCardGeometry({
  container,
  workspace,
  previewSize,
  anchor,
  railViewport,
  splitRatio,
  showBottom,
}: ChannelCardGeometryInput): ChannelCardGeometry | null {
  const containerWidth = Math.round(container.width);
  const containerHeight = Math.round(container.height);
  if (containerWidth <= 0 || containerHeight <= 0) return null;

  const frameLeft = workspace ? clamp(workspace.left - container.left, -1, 0) : -1;
  const left = frameLeft - (anchor ? RAIL_OVERLAP : 0);
  const maxWidth = Math.max(0, (workspace?.right ?? container.right) - container.left - left - CHANNEL_CARD_INSET);
  const defaultWidth = containerWidth - left - CHANNEL_CARD_INSET;
  const width = clamp(previewSize?.width ?? defaultWidth, Math.min(240, maxWidth), maxWidth);
  const right = left + width;
  const maxBottom = containerHeight - BOTTOM_GAP;
  const ratio = showBottom ? splitRatio : 1;
  const desiredBottom = Math.round(containerHeight * splitRatio);
  const minGap = CHANNEL_CARD_RADIUS + CHANNEL_TAB_FILLET;

  let tab: ChannelCardGeometry['tab'] = null;
  if (anchor && anchor.height > 0) {
    const tabTop = Math.round(anchor.top - container.top + CHANNEL_TAB_INSET_Y);
    const tabBottom = Math.round(anchor.bottom - container.top - CHANNEL_TAB_INSET_Y);
    const besideCard = anchor.right <= container.left + 1;
    const rowVisible = !railViewport
      || (anchor.top >= railViewport.top - 1 && anchor.bottom <= railViewport.bottom + 1);
    if (besideCard && rowVisible && tabTop >= 0 && tabBottom - tabTop >= CHANNEL_TAB_RADIUS * 2) {
      tab = { top: tabTop, bottom: tabBottom };
    }
  }

  let top = CHANNEL_CARD_INSET;
  let bottom = clamp(desiredBottom, top + MIN_CARD_HEIGHT, maxBottom);

  if (tab) {
    top = tab.top;
    bottom = Math.min(maxBottom, Math.max(desiredBottom, tab.bottom + MIN_BELOW_TAB, top + MIN_CARD_HEIGHT));
    if (bottom - tab.bottom < minGap) {
      // Not enough room below the row: lift the card and attach the tab mid-edge.
      bottom = maxBottom;
      top = Math.max(CHANNEL_CARD_INSET, Math.min(tab.top, bottom - MIN_CARD_HEIGHT));
      if (tab.top > top && tab.top - top < minGap) top = Math.max(CHANNEL_CARD_INSET, tab.top - minGap);
      const topFits = tab.top === top || tab.top - top >= minGap;
      if (!topFits || bottom - tab.bottom < minGap) {
        tab = null;
        top = CHANNEL_CARD_INSET;
        bottom = clamp(desiredBottom, top + MIN_CARD_HEIGHT, maxBottom);
      }
    }
  }

  const maxHeight = Math.max(0, maxBottom - top);
  const minHeight = Math.min(maxHeight, Math.max(MIN_CARD_HEIGHT, tab ? tab.bottom + minGap - top : 0));
  const height = clamp(previewSize?.height ?? bottom - top, minHeight, maxHeight);
  const tabAligned = !!tab && tab.top === top;
  const outlineLeft = tab ? TAB_BRIDGE_LEFT : left;
  const outlineWidth = right - outlineLeft;
  const path = buildChannelCardPath({
    cl: left - outlineLeft + 0.5,
    ct: 0.5,
    cr: outlineWidth - 0.5,
    cb: height - 0.5,
    tab: tab ? { tl: 0.5, tt: tab.top - top + 0.5, tb: tab.bottom - top - 0.5 } : null,
    aligned: tabAligned,
  });
  const innerRadius = CHANNEL_CARD_RADIUS - 1;

  return {
    card: { left, top, width, height },
    docked: { left: 0, top: 0, width: containerWidth, height: Math.round(containerHeight * ratio) },
    tab,
    tabAligned,
    outline: { left: outlineLeft, top, width: outlineWidth, height, path },
    bodyRadius: `${tabAligned ? 0 : innerRadius}px ${innerRadius}px ${innerRadius}px ${innerRadius}px`,
  };
}

export function sameChannelCardGeometry(a: ChannelCardGeometry | null, b: ChannelCardGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.outline.path === b.outline.path
    && a.outline.left === b.outline.left
    && a.outline.top === b.outline.top
    && a.docked.width === b.docked.width
    && a.docked.height === b.docked.height
    && (a.tab?.top ?? -1) === (b.tab?.top ?? -1);
}
