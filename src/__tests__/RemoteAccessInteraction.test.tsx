import { fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { RemoteAccessControl } from '../components/layout/RemoteAccessControl';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('settings controls accept clicks and text without bubbling into window dragging', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const drag = vi.fn();
  vi.mocked(invoke).mockImplementation(async command => command === 'remote_status' ? {
    enabled: true, trusted: [], recent: [], pending: null, connected: null, controller: null,
  } : undefined);
  const rendered = render(<div onMouseDown={drag}><RemoteAccessControl ready={false} container={container} /></div>);
  try {
    const toggle = screen.getByRole('switch', { name: 'Allow remote' });
    expect(screen.queryByLabelText('Pairing invitation')).toBeNull();
    fireEvent.mouseDown(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
    const input = screen.getByLabelText('Remote pairing invitation');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'linkassist1:test-invitation' } });
    expect((input as HTMLInputElement).value).toBe('linkassist1:test-invitation');
    expect(drag).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('remote_enable', { enabled: true });
  } finally { rendered.unmount(); container.remove(); }
});

it('shows code controls when enabled and keeps all devices in Connect', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const status = { enabled: true, trusted: [{id:'controller',name:'Office controller',invitation:null}], recent: [{id:'host',name:'Lab host',invitation:'LA2:host'}], pending: null, connected: null, controller: null,
    invitation: `LA2:${'a'.repeat(64)}`, inviteExpiresAt: Date.now() + 300000, persistentInvite: false, noApproval: false };
  vi.mocked(invoke).mockImplementation(async command => command === 'remote_status' ? status : undefined);
  const rendered = render(<RemoteAccessControl ready={false} container={container} />);
  try {
    fireEvent.click(screen.getByRole('switch', { name: 'Allow remote' }));
    await screen.findByLabelText('Pairing invitation');
    expect((screen.getByLabelText('Pairing invitation') as HTMLInputElement).value).toHaveLength(68);
    expect(screen.getByLabelText('Pairing code validity').textContent).toMatch(/^[45]:\d\d$/);
    expect(screen.queryByText(/Keep LinkAssist running/)).toBeNull();
    const devices = screen.getByRole('region', { name: 'Connect' });
    expect(within(devices).getByText('Office controller')).toBeTruthy();
    expect(within(devices).getByText('Lab host')).toBeTruthy();
    expect(screen.getByRole('button', {name:'Copy pairing code'}).querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('button', {name:'Refresh pairing code'}).querySelector('svg')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Connect without local approval' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_set_no_approval', { enabled: true }));
    await waitFor(() => expect((screen.getByRole('switch', { name: 'Persistent' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('switch', { name: 'Persistent' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('remote_invite', { persistent: true }));
  } finally { rendered.unmount(); container.remove(); }
});

it('keeps controls visually enabled and focused while suppressing duplicate operations', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const status = { enabled: true, trusted: [], recent: [], pending: null, connected: null, controller: null,
    invitation: 'LA2:test', persistentInvite: false, noApproval: false };
  let finishRefresh: (() => void) | undefined;
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === 'remote_status') return status;
    if (command === 'remote_invite') await new Promise<void>(resolve => { finishRefresh = resolve; });
  });
  const rendered = render(<RemoteAccessControl ready={false} container={container} />);
  try {
    fireEvent.click(screen.getByRole('switch', { name: 'Allow remote' }));
    const refresh = await screen.findByRole('button', { name: 'Refresh pairing code' });
    await waitFor(() => expect(refresh.getAttribute('aria-disabled')).toBe('false'));
    refresh.focus();
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole('switch', { name: 'Persistent' }));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'remote_invite')).toHaveLength(1);
    expect(document.activeElement).toBe(refresh);
    expect(container.querySelectorAll('button:disabled')).toHaveLength(1); // Empty target Connect only.
    expect(refresh.getAttribute('aria-disabled')).toBe('true');
    finishRefresh?.();
    await waitFor(() => expect(refresh.getAttribute('aria-disabled')).toBe('false'));
    expect(document.activeElement).toBe(refresh);
  } finally { rendered.unmount(); container.remove(); }
});
