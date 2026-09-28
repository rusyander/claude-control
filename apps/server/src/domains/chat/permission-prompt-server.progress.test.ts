import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

/**
 * Мост разрешений держит вызов живым, пока человек думает. CLI рвёт вызов
 * MCP-инструмента без ответа и без прогресса дольше своего срока простоя
 * (живьём: claude 2.1.282, 30 минут по умолчанию), и сбрасывает этот срок
 * только `notifications/progress` с токеном САМОГО вызова. Проверяется
 * настоящий процесс моста: сколько сигналов он шлёт, с каким токеном, и что
 * после решения они прекращаются.
 */

const BRIDGE = fileURLToPath(new URL('./permission-prompt-server.mjs', import.meta.url));

interface Line {
  id?: number;
  method?: string;
  params?: { progressToken?: unknown; progress?: number };
  result?: { content: { text: string }[] };
}

/** Панель, которая отвечает на запрос прав через `holdMs`. */
async function slowPanel(holdMs: number): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ behavior: 'allow', updatedInput: { a: 1 } }));
      }, holdMs);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as { port: number }).port };
}

/**
 * Зовёт `approve` и собирает всё, что мост написал, до решения и ещё `afterMs`
 * после него — чтобы увидеть, что сигнал не пережил ответ.
 */
function callBridge(
  port: number,
  env: Record<string, string>,
  meta: Record<string, unknown> | undefined,
  afterMs = 400,
): Promise<{ lines: Line[]; resultIndex: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env,
        PERM_RUN_ID: 'run-1',
        PERM_BASE_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines: Line[] = [];
    let buffer = '';
    let resultIndex = -1;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (!part.trim()) continue;
        const line = JSON.parse(part) as Line;
        lines.push(line);
        if (line.id === 7 && line.result && resultIndex < 0) {
          resultIndex = lines.length - 1;
          setTimeout(() => {
            child.kill();
            resolve({ lines, resultIndex });
          }, afterMs);
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
          ...(meta ? { _meta: meta } : {}),
        },
      })}\n`,
    );
  });
}

const progressOf = (lines: Line[]): Line[] =>
  lines.filter((line) => line.method === 'notifications/progress');

describe('мост разрешений подаёт признак жизни, пока ждёт человека', () => {
  it('шлёт прогресс с токеном вызова, пока ответа нет, и замолкает после решения', async () => {
    const { server, port } = await slowPanel(700);
    try {
      const { lines, resultIndex } = await callBridge(
        port,
        { PERM_PROGRESS_MS: '100' },
        { progressToken: 42, 'claudecode/toolUseId': 't1' },
      );
      const beats = progressOf(lines);
      expect(beats.length).toBeGreaterThanOrEqual(4);
      // Токен — ровно тот, что прислал CLI: чужой CLI не засчитывает.
      expect(beats.every((line) => line.params?.progressToken === 42)).toBe(true);
      // Счётчик растёт — CLI видит движение, а не повтор одного и того же.
      expect(beats.map((line) => line.params?.progress)).toEqual(beats.map((_, i) => i + 1));
      // После решения — ни одного сигнала.
      expect(progressOf(lines.slice(resultIndex + 1))).toEqual([]);
      expect(JSON.parse(lines[resultIndex]?.result?.content[0]?.text ?? '{}')).toMatchObject({
        behavior: 'allow',
      });
    } finally {
      server.close();
    }
  }, 20_000);

  it('без токена в вызове прогресс не шлётся — его некуда отнести', async () => {
    const { server, port } = await slowPanel(400);
    try {
      const { lines } = await callBridge(port, { PERM_PROGRESS_MS: '100' }, undefined);
      expect(progressOf(lines)).toEqual([]);
    } finally {
      server.close();
    }
  }, 20_000);

  it('PERM_PROGRESS_MS=0 выключает сигнал (так проверка доказывает смерть без него)', async () => {
    const { server, port } = await slowPanel(400);
    try {
      const { lines } = await callBridge(port, { PERM_PROGRESS_MS: '0' }, { progressToken: 42 });
      expect(progressOf(lines)).toEqual([]);
    } finally {
      server.close();
    }
  }, 20_000);
});
