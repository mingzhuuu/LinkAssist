import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useUIStore } from '../../stores';
import { CHANNEL_CARD_INSET, CHANNEL_CARD_RADIUS } from './channelCardGeometry';
import type { ChannelCardSize } from './channelCardGeometry';
import { useChannelCardGeometry } from './useChannelCardGeometry';

export type ChannelCardAccent = 'blue' | 'mauve' | 'green';

interface ChannelConfigDrawerProps {
  children: ReactNode;
  accent: ChannelCardAccent;
  splitRatio: number;
  showBottom: boolean;
  isResizing?: boolean;
}

/** Length of the preview <-> docked morph; keep in sync with `.is-morphing` in globals.css. */
const MORPH_MS = 420;

/**
 * One settings surface shared by the temporary overlay and the docked layout.
 *
 * Preview: a floating card that slides out from under the channel rail, framed
 * in the channel colour and attached to the selected row. Docked: the same
 * surface (controls stay mounted) widens into the top of the center panel,
 * takes the terminal colour and meets the terminal with a straight divider.
 */
export function ChannelConfigDrawer({
  children,
  accent,
  splitRatio,
  showBottom,
  isResizing = false,
}: ChannelConfigDrawerProps) {
  const { centerTopVisible: pinned, channelConfigPreview: preview, closeChannelConfig } = useUIStore();
  const drawerRef = useRef<HTMLElement>(null);
  const visible = pinned || preview;
  const [previewSize, setPreviewSize] = useState<ChannelCardSize>({});
  const geometry = useChannelCardGeometry(previewSize);
  const [morphing, setMorphing] = useState(false);
  const previousPinnedRef = useRef(pinned);

  const restoreTriggerFocus = () => {
    document.querySelector<HTMLElement>('[data-channel-config-trigger][aria-expanded="true"]')?.focus();
  };

  useLayoutEffect(() => {
    if (previousPinnedRef.current === pinned) return;
    previousPinnedRef.current = pinned;
    setMorphing(true);
    const timer = window.setTimeout(() => setMorphing(false), MORPH_MS + 40);
    return () => window.clearTimeout(timer);
  }, [pinned]);

  useEffect(() => {
    if (!preview) return;

    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (drawerRef.current?.contains(target) || target.closest('[data-channel-config-trigger]')) return;
      const ownerId = target.closest<HTMLElement>('[data-portal-owner]')?.dataset.portalOwner;
      if (ownerId && drawerRef.current?.contains(document.getElementById(ownerId))) return;
      closeChannelConfig();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      restoreTriggerFocus();
      closeChannelConfig();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [preview, closeChannelConfig]);

  const ratioPercent = `${(showBottom ? splitRatio : 1) * 100}%`;
  const innerRadius = `${CHANNEL_CARD_RADIUS - 1}px`;
  let bodyStyle: CSSProperties;
  if (pinned) {
    bodyStyle = geometry && morphing
      ? { ...geometry.docked, borderRadius: 0 }
      : { left: 0, top: 0, width: '100%', height: ratioPercent, borderRadius: 0 };
  } else if (geometry) {
    bodyStyle = { ...geometry.card, borderRadius: geometry.bodyRadius };
  } else {
    bodyStyle = {
      left: 0,
      top: CHANNEL_CARD_INSET,
      width: `calc(100% - ${CHANNEL_CARD_INSET}px)`,
      height: `calc(${splitRatio * 100}% - ${CHANNEL_CARD_INSET}px)`,
      borderRadius: innerRadius,
    };
  }

  const outline = geometry?.outline ?? null;
  const attached = !pinned && !!geometry?.tab;
  const className = [
    `channel-config-drawer channel-card-accent-${accent} pointer-events-none absolute inset-0 ${pinned ? 'z-10' : 'z-20'} text-text-primary`,
    morphing ? 'is-morphing' : '',
    isResizing ? 'is-resizing' : '',
  ].filter(Boolean).join(' ');

  return (
    <section
      ref={drawerRef}
      id="channel-config-drawer"
      aria-label="Channel settings"
      aria-hidden={!visible}
      inert={!visible}
      data-state={pinned ? 'pinned' : preview ? 'preview' : 'hidden'}
      data-attached={attached ? 'true' : 'false'}
      className={className}
    >
      <div className="channel-card-slide absolute inset-0">
        {outline && (
          <>
            <div
              aria-hidden="true"
              data-channel-card-chrome
              className="channel-card-blur absolute"
              style={{
                left: outline.left,
                top: outline.top,
                width: outline.width,
                height: outline.height,
                clipPath: `path('${outline.path}')`,
              }}
            />
            <svg
              aria-hidden="true"
              data-channel-card-chrome
              className="channel-card-outline absolute overflow-visible"
              style={{ left: outline.left, top: outline.top }}
              width={outline.width}
              height={outline.height}
              viewBox={`0 0 ${outline.width} ${outline.height}`}
            >
              <path d={outline.path} />
            </svg>
          </>
        )}
        <div
          data-channel-card-body
          className={`channel-card-body pointer-events-auto absolute flex flex-col overflow-hidden ${outline ? '' : 'is-self-framed'}`}
          style={bodyStyle}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
            {children}
          </div>
          {preview && geometry && (
            <PreviewResizeHandles size={geometry.card} onResize={(change) => setPreviewSize((previous) => ({ ...previous, ...change }))} />
          )}
        </div>
      </div>
    </section>
  );
}

type ResizeEdge = 'right' | 'bottom' | 'corner';

function PreviewResizeHandles({ size, onResize }: {
  size: Required<ChannelCardSize>;
  onResize: (size: ChannelCardSize) => void;
}) {
  const dragRef = useRef<AbortController | null>(null);
  useEffect(() => () => dragRef.current?.abort(), []);
  const handles = {
    right: 'inset-y-3 right-0 w-2 cursor-ew-resize',
    bottom: 'inset-x-3 bottom-0 h-2 cursor-ns-resize',
    corner: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
  } as const;

  return (Object.keys(handles) as ResizeEdge[]).map((edge) => (
    <div
      key={edge}
      aria-hidden="true"
      data-channel-card-resize={edge}
      className={`absolute touch-none select-none ${handles[edge]}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        dragRef.current?.abort();
        const drag = new AbortController();
        dragRef.current = drag;
        const { pointerId, clientX, clientY } = event;
        event.currentTarget.setPointerCapture(pointerId);
        const resize = (move: PointerEvent) => {
          if (move.pointerId !== pointerId) return;
          const change: ChannelCardSize = {};
          if (edge !== 'bottom') change.width = size.width + move.clientX - clientX;
          if (edge !== 'right') change.height = size.height + move.clientY - clientY;
          onResize(change);
        };
        const finish = (end: PointerEvent) => {
          if (end.pointerId === pointerId) drag.abort();
        };
        const options = { capture: true, signal: drag.signal };
        window.addEventListener('pointermove', resize, options);
        window.addEventListener('pointerup', finish, options);
        window.addEventListener('pointercancel', finish, options);
        window.addEventListener('blur', () => drag.abort(), options);
      }}
    />
  ));
}
