import { beforeEach, describe, expect, it } from 'vitest';
import {
  CENTER_PANEL_DEFAULT_WIDTH,
  CENTER_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  useUIStore,
} from '../stores/uiStore';

describe('panelWidthInvariance', () => {
  beforeEach(() => {
    useUIStore.setState({
      leftPanelWidth: LEFT_PANEL_MIN_WIDTH,
      centerPanelWidth: CENTER_PANEL_DEFAULT_WIDTH,
      rightPanelWidth: 360,
      channelPanelVisible: true,
      rightPanelVisible: true,
      centerTopVisible: true,
      centerBottomVisible: true,
      simpleMode: false,
    });
  });

  it('initializes channel and center panel widths to standard default constants', () => {
    const state = useUIStore.getState();
    expect(state.leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(state.centerPanelWidth).toBe(CENTER_PANEL_DEFAULT_WIDTH);
  });

  it('clamps leftPanelWidth between LEFT_PANEL_MIN_WIDTH and LEFT_PANEL_MAX_WIDTH', () => {
    const store = useUIStore.getState();
    store.setLeftPanelWidth(10);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MIN_WIDTH);

    store.setLeftPanelWidth(300);
    expect(useUIStore.getState().leftPanelWidth).toBe(LEFT_PANEL_MAX_WIDTH);

    store.setLeftPanelWidth(80);
    expect(useUIStore.getState().leftPanelWidth).toBe(80);
  });

  it('clamps centerPanelWidth to at least CENTER_PANEL_MIN_WIDTH', () => {
    const store = useUIStore.getState();
    store.setCenterPanelWidth(100);
    expect(useUIStore.getState().centerPanelWidth).toBe(CENTER_PANEL_MIN_WIDTH);

    store.setCenterPanelWidth(720);
    expect(useUIStore.getState().centerPanelWidth).toBe(720);
  });

  it('retains user-configured center and channel panel widths independently', () => {
    const store = useUIStore.getState();
    store.setLeftPanelWidth(64);
    store.setCenterPanelWidth(600);

    expect(useUIStore.getState().leftPanelWidth).toBe(64);
    expect(useUIStore.getState().centerPanelWidth).toBe(600);
  });
});
