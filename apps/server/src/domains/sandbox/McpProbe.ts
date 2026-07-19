import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { McpServer } from '@claude-control/contracts';

/**
 * Стенд для MCP-сервера: поднять, посмотреть, что он умеет, и вызвать
 * конкретный инструмент с заданными параметрами.
 *
 * Проверка соединения на странице MCP отвечает только «отзывается или нет».
 * Здесь на шаг дальше: видно список инструментов с их параметрами и можно
 * посмотреть настоящий ответ — примерно как в отладчике запросов.
 *
 * Сервер поднимается отдельным процессом и гасится сразу после ответа,
 * поэтому проверка не влияет на серверы, подключённые к самому Claude Code.
 */

export interface McpTool {
  name: string;
  description?: string;
  /** Схема параметров как есть — по ней рисуется форма вызова. */
  inputSchema?: unknown;
}

export interface McpCallResult {
  ok: boolean;
  /** Ответ инструмента или текст ошибки. */
  content: string;
  isError: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT = 30_000;

export async function listMcpTools(
  server: McpServer,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<McpTool[]> {
  const session = await talk(server, timeoutMs, (send) => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });

  const tools = (session.result as { tools?: McpTool[] } | undefined)?.tools;
  if (!tools) throw new Error(session.error ?? 'Сервер не вернул список инструментов');

  return tools;
}

export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<McpCallResult> {
  const startedAt = Date.now();

  const session = await talk(server, timeoutMs, (send) => {
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    });
  });

  const result = session.result as
    { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;

  if (!result) {
    return {
      ok: false,
      content: session.error ?? 'Сервер не ответил',
      isError: true,
      durationMs: Date.now() - startedAt,
    };
  }

  const text = (result.content ?? [])
    .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
    .join('\n');

  return {
    ok: !result.isError,
    content: text.slice(0, 100_000),
    isError: Boolean(result.isError),
    durationMs: Date.now() - startedAt,
  };
}

interface Session {
  result?: unknown;
  error?: string;
}

/**
 * Один разговор с сервером по протоколу MCP: рукопожатие, затем нужный запрос.
 * Обмен всегда идёт в одном порядке — инициализация, уведомление о готовности,
 * запрос, — поэтому общая часть вынесена сюда.
 */
function talk(
  server: McpServer,
  timeoutMs: number,
  request: (send: (message: unknown) => void) => void,
): Promise<Session> {
  if (server.transport !== 'stdio') {
    return Promise.resolve({ error: 'Пока поддерживаются только серверы, запускаемые командой' });
  }
  const command = server.command;
  if (!command) return Promise.resolve({ error: 'Не задана команда запуска' });

  return new Promise<Session>((resolve) => {
    let child: ChildProcessWithoutNullStreams;

    try {
      child = spawn(command, server.args, {
        env: { ...process.env, ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        // На Windows .cmd-обёртку без оболочки не запустить.
        shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
        windowsHide: true,
      });
    } catch (error) {
      resolve({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (session: Session): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(session);
    };

    const timer = setTimeout(
      () => finish({ error: stderr.slice(0, 600) || 'Сервер не ответил вовремя' }),
      timeoutMs,
    );

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => finish({ error: error.message }));
    child.on('exit', (code) => {
      if (code !== 0)
        finish({ error: stderr.slice(0, 600) || `Процесс завершился с кодом ${code}` });
    });

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1 && message.result) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          request(send);
        } else if (message.id === 2) {
          finish(
            message.error
              ? { error: message.error.message ?? 'Инструмент вернул ошибку' }
              : { result: message.result },
          );
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'claude-control-sandbox', version: '0.1.0' },
      },
    });
  });
}
