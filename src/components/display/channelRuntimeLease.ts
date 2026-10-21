export interface ChannelRuntimeLeasePort {
  acquire: (channelId: string, ownerId: string) => Promise<void>;
  release: (channelId: string, ownerId: string, resume: boolean) => Promise<void>;
}

let activePort: ChannelRuntimeLeasePort | null = null;

export function registerChannelRuntimeLeasePort(port: ChannelRuntimeLeasePort): void {
  activePort = port;
}

export async function acquireChannelRuntimeLease(channelId: string, ownerId: string): Promise<void> {
  await requireChannelRuntimeLeasePort().acquire(channelId, ownerId);
}

export async function releaseChannelRuntimeLease(
  channelId: string,
  ownerId: string,
  resume: boolean,
): Promise<void> {
  await requireChannelRuntimeLeasePort().release(channelId, ownerId, resume);
}

function requireChannelRuntimeLeasePort(): ChannelRuntimeLeasePort {
  if (!activePort) {
    throw new Error('Channel runtime lease port has not been initialized');
  }
  return activePort;
}
