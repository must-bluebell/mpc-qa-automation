import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { MockRpc } from './helpers/rpc.js';

test('RPC fixture blocks and records WebSockets without reaching the server', async ({ context, page }) => {
  const server = createServer();
  let connections = 0;
  server.on('upgrade', (_request, socket) => { connections++; socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing server address');
    const url = `ws://127.0.0.1:${address.port}/rpc`;
    const rpc = new MockRpc();
    await rpc.install(context);
    await page.evaluate(url => new Promise<void>(resolve => {
      const socket = new WebSocket(url);
      socket.onclose = () => resolve();
      socket.onerror = () => resolve();
    }), url);
    expect(rpc.unexpected).toEqual([url]);
    expect(connections).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
