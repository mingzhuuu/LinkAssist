import React, { useCallback, useEffect, useRef } from 'react';
import { useChannelStore, toast } from '../../stores';
import { useTerminalStore } from '../../stores/terminalStore';
import { prepareTerminalInteractiveSend } from '../../lib/terminalSend';

const SPECIAL_KEY_SEQUENCES: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
  Insert: '\x1b[2~',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
};

const utf8Encoder = new TextEncoder();

export function encodeInteractiveText(text: string): number[] {
  return Array.from(utf8Encoder.encode(text));
}

export function encodeInteractiveKey(
  event: Pick<React.KeyboardEvent<HTMLInputElement>, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
  hasSelection = false,
): number[] | null {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    return null;
  }

  if (event.ctrlKey && !event.altKey && !event.metaKey) {
    const key = event.key;
    if (key === 'v' || key === 'V') return null;
    if ((key === 'c' || key === 'C') && hasSelection) return null;
    if (key.length === 1) {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) return [code & 0x1f];
      if (key === '@' || key === ' ' || key === '2') return [0x00];
      if (key === '[') return [0x1b];
      if (key === '\\') return [0x1c];
      if (key === ']') return [0x1d];
      if (key === '^' || key === '6') return [0x1e];
      if (key === '_' || key === '-') return [0x1f];
    }
    return null;
  }

  if (event.altKey || event.metaKey) {
    return null;
  }

  const special = SPECIAL_KEY_SEQUENCES[event.key];
  if (special !== undefined) {
    return encodeInteractiveText(special);
  }

  if (event.key.length === 1) {
    return encodeInteractiveText(event.key);
  }

  return null;
}

interface InteractiveTerminalInputOptions {
  paneId: string | null;
  channelId: string | null;
  enabled: boolean;
}

/**
 * Handles real-time raw key/text transmission in interactive terminal mode
 * while keeping the command window display and input line content unchanged.
 */
export function useInteractiveTerminalInput({
  paneId,
  channelId,
  enabled,
}: InteractiveTerminalInputOptions) {
  const sendBytesRef = useRef<(data: number[]) => void>(() => {});
  const composingRef = useRef(false);

  useEffect(() => {
    composingRef.current = false;
    if (!enabled || !paneId) {
      sendBytesRef.current = () => {};
      return;
    }

    let disposed = false;
    let queue = Promise.resolve();
    let sendGeneration = 0;

    const reportError = (message: string) => {
      if (!disposed) {
        toast.error(message);
      }
    };

    sendBytesRef.current = (data: number[]) => {
      if (disposed || data.length === 0) return;
      const channel = useChannelStore.getState().channels.find(item => item.id === channelId);
      const pane = useTerminalStore.getState().panes[paneId];
      if (!channel || !pane) {
        reportError('Select a send target channel first');
        return;
      }

      try {
        const send = prepareTerminalInteractiveSend(channel, pane, data, reportError);
        const generation = sendGeneration;
        queue = queue.then(async () => {
          if (disposed || generation !== sendGeneration) return;
          await send();
        }).catch(reason => {
          sendGeneration++;
          reportError(`Send error: ${String(reason)}`);
        });
      } catch (reason) {
        sendGeneration++;
        reportError(`Send error: ${String(reason)}`);
      }
    };

    return () => {
      disposed = true;
      sendBytesRef.current = () => {};
    };
  }, [enabled, paneId, channelId]);

  const handleInteractiveKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>): boolean => {
    if (!enabled) return false;
    if (event.nativeEvent.isComposing || event.key === 'Process') {
      return true;
    }
    if (composingRef.current) {
      if (event.key === 'Enter' || event.key === 'Escape' || event.key === 'Backspace') {
        composingRef.current = false;
      } else {
        return true;
      }
    }

    const selectionText = typeof window !== 'undefined' ? (window.getSelection()?.toString() ?? '') : '';
    const bytes = encodeInteractiveKey(event, selectionText.length > 0);
    if (!bytes) {
      return false;
    }

    event.preventDefault();
    sendBytesRef.current(bytes);
    return true;
  }, [enabled]);

  const handleInteractivePaste = useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
    if (!enabled) return;
    event.preventDefault();
    const text = event.clipboardData.getData('text');
    if (text) {
      sendBytesRef.current(encodeInteractiveText(text));
    }
  }, [enabled]);

  const handleInteractiveCompositionStart = useCallback(() => {
    if (!enabled) return;
    composingRef.current = true;
  }, [enabled]);

  const handleInteractiveCompositionEnd = useCallback((event: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    if (!enabled) return;
    const committed = event.data;
    const savedInput = paneId ? (useTerminalStore.getState().panes[paneId]?.cmdInput ?? '') : '';
    event.currentTarget.value = savedInput;
    if (committed) {
      sendBytesRef.current(encodeInteractiveText(committed));
    }
  }, [enabled, paneId]);

  const handleInteractiveBlur = useCallback(() => {
    composingRef.current = false;
  }, []);

  return {
    handleInteractiveKeyDown,
    handleInteractivePaste,
    handleInteractiveCompositionStart,
    handleInteractiveCompositionEnd,
    handleInteractiveBlur,
  };
}
