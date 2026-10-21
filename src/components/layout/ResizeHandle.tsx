import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  onResize: (deltaX: number) => void;
  showLine?: boolean;
  hairline?: boolean;
}

export const ResizeHandle: React.FC<ResizeHandleProps> = ({ onResize, showLine = true, hairline = false }) => {
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
      className="relative w-0 cursor-col-resize z-10 group"
      onMouseDown={handleMouseDown}
    >
      {showLine && (
        <div className={`absolute inset-y-0 left-0 w-px origin-left transition-colors group-hover:bg-[var(--layer-active)] ${hairline ? 'scale-x-50 bg-[var(--divider-default)]' : 'bg-border'}`} />
      )}
      {/* Hit area: wider for easier grabbing */}
      <div className="absolute inset-y-0 -left-1 w-2" />
    </div>
  );
};
