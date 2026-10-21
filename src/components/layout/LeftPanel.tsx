import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useChannelStore, useUIStore } from '../../stores';
import { useTerminalStore } from '../../stores/terminalStore';
import { PlusIcon, BluetoothIcon, UsbIcon, WifiIcon, SignalIcon, TrashIcon, SettingsIcon, EditIcon } from '../common/Icons';

const LEFT_PANEL_ICON_RAIL = 40;

const getIconForType = (type: string) => {
  switch (type) {
    case 'ble': return <BluetoothIcon size={16} />;
    case 'serial': return <UsbIcon size={16} />;
    case 'tcp': return <WifiIcon size={16} />;
    default: return <SignalIcon size={16} />;
  }
};

const getChannelActiveClasses = (type: string) => {
  switch (type) {
    case 'ble':
      return 'channel-item-active channel-item-active-blue';
    case 'serial':
      return 'channel-item-active channel-item-active-mauve';
    case 'tcp':
      return 'channel-item-active channel-item-active-green';
    default:
      return 'channel-item-active channel-item-active-mauve';
  }
};

const getChannelIconClass = (type: string, state: string) => {
  if (state === 'connecting') return 'text-accent-yellow animate-pulse';
  if (state === 'error') return 'text-accent-red';
  if (state !== 'connected') return 'text-text-faint';

  switch (type) {
    case 'ble':
      return 'text-accent-blue';
    case 'serial':
      return 'text-accent-mauve';
    case 'tcp':
      return 'text-accent-green';
    default:
      return 'text-text-primary';
  }
};

interface ChannelListItemProps {
  channel: { id: string; name: string; type: string; state: string };
  isActive: boolean;
  collapsed: boolean;
  expansionProgress: number;
  onSelect: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string, rect: DOMRect) => void;
  onTooltipShow: (name: string, rect: DOMRect) => void;
  onTooltipHide: () => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent, id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
  isDragTarget: boolean;
}

const ChannelListItem = React.memo(({ channel, isActive, collapsed, expansionProgress, onSelect, onContextMenu, onTooltipShow, onTooltipHide, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isDragTarget }: ChannelListItemProps) => {
  const horizontalMargin = 4 * expansionProgress;
  const leftPadding = 12 - horizontalMargin;
  const itemStyle = {
    '--channel-active-left-inset': `${2 - horizontalMargin}px`,
    columnGap: `${8 * expansionProgress}px`,
    marginLeft: `${horizontalMargin}px`,
    marginRight: `${horizontalMargin}px`,
    paddingLeft: `${leftPadding}px`,
    paddingRight: '8px',
  } as React.CSSProperties;

  return (
    <div
      className={`animate-slide-in channel-item isolate box-border h-8 rounded-sm ${isActive ? getChannelActiveClasses(channel.type) : ''} ${isDragTarget ? 'ring-1 ring-accent-mauve/50 bg-[var(--layer-selected)]' : ''} ${isDragging ? 'opacity-45' : ''} flex items-center cursor-grab active:cursor-grabbing transition-colors py-0`}
      style={itemStyle}
      draggable
      onClick={() => onSelect(channel.id)}
      onContextMenu={(e) => onContextMenu(e, channel.id, e.currentTarget.getBoundingClientRect())}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', channel.id);
        onDragStart(channel.id);
      }}
      onDragOver={(event) => onDragOver(event, channel.id)}
      onDrop={() => onDrop(channel.id)}
      onDragEnd={onDragEnd}
      onMouseEnter={(event) => {
        if (collapsed) {
          onTooltipShow(channel.name, event.currentTarget.getBoundingClientRect());
        }
      }}
      onMouseLeave={onTooltipHide}
    >
      <div className={`${getChannelIconClass(channel.type, channel.state)} relative z-[1] shrink-0 transition-colors duration-150`}>
        {getIconForType(channel.type)}
      </div>
      <div
        aria-hidden={expansionProgress === 0}
        className="relative z-[1] min-w-0 flex-1 truncate text-sm leading-4 text-text-primary transition-[opacity,transform] duration-75 ease-out"
        style={{
          opacity: expansionProgress,
          transform: `translateX(${-4 * (1 - expansionProgress)}px)`,
        }}
      >
        {channel.name}
      </div>
    </div>
  );
});

interface LeftPanelProps {
  collapsed: boolean;
  expansionProgress: number;
  showSettings: boolean;
  onToggleSettings: () => void;
}

export const LeftPanel: React.FC<LeftPanelProps> = ({ collapsed, expansionProgress, showSettings, onToggleSettings }) => {
  const { channels, activeChannelId, setActiveChannel, addChannel, removeChannel, renameChannel, reorderChannel } = useChannelStore();
  const { showAddChannelMenu, setShowAddChannelMenu } = useUIStore();
  
  const menuRef = useRef<HTMLDivElement>(null);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number; channelX: number; channelY: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameDialogRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [channelTooltip, setChannelTooltip] = useState<{ name: string; x: number; y: number } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ id: string; value: string; x: number; y: number } | null>(null);
  const [draggingChannelId, setDraggingChannelId] = useState<string | null>(null);
  const [dragOverChannelId, setDragOverChannelId] = useState<string | null>(null);

  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  const handleSelectChannel = useCallback((channelId: string) => {
    setActiveChannel(channelId);
  }, [setActiveChannel]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        showAddChannelMenu &&
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        addBtnRef.current &&
        !addBtnRef.current.contains(event.target as Node)
      ) {
        setShowAddChannelMenu(false);
      }
      
      if (
        contextMenu &&
        contextMenuRef.current &&
        !contextMenuRef.current.contains(event.target as Node) &&
        !renameDialogRef.current?.contains(event.target as Node)
      ) {
        setContextMenu(null);
      }

      if (
        renameDialog &&
        renameDialogRef.current &&
        !renameDialogRef.current.contains(event.target as Node)
      ) {
        setRenameDialog(null);
      }

    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAddChannelMenu, setShowAddChannelMenu, contextMenu, renameDialog]);

  useEffect(() => {
    if (!renameDialog) return;

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameDialog?.id]);

  const handleToggleMenu = useCallback(() => {
    if (!showAddChannelMenu && collapsed && addBtnRef.current) {
      const rect = addBtnRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.top, left: rect.right + 4 });
    }
    setShowAddChannelMenu(!showAddChannelMenu);
  }, [showAddChannelMenu, collapsed, setShowAddChannelMenu]);

  const handleAddChannel = useCallback((type: 'ble' | 'serial' | 'tcp', baseName: string) => {
    let name = baseName;
    let counter = 2;
    while (channels.some(c => c.name === name)) {
      name = `${baseName} ${counter}`;
      counter++;
    }
    
    addChannel(type, name);
    setShowAddChannelMenu(false);
    
    const newChannel = useChannelStore.getState().channels.find(c => c.name === name);
    if (newChannel) {
      setActiveChannel(newChannel.id);
    }
  }, [channels, addChannel, setShowAddChannelMenu, setActiveChannel]);

  const handleContextMenu = useCallback((e: React.MouseEvent, id: string, rect: DOMRect) => {
    e.preventDefault();
    setChannelTooltip(null);
    setRenameDialog(null);
    setContextMenu({
      id,
      x: Math.min(e.clientX, window.innerWidth - 184),
      y: Math.min(e.clientY, window.innerHeight - 92),
      channelX: Math.min(rect.right + 10, window.innerWidth - 232),
      channelY: Math.min(Math.max(rect.top + rect.height / 2, 82), window.innerHeight - 82),
    });
  }, []);

  const handleDragStart = useCallback((id: string) => {
    setChannelTooltip(null);
    setDraggingChannelId(id);
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent, id: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverChannelId(id);
  }, []);

  const handleDrop = useCallback((targetId: string) => {
    if (draggingChannelId && draggingChannelId !== targetId) {
      reorderChannel(draggingChannelId, targetId);
    }
    setDraggingChannelId(null);
    setDragOverChannelId(null);
  }, [draggingChannelId, reorderChannel]);

  const handleDragEnd = useCallback(() => {
    setDraggingChannelId(null);
    setDragOverChannelId(null);
  }, []);

  const handleTooltipShow = useCallback((name: string, rect: DOMRect) => {
    setChannelTooltip({
      name,
      x: rect.right + 10,
      y: rect.top + rect.height / 2,
    });
  }, []);

  const handleTooltipHide = useCallback(() => {
    setChannelTooltip(null);
  }, []);

  const commitRenameChannel = useCallback(() => {
    if (!renameDialog) return;

    const channel = channels.find(item => item.id === renameDialog.id);
    if (!channel) {
      setRenameDialog(null);
      return;
    }

    const finalName = renameDialog.value.trim() || channel.name;
    const id = renameDialog.id;
    renameChannel(id, finalName);

    const { panes, renameTab } = useTerminalStore.getState();
    for (const [paneId, pane] of Object.entries(panes)) {
      for (const tab of pane.tabs) {
        if (tab.channelId === id) {
          renameTab(paneId, tab.id, finalName);
        }
      }
    }

    setRenameDialog(null);
    setContextMenu(null);
  }, [channels, renameDialog, renameChannel]);

  const openRenameDialog = useCallback(() => {
    if (!contextMenu) return;

    const channel = channels.find(item => item.id === contextMenu.id);
    if (!channel) {
      setContextMenu(null);
      return;
    }

    setRenameDialog({
      id: channel.id,
      value: channel.name,
      x: contextMenu.channelX,
      y: contextMenu.channelY,
    });
    setContextMenu(null);
  }, [channels, contextMenu]);

  const addChannelMenu = showAddChannelMenu && (
    <div 
      ref={menuRef} 
      className={`animate-fade-in bg-surface-overlay border border-border overflow-hidden z-50 rounded-xl p-1 shadow-xl shadow-black/30 backdrop-blur-sm ${
        collapsed 
          ? 'fixed w-36' 
          : 'absolute left-0 right-0 mt-1'
      }`}
      style={collapsed && menuPos ? { top: menuPos.top, left: menuPos.left } : undefined}
    >
      <div 
        className="rounded-lg px-2.5 py-1.5 hover:bg-[var(--layer-selected)] cursor-pointer flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap"
        onClick={() => handleAddChannel('ble', 'BLE')}
      >
        <BluetoothIcon size={14} /> BLE
      </div>
      <div 
        className="rounded-lg px-2.5 py-1.5 hover:bg-[var(--layer-selected)] cursor-pointer flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap"
        onClick={() => handleAddChannel('serial', 'UART')}
      >
        <UsbIcon size={14} /> UART
      </div>
      <div 
        className="rounded-lg px-2.5 py-1.5 hover:bg-[var(--layer-selected)] cursor-pointer flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary transition-colors whitespace-nowrap"
        onClick={() => handleAddChannel('tcp', 'TCP/IP')}
      >
        <WifiIcon size={14} /> TCP/IP
      </div>
    </div>
  );

  const AddButton = (
    <div className={`relative ${channels.length === 0 ? 'mb-1' : 'mt-1'}`}>
      <button
        ref={addBtnRef}
        className="flex h-8 items-center justify-start text-text-muted transition-colors duration-150 hover:bg-[var(--layer-hover)] hover:text-text-secondary"
        style={{
          marginLeft: `${4 * expansionProgress}px`,
          paddingLeft: `${14 - (4 * expansionProgress)}px`,
          width: `calc(100% - ${8 * expansionProgress}px)`,
        }}
        onClick={handleToggleMenu}
        title="Add channel"
      >
        <PlusIcon size={12} />
      </button>

      {!collapsed && addChannelMenu}
    </div>
  );

  return (
    <div className="flex flex-col h-full relative">
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-1">
        {channels.length === 0 ? (
          <div
            className="flex h-full flex-col"
            style={{ width: '100%' }}
          >
            {AddButton}
            {!collapsed && (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center text-text-muted">
                <p
                  aria-hidden={expansionProgress === 0}
                  className="max-w-full break-words text-center text-sm transition-[opacity,transform] duration-75 ease-out"
                  style={{
                    opacity: expansionProgress,
                    transform: `translateX(${-4 * (1 - expansionProgress)}px)`,
                  }}
                >
                  No channels
                </p>
              </div>
            )}
          </div>
        ) : (
          <div
            style={{ width: '100%' }}
          >
            {channels.map((channel) => (
              <ChannelListItem
                key={channel.id}
                channel={channel}
                isActive={activeChannelId === channel.id}
                collapsed={collapsed}
                expansionProgress={expansionProgress}
                onSelect={handleSelectChannel}
                onContextMenu={handleContextMenu}
                onTooltipShow={handleTooltipShow}
                onTooltipHide={handleTooltipHide}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                isDragging={draggingChannelId === channel.id}
                isDragTarget={dragOverChannelId === channel.id && draggingChannelId !== channel.id}
              />
            ))}
            {AddButton}
          </div>
        )}
      </div>

      {collapsed && addChannelMenu}

      {channelTooltip && (
        <div
          className="pointer-events-none fixed z-[60] -translate-y-1/2 animate-fade-in rounded-2xl border border-border bg-surface-overlay/95 px-3 py-2 text-xs font-medium text-text-primary shadow-xl shadow-black/30 backdrop-blur-sm whitespace-nowrap"
          style={{ top: channelTooltip.y, left: channelTooltip.x }}
        >
          {channelTooltip.name}
        </div>
      )}

      {contextMenu && (
        <div 
          ref={contextMenuRef}
          className="animate-fade-in fixed bg-surface-overlay border border-border overflow-hidden z-50 w-44 rounded-xl p-1 shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <div 
            className="rounded-lg px-2.5 py-1.5 hover:bg-[var(--layer-selected)] text-text-secondary hover:text-text-primary cursor-pointer flex items-center gap-2 text-sm transition-colors"
            onClick={openRenameDialog}
          >
            <EditIcon size={14} /> Rename Channel
          </div>
          <div 
            className="rounded-lg px-2.5 py-1.5 hover:bg-red-500/20 text-red-400 cursor-pointer flex items-center gap-2 text-sm transition-colors"
            onClick={() => {
              removeChannel(contextMenu.id);
              if (activeChannelId === contextMenu.id) {
                setActiveChannel(null);
              }
              setContextMenu(null);
            }}
          >
            <TrashIcon size={14} /> Delete Channel
          </div>
        </div>
      )}

      {renameDialog && (
        <div
          ref={renameDialogRef}
          className="animate-fade-in fixed z-50 w-56 rounded-xl border border-border bg-surface-overlay p-2 shadow-xl shadow-black/30 backdrop-blur-sm"
          style={{ top: renameDialog.y, left: renameDialog.x, transform: 'translateY(-50%)' }}
        >
          <div className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Channel name
          </div>
          <input
            ref={renameInputRef}
            className="input-base w-full rounded-lg bg-surface-tertiary/80"
            value={renameDialog.value}
            onChange={(event) => setRenameDialog(current => current ? { ...current, value: event.target.value } : current)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRenameChannel();
              }
              if (event.key === 'Escape') {
                setRenameDialog(null);
              }
            }}
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button
              className="rounded-lg px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-[var(--layer-selected)] hover:text-text-secondary"
              onClick={() => setRenameDialog(null)}
            >
              Cancel
            </button>
            <button
              className="rounded-lg bg-accent-mauve/15 px-2.5 py-1 text-xs font-medium text-accent-mauve transition-colors hover:bg-accent-mauve/25"
              onClick={commitRenameChannel}
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div className="relative py-2 shrink-0">
        <div
          className="flex items-center justify-center"
          style={{ width: LEFT_PANEL_ICON_RAIL }}
        >
          <button
            className={`btn-icon transition-colors ${showSettings ? 'text-accent-mauve bg-accent-mauve/10' : 'text-text-muted hover:text-text-secondary hover:bg-[var(--layer-hover)]'}`}
            onClick={onToggleSettings}
          >
            <SettingsIcon size={16} className="translate-y-0.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
