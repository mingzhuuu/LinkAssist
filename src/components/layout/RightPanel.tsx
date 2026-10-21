import React from 'react';
import { DisplayPanel } from '../display';

interface RightPanelProps {
  layoutReady?: boolean;
  fixedWidth?: number;
  roundMaximizedCanvasTopLeft?: boolean;
  roundMaximizedCanvasBottomRight?: boolean;
  seamlessMaximizedCanvas?: boolean;
}

export const RightPanel: React.FC<RightPanelProps> = ({
  layoutReady = true,
  fixedWidth,
  roundMaximizedCanvasTopLeft = false,
  roundMaximizedCanvasBottomRight = false,
  seamlessMaximizedCanvas = false,
}) => {
  return (
    <DisplayPanel
      layoutReady={layoutReady}
      fixedWidth={fixedWidth}
      roundMaximizedCanvasTopLeft={roundMaximizedCanvasTopLeft}
      roundMaximizedCanvasBottomRight={roundMaximizedCanvasBottomRight}
      seamlessMaximizedCanvas={seamlessMaximizedCanvas}
    />
  );
};
