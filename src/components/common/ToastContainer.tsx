import React from 'react';
import { useToastStore, ToastType } from '../../stores/toastStore';
import { CloseIcon } from './Icons';

const ToastIcon = ({ type }: { type: ToastType }) => {
  switch (type) {
    case 'success':
      return <div className="w-5 h-5 rounded-full bg-accent-green/20 flex items-center justify-center text-accent-green"><span className="text-xs font-bold">✓</span></div>;
    case 'error':
      return <div className="w-5 h-5 rounded-full bg-accent-red/20 flex items-center justify-center text-accent-red"><span className="text-xs font-bold">!</span></div>;
    case 'warning':
      return <div className="w-5 h-5 rounded-full bg-accent-yellow/20 flex items-center justify-center text-accent-yellow"><span className="text-xs font-bold">!</span></div>;
    case 'info':
    default:
      return <div className="w-5 h-5 rounded-full bg-accent-blue/20 flex items-center justify-center text-accent-blue"><span className="text-xs font-bold">i</span></div>;
  }
};

export const ToastContainer: React.FC = () => {
  const { toasts, removeToast } = useToastStore();

  const visibleToasts = toasts.slice(-5);

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {visibleToasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            animate-slide-in pointer-events-auto
            flex items-center gap-3 p-3 min-w-[300px] max-w-md
            bg-surface-overlay/95 backdrop-blur-md border border-border rounded-xl shadow-xl shadow-black/20 border-l-4
            ${toast.type === 'success' ? 'border-l-accent-green' : ''}
            ${toast.type === 'error' ? 'border-l-accent-red' : ''}
            ${toast.type === 'warning' ? 'border-l-accent-yellow' : ''}
            ${toast.type === 'info' ? 'border-l-accent-blue' : ''}
          `}
        >
          <ToastIcon type={toast.type} />
          <p className="flex-1 text-sm text-text-primary">{toast.message}</p>
          <button
            onClick={() => removeToast(toast.id)}
            className="btn-icon w-6 h-6 shrink-0"
          >
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
};
