import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/**
 * Мост разрешений и перезапуск панели. Запрос агента попадает в окно, когда
 * порт панели закрыт (сервер поднимается заново): ответ должен прийти от
 * поднявшегося сервера, а не «запретить» по первой же сетевой ошибке. И
 * наоборот: отказ, который сервер вернул сам, повторяться не должен.
 */

const BRIDGE = fileURLToPath(new URL('./permission-prompt-server.mjs', import.meta.url));

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as { port: number };
  probe.close();
  await once(probe, 'close');
  return port;
}

interface BridgeReply {
  behavior: string;
  message?: string;
}

/** Запускает мост, зовёт `approve` один раз, возвращает решение. */
function callBridge(port: number): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, PERM_RUN_ID: 'run-1', PERM_BASE_URL: `http://127.0.0.1:${port}` },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: { content: { text: string }[] };
        };
        if (message.id === 7 && message.result) {
          child.kill();
          resolve(JSON.parse(message.result.content[0]?.text ?? '{}') as BridgeReply);
        }
      }
    });
    child.on('error', reject);
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'approve',
          arguments: { tool_name: 'Write', input: { a: 1 }, tool_use_id: 't1' },
        },
      })}\n`,
    );
  });
}

function answerWith(port: number, body: unknown, onHit: () => void): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      onHit();
      request.resume();
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(body));
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('мост разрешений переживает перезапуск панели', () => {
  it('порт закрыт в момент запроса — мост ждёт и получает решение от поднявшегося сервера', async () => {
    const port = await freePort();
    let hits = 0;
    const pending = callBridge(port);
    // Панель «поднимается» через две секунды: первая попытка бьётся в закрытый порт.
    await new Promise((done) => setTimeout(done, 2000));
    const server = await answerWith(port, { behavior: 'allow', updatedInput: { a: 1 } }, () => {
      hits += 1;
    });
    try {
      const reply = await pending;
      expect(reply.behavior).toBe('allow');
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  }, 20_000);

  it('отказ, который вернул сам сервер, не повторяется', async () => {
    const port = await freePort();
    let hits = 0;
    const server = await answerWith(
      port,
      { behavior: 'deny', message: 'прогон не в реестре' },
      () => {
        hits += 1;
      },
    );
    try {
      const reply = await callBridge(port);
      expect(reply).toEqual({ behavior: 'deny', message: 'прогон не в реестре' });
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  }, 20_000);
});
