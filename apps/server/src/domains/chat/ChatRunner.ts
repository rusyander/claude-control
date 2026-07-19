import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';

/**
 * Запуск Claude Code для чата и разбор потока событий.
 *
 * CLI умеет отдавать ответ по мере генерации (`--output-format stream-json
 * --include-partial-messages`), поэтому чат показывает текст так же, как
 * настоящий Claude Code, а не ждёт ответ целиком. Каждый запуск живёт в своей
 * рабочей папке: всё, что Claude создаст, окажется там и станет артефактом
 * этого чата, не задев остальные файлы.
 */

const isWindows = process.platform === 'win32';

/** Событие для интерфейса — уже разобранное, без служебного шума CLI. */
export type ChatEvent =
  | { kind: 'session'; sessionId: string; model: string; tools: number }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown; id: string }
  | { kind: 'toolResult'; id: string; isError: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string };

export interface RunOptions {
  prompt: string;
  /** Продолжение существующей сессии. */
  sessionId?: string;
  /** Рабочая папка: артефакты Claude окажутся здесь. */
  cwd: string;
  /** Имя чата — CLI сохранит его в транскрипт, и список чатов его покажет. */
  name?: string;
  model?: string;
  /**
   * Ветвление вместо продолжения: нужно, когда пользователь правит своё
   * сообщение — исходная ветка диалога при этом остаётся нетронутой.
   */
  fork?: boolean;
  /**
   * Каталог конфигурации Claude Code. Обычный чат работает с настоящим, а
   * песочница подсовывает временный — так тестируемое правило или хук
   * действует, а всё остальное из реальной конфигурации не подключается.
   */
  configDir?: string;
}

export class ChatRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private isStopped = false;

  /** Запускает CLI и вызывает onEvent по мере поступления событий. */
  async start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    mkdirSync(options.cwd, { recursive: true });

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Чат сам по себе безобиден, но Claude в нём пишет файлы артефактов.
      // acceptEdits разрешает правки в рабочей папке, не отдавая ему команды.
      '--permission-mode',
      'acceptEdits',
    ];

    if (options.sessionId) args.push('--resume', options.sessionId);
    if (options.fork) args.push('--fork-session');
    if (options.name) args.push('--name', options.name);
    if (options.model) args.push('--model', options.model);

    this.child = spawn(isWindows ? 'claude.cmd' : 'claude', args, {
      cwd: options.cwd,
      shell: isWindows,
      windowsHide: true,
      env: options.configDir
        ? { ...process.env, CLAUDE_CONFIG_DIR: options.configDir }
        : process.env,
    });

    // Длинный промпт нельзя передавать аргументом: оболочка Windows его рвёт.
    this.child.stdin.write(options.prompt);
    this.child.stdin.end();

    const stderr: string[] = [];
    this.child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    const lines = createInterface({ input: this.child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = translate(JSON.parse(line) as RawEvent);
        if (event) onEvent(event);
      } catch {
        // Строка не JSON — предупреждение CLI, для чата это шум.
      }
    }

    const code = await new Promise<number>((resolve) => {
      this.child?.on('close', (exitCode) => resolve(exitCode ?? 0));
    });

    if (code !== 0 && !this.isStopped) {
      onEvent({
        kind: 'error',
        message: stderr.join('').trim() || `claude завершился с кодом ${code}`,
      });
    }
  }

  /** Прерывание по кнопке «Остановить». */
  stop(): void {
    this.isStopped = true;
    this.child?.kill();
  }
}

interface RawEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: unknown[];
  message?: {
    content?: { type: string; text?: string; name?: string; input?: unknown; id?: string }[];
  };
  event?: {
    type: string;
    delta?: { type: string; text?: string; thinking?: string };
  };
  rate_limit_info?: { resetsAt?: number; rateLimitType?: string; status?: string };
  total_cost_usd?: number;
  duration_ms?: number;
  is_error?: boolean;
  result?: string;
  hook_name?: string;
}

/**
 * Перевод событий CLI в события интерфейса. Текст берём из потоковых дельт,
 * а не из готового сообщения: иначе ответ появится целиком в конце, и вся
 * ценность стриминга пропадёт.
 */
function translate(raw: RawEvent): ChatEvent | undefined {
  if (raw.type === 'system' && raw.subtype === 'init') {
    return {
      kind: 'session',
      sessionId: raw.session_id ?? '',
      model: raw.model ?? '',
      tools: raw.tools?.length ?? 0,
    };
  }

  if (raw.type === 'stream_event' && raw.event?.type === 'content_block_delta') {
    const delta = raw.event.delta;
    if (delta?.type === 'text_delta' && delta.text) return { kind: 'text', text: delta.text };
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return { kind: 'thinking', text: delta.thinking };
    }
    return undefined;
  }

  // Готовое сообщение нужно только ради вызовов инструментов: их в дельтах нет.
  if (raw.type === 'assistant') {
    const toolUse = raw.message?.content?.find((block) => block.type === 'tool_use');
    if (toolUse) {
      return { kind: 'tool', name: toolUse.name ?? '', input: toolUse.input, id: toolUse.id ?? '' };
    }
    return undefined;
  }

  if (raw.type === 'rate_limit_event' && raw.rate_limit_info) {
    return {
      kind: 'limit',
      resetsAt: raw.rate_limit_info.resetsAt ?? 0,
      type: raw.rate_limit_info.rateLimitType ?? '',
      status: raw.rate_limit_info.status ?? '',
    };
  }

  if (raw.type === 'result') {
    if (raw.is_error) return { kind: 'error', message: raw.result ?? 'Запрос не выполнен' };
    return {
      kind: 'done',
      costUsd: raw.total_cost_usd ?? 0,
      durationMs: raw.duration_ms ?? 0,
      sessionId: raw.session_id ?? '',
    };
  }

  return undefined;
}
