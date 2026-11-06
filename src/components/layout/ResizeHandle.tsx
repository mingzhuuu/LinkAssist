import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  showLine?: boolean;
  hairline?: boolean;
  topInset?: number;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  onResize,
  showLine = true,
  hairline = false,
  topInset = 0,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const lastXRef = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    lastXRef.current = e.clientX;
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - lastXRef.current;
      lastXRef.current = e.clientX;
      if (deltaX !== 0) {
        onResize(deltaX);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, onResize]);

  return (
    <div
      className={`relative w-0 cursor-col-resize group ${showLine ? 'z-10' : 'z-40'}`}
      onMouseDown={handleMouseDown}
    >
      {showLine && (
        <div
          className={`absolute bottom-0 left-0 w-px origin-left transition-[background-color,top] duration-200 group-hover:bg-[var(--layer-active)] ${hairline ? 'scale-x-50 bg-[var(--divider-default)]' : 'bg-border'}`}
          style={{ top: topInset }}
        />
      )}
      {/* Hit area: wider for easier grabbing */}
      <div className="absolute inset-y-0 -left-1 w-2" />
    </div>
  );
};
