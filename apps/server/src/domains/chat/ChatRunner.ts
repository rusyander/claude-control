import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeSessionId, safeName, safeModel, safeEffort, shellArgs } from '../../lib/cli-args.ts';

/** Путь к мини-MCP-серверу прав рядом с этим модулем. */
const PERMISSION_SERVER = fileURLToPath(new URL('./permission-prompt-server.mjs', import.meta.url));

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
  | { kind: 'limit'; resetsAt: number; type: string; status: string }
  | { kind: 'usage'; input: number; output: number; cacheRead: number; cacheCreation: number }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string }
  // Интерактивные права: агент хочет применить инструмент — ждём решения человека.
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' };

export interface RunOptions {
  prompt: string;
  /** Продолжение существующей сессии. */
  sessionId?: string;
  /** Рабочая папка: артефакты Claude окажутся здесь. */
  cwd: string;
  /** Имя чата — CLI сохранит его в транскрипт, и список чатов его покажет. */
  name?: string;
  /** Модель: алиас (opus/sonnet/haiku/fable) или полное имя; пусто = по умолчанию. */
  model?: string;
  /** Глубина продумывания (--effort): low/medium/high/xhigh/max; пусто = по умолчанию. */
  effort?: string;
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
  /**
   * Дополнительные переменные окружения. Нужны песочнице: доступ к аккаунту
   * может быть не файлом, а ключом API — его передают именно так.
   */
  env?: Record<string, string>;
  /**
   * Права на действия с файлами. В песочнице — acceptEdits: там файлы Claude
   * и есть результат. В настоящем проекте по умолчанию `default`: чтение
   * работает, а правки без подтверждения не проходят, и панель ничего в
   * рабочем коде молча не меняет.
   */
  permissionMode?: string;
  /**
   * Интерактивные права: когда задано, к агенту подключается мини-MCP-сервер, и
   * каждый запрос на разрешение инструмента (вне авторазрешённого режимом)
   * уходит человеку кнопкой в чате. `runId` связывает запрос с разговором,
   * `baseUrl` — адрес приложения, куда MCP-сервер стучится за решением. При
   * полном доступе (bypassPermissions) не нужно — там всё и так разрешено.
   */
  permissionPrompt?: { runId: string; baseUrl: string };
}

export class ChatRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private isStopped = false;
  private mcpConfigDir: string | undefined;

  /** Запускает CLI и вызывает onEvent по мере поступления событий. */
  async start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    mkdirSync(options.cwd, { recursive: true });

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      options.permissionMode ?? 'acceptEdits',
    ];

    // На Windows CLI запускается через оболочку (см. cli-args.ts), поэтому
    // всё, что пришло из запроса, проверяется до попадания в командную строку.
    const sessionId = safeSessionId(options.sessionId);
    const name = safeName(options.name);
    const model = safeModel(options.model);
    const effort = safeEffort(options.effort);

    if (sessionId) args.push('--resume', sessionId);
    if (options.fork) args.push('--fork-session');
    if (name) args.push('--name', name);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);

    // Интерактивные права: добавляем свой MCP-сервер и указываем его инструмент
    // как обработчик запросов на разрешение. Конфиг сливается с настоящим (без
    // --strict-mcp-config), поэтому пользовательские MCP-серверы остаются. При
    // полном доступе не подключаем — там подтверждать нечего.
    if (options.permissionPrompt && options.permissionMode !== 'bypassPermissions') {
      this.mcpConfigDir = mkdtempSync(join(tmpdir(), 'cc-perm-'));
      const mcpConfigPath = join(this.mcpConfigDir, 'mcp.json');
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({
          mcpServers: {
            'perm-guard': {
              command: process.execPath,
              args: [PERMISSION_SERVER],
              env: {
                PERM_RUN_ID: options.permissionPrompt.runId,
                PERM_BASE_URL: options.permissionPrompt.baseUrl,
              },
            },
          },
        }),
      );
      args.push(
        '--mcp-config',
        mcpConfigPath,
        '--permission-prompt-tool',
        'mcp__perm-guard__approve',
      );
    }

    // Имя чата — обычный текст с пробелами, а оболочка Windows разобрала бы
    // его как несколько аргументов, поэтому аргументы квотируются.
    this.child = spawn(isWindows ? 'claude.cmd' : 'claude', shellArgs(args), {
      cwd: options.cwd,
      shell: isWindows,
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
        ...options.env,
      },
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
        const raw = JSON.parse(line) as RawEvent;

        // Токены расхода приходят в usage сообщений ассистента — отдаём их
        // отдельным событием, чтобы показать расход в токенах, а не только в деньгах.
        const usage = raw.message?.usage;
        if (usage) {
          onEvent({
            kind: 'usage',
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
          });
        }

        for (const event of translate(raw)) onEvent(event);
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

    this.cleanup();
  }

  /** Прерывание по кнопке «Остановить». */
  stop(): void {
    this.isStopped = true;
    this.child?.kill();
    this.cleanup();
  }

  /** Убрать временный mcp-config сервера прав. */
  private cleanup(): void {
    if (!this.mcpConfigDir) return;
    try {
      rmSync(this.mcpConfigDir, { recursive: true, force: true });
    } catch {
      // Временную папку подчистит и сама ОС — не критично.
    }
    this.mcpConfigDir = undefined;
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
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
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
 *
 * Возвращает МАССИВ событий: одному сообщению ассистента может отвечать
 * несколько вызовов инструментов (модель зовёт их параллельно одним сообщением),
 * и каждый должен дойти до ленты. Пустой массив — событие для интерфейса ничего
 * не значит (шум CLI, дельта ввода инструмента).
 *
 * Экспортируется ради модульных тестов разбора потока (частичные события,
 * usage/done, ошибки/лимиты) — сам запуск CLI в тестах не поднять.
 */
export function translate(raw: RawEvent): ChatEvent[] {
  if (raw.type === 'system' && raw.subtype === 'init') {
    return [
      {
        kind: 'session',
        sessionId: raw.session_id ?? '',
        model: raw.model ?? '',
        tools: raw.tools?.length ?? 0,
      },
    ];
  }

  if (raw.type === 'stream_event' && raw.event?.type === 'content_block_delta') {
    const delta = raw.event.delta;
    if (delta?.type === 'text_delta' && delta.text) return [{ kind: 'text', text: delta.text }];
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      return [{ kind: 'thinking', text: delta.thinking }];
    }
    return [];
  }

  // Готовое сообщение нужно только ради вызовов инструментов: их в дельтах нет.
  // Перебираем ВСЕ tool_use-блоки: при параллельных вызовах их несколько, и если
  // взять только первый (как было), остальные потеряются — а среди них может
  // оказаться AskUserQuestion, без которого не зажжётся точка «агент ждёт ответа».
  if (raw.type === 'assistant') {
    return (raw.message?.content ?? [])
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        kind: 'tool',
        name: block.name ?? '',
        input: block.input,
        id: block.id ?? '',
      }));
  }

  if (raw.type === 'rate_limit_event' && raw.rate_limit_info) {
    return [
      {
        kind: 'limit',
        resetsAt: raw.rate_limit_info.resetsAt ?? 0,
        type: raw.rate_limit_info.rateLimitType ?? '',
        status: raw.rate_limit_info.status ?? '',
      },
    ];
  }

  if (raw.type === 'result') {
    if (raw.is_error) return [{ kind: 'error', message: raw.result ?? 'Запрос не выполнен' }];
    return [
      {
        kind: 'done',
        costUsd: raw.total_cost_usd ?? 0,
        durationMs: raw.duration_ms ?? 0,
        sessionId: raw.session_id ?? '',
      },
    ];
  }

  return [];
}
