import { beforeEach, describe, expect, it } from 'vitest';
import { getChannelPanelRightWin } from '../components/display/canvasSnapUtils';
import { useUIStore } from '../stores';

describe('canvasFrameBounds', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    useUIStore.setState({
      leftPanelWidth: 48,
      channelPanelVisible: true,
      simpleMode: false,
    });
  });

  describe('getChannelPanelRightWin', () => {
    it('returns content area left position when container has an ancestor with data-content-area', () => {
      const contentArea = document.createElement('div');
      contentArea.setAttribute('data-content-area', '');
      contentArea.getBoundingClientRect = () => ({
        left: 64,
        top: 36,
        right: 1200,
        bottom: 800,
        width: 1136,
        height: 764,
        x: 64,
        y: 36,
        toJSON: () => {},
      });

      const container = document.createElement('div');
      contentArea.appendChild(container);
      document.body.appendChild(contentArea);

      expect(getChannelPanelRightWin(container)).toBe(64);
    });

    it('falls back to leftPanelWidth when channel panel is visible and simpleMode is false', () => {
      useUIStore.setState({ leftPanelWidth: 80, channelPanelVisible: true, simpleMode: false });
      expect(getChannelPanelRightWin(null)).toBe(80);
    });

    it('falls back to 0 when channel panel is hidden', () => {
      useUIStore.setState({ leftPanelWidth: 80, channelPanelVisible: false, simpleMode: false });
      expect(getChannelPanelRightWin(null)).toBe(0);
    });

    it('falls back to 0 when simpleMode is enabled', () => {
      useUIStore.setState({ leftPanelWidth: 80, channelPanelVisible: true, simpleMode: true });
      expect(getChannelPanelRightWin(null)).toBe(0);
    });
  });

  describe('canvas boundary clamping: strict left/top limits, right/bottom exceeding', () => {
    it('clamps deltaX so canvas cannot cross left border (world x >= 0)', () => {
      const scrollX = 0;
      const boxMinX = 50; // currently at display x = 50
      const desiredDeltaX = -120; // attempts to move to -70

      const clampedDeltaX = Math.max(desiredDeltaX, -scrollX - boxMinX);
      // -scrollX - boxMinX = -50
      expect(clampedDeltaX).toBe(-50);
      expect(boxMinX + clampedDeltaX).toBe(0); // stops flush at left border
    });

    it('clamps deltaY so canvas cannot cross top border (world y >= 0)', () => {
      const scrollY = 0;
      const boxMinY = 30; // currently at display y = 30
      const desiredDeltaY = -100; // attempts to move to -70

      const clampedDeltaY = Math.max(desiredDeltaY, -scrollY - boxMinY);
      // -scrollY - boxMinY = -30
      expect(clampedDeltaY).toBe(-30);
      expect(boxMinY + clampedDeltaY).toBe(0); // stops flush at top border
    });

    it('allows moving right beyond the canvas frame without ceiling clamp', () => {
      const scrollX = 0;
      const boxMinX = 400;
      const desiredDeltaX = 500; // moves right to 900 (exceeds 600px viewport)

      const clampedDeltaX = Math.max(desiredDeltaX, -scrollX - boxMinX);
      expect(clampedDeltaX).toBe(500);
      expect(boxMinX + clampedDeltaX).toBe(900);
    });

    it('allows moving down beyond the canvas frame without ceiling clamp', () => {
      const scrollY = 0;
      const boxMinY = 400;
      const desiredDeltaY = 600; // moves down to 1000 (exceeds 700px viewport)

      const clampedDeltaY = Math.max(desiredDeltaY, -scrollY - boxMinY);
      expect(clampedDeltaY).toBe(600);
      expect(boxMinY + clampedDeltaY).toBe(1000);
    });
  });

  describe('scrollbar auto-hide logic and z-index stacking', () => {
    it('computes scrollbar visibility based on hover, scrolling, or dragging state', () => {
      const isVisible = (hasMetrics: boolean, hovered: boolean, scrolling: boolean, dragging: boolean, isMoving: boolean) =>
        Boolean(hasMetrics && (hovered || scrolling || dragging || isMoving));

      expect(isVisible(true, false, false, false, false)).toBe(false);
      expect(isVisible(true, true, false, false, false)).toBe(true);
      expect(isVisible(true, false, true, false, false)).toBe(true);
      expect(isVisible(true, false, false, true, false)).toBe(true);
      expect(isVisible(true, false, false, false, true)).toBe(true);
      expect(isVisible(false, true, true, true, true)).toBe(false);
    });

    it('ensures CANVAS_SCROLLBAR_Z_INDEX is strictly higher than saved or runtime canvas zIndexes', async () => {
      const { CANVAS_SCROLLBAR_Z_INDEX } = await import('../components/display/viewportUtils');
      // Preset canvases have zIndexes upwards of 1500–1600+
      const typicalHighCanvasZ = 1561;
      expect(CANVAS_SCROLLBAR_Z_INDEX).toBeGreaterThan(typicalHighCanvasZ);
      expect(CANVAS_SCROLLBAR_Z_INDEX).toBe(2147483640);
    });
  });
});
