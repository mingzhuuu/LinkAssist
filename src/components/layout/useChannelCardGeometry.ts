import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChannelStore, useUIStore } from '../../stores';
import { computeChannelCardGeometry, sameChannelCardGeometry } from './channelCardGeometry';
import type { ChannelCardGeometry, ChannelCardSize, RectLike } from './channelCardGeometry';

/** DOM hooks shared by the channel rail and the channel settings card. */
export const CHANNEL_CARD_CONTAINER_ATTR = 'data-channel-card-container';
export const CHANNEL_LIST_VIEWPORT_ATTR = 'data-channel-list-viewport';
const CONTAINER_SELECTOR = `[${CHANNEL_CARD_CONTAINER_ATTR}]`;
const VIEWPORT_SELECTOR = `[${CHANNEL_LIST_VIEWPORT_ATTR}]`;
const ANCHOR_SELECTOR = '[data-channel-config-trigger][data-active="true"]';

function measureChannelCard(previewSize?: ChannelCardSize): ChannelCardGeometry | null {
  const containerEl = document.querySelector<HTMLElement>(CONTAINER_SELECTOR);
  if (!containerEl) return null;
  const rawContainer = containerEl.getBoundingClientRect();
  const anchorEl = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
  const rawAnchor = anchorEl?.getBoundingClientRect() ?? null;
  const viewportEl = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
  const rawViewport = viewportEl?.getBoundingClientRect() ?? null;

  const unmeasured = rawContainer.width <= 0 && rawContainer.height <= 0;
  const container: RectLike = unmeasured
    ? { left: 200, top: 0, right: 800, bottom: 600, width: 600, height: 600 }
    : rawContainer;

  let anchor: RectLike | null = rawAnchor;
  if (anchorEl && (!rawAnchor || rawAnchor.height <= 0)) {
    const triggers = Array.from(document.querySelectorAll<HTMLElement>('[data-channel-config-trigger]'));
    const index = Math.max(0, triggers.indexOf(anchorEl));
    const rowTop = 10 + index * 32;
    anchor = {
      left: 0,
      top: rowTop,
      right: container.left,
      bottom: rowTop + 32,
      width: container.left,
      height: 32,
    };
  }

  const railViewport = rawViewport && rawViewport.height > 0 ? rawViewport : null;
  const { centerSplitRatio, centerBottomVisible } = useUIStore.getState();
  return computeChannelCardGeometry({
    container,
    workspace: containerEl.closest('[data-content-area]')?.getBoundingClientRect(),
    previewSize,
    anchor,
    railViewport,
    splitRatio: centerSplitRatio,
    showBottom: centerBottomVisible,
  });
}

/**
 * Measures the floating channel card against the selected rail row. Both the
 * rail and the card call this so they agree on whether the card is attached
 * to the row without sharing transient state through a store.
 */
export function useChannelCardGeometry(previewSize?: ChannelCardSize): ChannelCardGeometry | null {
  const [geometry, setGeometry] = useState<ChannelCardGeometry | null>(null);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const channelPanelVisible = useUIStore((state) => state.channelPanelVisible);
  const channelCount = useChannelStore((state) => state.channels.length);
  const centerSplitRatio = useUIStore((state) => state.centerSplitRatio);
  const centerBottomVisible = useUIStore((state) => state.centerBottomVisible);
  const centerTopVisible = useUIStore((state) => state.centerTopVisible);
  const channelConfigPreview = useUIStore((state) => state.channelConfigPreview);
  const leftPanelWidth = useUIStore((state) => state.leftPanelWidth);
  const centerPanelWidth = useUIStore((state) => state.centerPanelWidth);

  const previewSizeRef = useRef(previewSize);
  const sync = useCallback(() => {
    const next = measureChannelCard(previewSizeRef.current);
    setGeometry((previous) => (sameChannelCardGeometry(previous, next) ? previous : next));
  }, []);

  useLayoutEffect(() => {
    previewSizeRef.current = previewSize;
    sync();
  }, [
    sync,
    previewSize,
    activeChannelId,
    channelCount,
    channelPanelVisible,
    centerSplitRatio,
    centerBottomVisible,
    centerTopVisible,
    channelConfigPreview,
    leftPanelWidth,
    centerPanelWidth,
  ]);

  useEffect(() => {
    const container = document.querySelector<HTMLElement>(CONTAINER_SELECTOR);
    const viewport = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    viewport?.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule);
      if (container) {
        observer.observe(container);
        const workspace = container.closest('[data-content-area]');
        if (workspace) observer.observe(workspace);
      }
      if (viewport) observer.observe(viewport);
    }

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [sync, channelCount, channelPanelVisible]);

  return geometry;
}
