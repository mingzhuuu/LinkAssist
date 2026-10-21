import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@tauri-apps/api/event';
import type { ConnectionDataEvent } from '../types';
import { createEventSubscriptions } from '../components/layout/eventSubscriptions';

const { listenMock } = vi.hoisted(() => ({ listenMock: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));

const packet: Event<ConnectionDataEvent> = {
  event: 'serial-data-received', id: 1,
  payload: { connectionId: 'serial-1', data: [1, 2], timestamp: 3 },
};

describe('event subscription lifecycle', () => {
  beforeEach(() => { listenMock.mockReset(); });

  it('delivers events only while mounted and disposes exactly once', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const handler = vi.fn();
    const scope = createEventSubscriptions();
    scope.listen('serial-data-received', handler);
    await Promise.resolve();
    const callback = listenMock.mock.calls[0][1] as (event: typeof packet) => void;
    callback(packet);
    expect(handler).toHaveBeenCalledWith(packet);
    scope.dispose();
    scope.dispose();
    callback(packet);
    scope.listen('serial-data-received', handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  it('releases a registration that completes after unmount and suppresses queued events', async () => {
    let finish!: (value: () => void) => void;
    listenMock.mockReturnValue(new Promise<() => void>(resolve => { finish = resolve; }));
    const unlisten = vi.fn();
    const handler = vi.fn();
    const scope = createEventSubscriptions();
    scope.listen('serial-data-received', handler);
    scope.dispose();
    const callback = listenMock.mock.calls[0][1] as (event: typeof packet) => void;
    callback(packet);
    finish(unlisten);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('reports registration rejection without an unhandled promise', async () => {
    const error = new Error('registration failed');
    listenMock.mockRejectedValue(error);
    const onError = vi.fn();
    const scope = createEventSubscriptions(onError);
    scope.listen('serial-data-received', vi.fn());
    scope.dispose();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(error, 'serial-data-received');
  });

  it('continues releasing other listeners if one disposer throws', async () => {
    const error = new Error('disposal failed');
    const second = vi.fn();
    listenMock.mockResolvedValueOnce(() => { throw error; }).mockResolvedValueOnce(second);
    const onError = vi.fn();
    const scope = createEventSubscriptions(onError);
    scope.listen('serial-data-received', vi.fn());
    scope.listen('tcp-data-received', vi.fn());
    await Promise.resolve();
    scope.dispose();
    expect(second).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error, 'serial-data-received');
  });

  it('isolates a remounted scope from late callbacks and cleanup in the old scope', async () => {
    let finishOld!: (value: () => void) => void;
    const oldUnlisten = vi.fn();
    const newUnlisten = vi.fn();
    listenMock
      .mockReturnValueOnce(new Promise<() => void>(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(newUnlisten);
    const handler = vi.fn();
    const oldScope = createEventSubscriptions();
    oldScope.listen('serial-data-received', handler);
    oldScope.dispose();
    const newScope = createEventSubscriptions();
    newScope.listen('serial-data-received', handler);
    await Promise.resolve();

    const oldCallback = listenMock.mock.calls[0][1] as (event: typeof packet) => void;
    const newCallback = listenMock.mock.calls[1][1] as (event: typeof packet) => void;
    oldCallback(packet);
    newCallback(packet);
    finishOld(oldUnlisten);
    await Promise.resolve();
    expect(oldUnlisten).toHaveBeenCalledOnce();
    expect(newUnlisten).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledExactlyOnceWith(packet);

    newScope.dispose();
    newCallback(packet);
    expect(newUnlisten).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps healthy subscriptions working when a different registration fails', async () => {
    const error = new Error('TCP registration failed');
    const unlisten = vi.fn();
    listenMock.mockRejectedValueOnce(error).mockResolvedValueOnce(unlisten);
    const onError = vi.fn();
    const handler = vi.fn();
    const scope = createEventSubscriptions(onError);
    scope.listen('tcp-data-received', vi.fn());
    scope.listen('serial-data-received', handler);
    await Promise.resolve();
    const callback = listenMock.mock.calls[1][1] as (event: typeof packet) => void;
    callback(packet);
    expect(handler).toHaveBeenCalledExactlyOnceWith(packet);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, 'tcp-data-received');
    scope.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('reports a late cleanup failure once even when disposal was repeated', async () => {
    let finish!: (value: () => void) => void;
    listenMock.mockReturnValueOnce(new Promise<() => void>(resolve => { finish = resolve; }));
    const error = new Error('late cleanup failed');
    const unlisten = vi.fn(() => { throw error; });
    const onError = vi.fn();
    const scope = createEventSubscriptions(onError);
    scope.listen('serial-data-received', vi.fn());
    scope.dispose();
    scope.dispose();
    finish(unlisten);
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, 'serial-data-received');
  });
});
