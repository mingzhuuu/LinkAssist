export async function sendWithImmediateTxEcho(
  echoTx: () => void,
  send: () => Promise<unknown>
): Promise<void> {
  // A response can arrive before an asynchronous send invocation resolves.
  // Echo the user's send first so terminal history preserves causality.
  echoTx();
  await send();
}
