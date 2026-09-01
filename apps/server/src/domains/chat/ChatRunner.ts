import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HandoffRefusal } from '@claude-control/contracts/chat-handoff';
import { safeSessionId, safeName, safeModel, safeEffort, shellArgs } from '../../lib/cli-args.ts';
import { killChildTree } from '../../lib/process-tree.ts';
import { defaultCliCommand } from '../../providers/cli.ts';

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
  /**
   * Расход одного шага модели. `toolIds` — вызовы, рождённые ЭТИМ шагом: по ним
   * интерфейс ставит цифру у конкретного действия. Вызовов бывает несколько
   * (модель зовёт инструменты параллельно одним сообщением) — тогда расход у них
   * общий, и делить его между ними нельзя: раздельного счёта модель не даёт.
   */
  | {
      kind: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
      cacheCreation1h?: number;
      model?: string;
      /** Пусто — шаг закончился одним текстом, привязывать расход не к чему. */
      toolIds?: string[];
      /** Оценка стоимости шага; проставляет реестр — тарифы знает только он. */
      costUsd?: number;
    }
  | { kind: 'done'; costUsd: number; durationMs: number; sessionId: string }
  | { kind: 'error'; message: string }
  // Интерактивные права: агент хочет применить инструмент — ждём решения человека.
  | { kind: 'permission'; toolName: string; input: unknown; toolUseId: string }
  | { kind: 'permissionResolved'; toolUseId: string; behavior: 'allow' | 'deny' }
  /**
   * Работа продолжена в чистой сессии (или не продолжена — тогда есть `reason`).
   * Событие уходит в поток ЗАКРЫВАЕМОГО прогона последним: по нему вкладка
   * переключается на новый разговор, а не остаётся смотреть на завершённый.
   */
  | {
      kind: 'handoff';
      chatId?: string;
      path?: string;
      chainDepth?: number;
      reason?: HandoffRefusal;
    };

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
  /**
   * Дописка к системному промпту (`--append-system-prompt`). Сюда уходит строка
   * про разделение задач по чатам, и только она.
   *
   * ОДНА СТРОКА, без переводов строки: на Windows аргументы уезжают через
   * оболочку, а перевод строки внутри аргумента cmd.exe разрывает командную
   * строку — остаток инструкции выполнился бы как отдельная команда.
   */
  appendSystemPrompt?: string;
  /**
   * Команда запуска CLI активного провайдера. Задаётся маршрутом чата через
   * реестр провайдеров; по умолчанию — команда провайдера Claude. Имя больше не
   * хардкодится здесь, но значение то же (claude / claude.cmd).
   */
  command?: string;
}

export class ChatRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  private isStopped = false;
  private mcpConfigDir: string | undefined;

  /** Запускает CLI и вызывает onEvent по мере поступления событий. */
  async start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    try {
      await this.run(options, onEvent);
    } finally {
      // Временная папка с mcp.json должна исчезать при ЛЮБОМ исходе. Раньше
      // уборка стояла только в конце удачного пути, и каждый сорвавшийся
      // запуск (отказ записи в stdin, обрыв потока) оставлял в %TEMP% папку
      // cc-perm-* с id прогона и адресом панели внутри — их копило до чистки ОС.
      this.cleanup();
    }
  }

  private async run(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
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

    // Переводы строки вырезаем здесь, а не полагаемся на дисциплину вызывающего:
    // на Windows такой аргумент разорвал бы командную строку (см. RunOptions).
    const appended = options.appendSystemPrompt?.replace(/[\r\n]+/g, ' ').trim();
    if (appended) args.push('--append-system-prompt', appended);

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
    const command = options.command ?? defaultCliCommand();
    const child = spawn(command, shellArgs(args), {
      cwd: options.cwd,
      shell: isWindows,
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
        ...options.env,
      },
    });
    this.child = child;

    // Сбой запуска (пользователь выбрал провайдера, чей CLI не установлен →
    // ENOENT) приходит СОБЫТИЕМ на процессе, а не исключением из spawn: без
    // слушателя необработанное `error` уносит весь сервер, а не один чат.
    // Вешаем сразу, до первого await, иначе событие успевает уйти в пустоту, и
    // прогон повисает в «идёт» навсегда.
    let spawnError: Error | undefined;
    const closed = new Promise<number>((resolve) => {
      child.on('error', (error: Error) => {
        spawnError = error;
        resolve(-1);
      });
      child.on('close', (exitCode) => resolve(exitCode ?? 0));
    });

    // Тот же капкан у stdin: CLI мог закрыться раньше, чем допишется промпт, —
    // поток отдаёт EPIPE (на Windows EOF) отдельным `error`, и снова падает
    // сервер. Для чата это всего лишь «не успели дописать ввод».
    child.stdin.on('error', () => undefined);

    // Длинный промпт нельзя передавать аргументом: оболочка Windows его рвёт.
    child.stdin.write(options.prompt);
    child.stdin.end();

    const stderr: string[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));

    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;

      try {
        const raw = JSON.parse(line) as RawEvent;

        // Токены расхода приходят в usage сообщений ассистента — отдаём их
        // отдельным событием, чтобы показать расход в токенах, а не только в деньгах.
        //
        // Вместе с расходом отдаём и вызовы этого же сообщения: без них цифра
        // осталась бы «расходом за прогон вообще», и понять, во что обошёлся
        // конкретный Bash, было бы нельзя. Событие идёт ПЕРЕД самими вызовами —
        // порядок не важен, интерфейс сводит их по id.
        const usage = raw.message?.usage;
        if (usage) {
          const long = usage.cache_creation?.ephemeral_1h_input_tokens;
          onEvent({
            kind: 'usage',
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0,
            cacheCreation1h: long || undefined,
            model: raw.message?.model,
            toolIds: (raw.message?.content ?? [])
              .filter((block) => block.type === 'tool_use' && block.id)
              .map((block) => block.id ?? ''),
          });
        }

        for (const event of translate(raw)) onEvent(event);
      } catch {
        // Строка не JSON — предупреждение CLI, для чата это шум.
      }
    }

    const code = await closed;

    if (!this.isStopped) {
      if (spawnError) {
        // Молчать нельзя: несуществующий CLI закрывает потоки мгновенно, и без
        // этой ветки прогон выглядел бы как удачный, но пустой ответ.
        onEvent({
          kind: 'error',
          message: `Не удалось запустить «${command}»: ${spawnError.message}`,
        });
      } else if (code !== 0) {
        onEvent({
          kind: 'error',
          message: stderr.join('').trim() || `claude завершился с кодом ${code}`,
        });
      }
    }
  }

  /**
   * Прерывание по кнопке «Остановить».
   *
   * Валим ДЕРЕВО: на Windows `claude` живёт под `cmd.exe`, и обычный `kill`
   * снял бы только оболочку — прогон бы продолжался, тратя токены, при
   * «остановленном» статусе в панели.
   */
  stop(): void {
    this.isStopped = true;
    if (this.child) killChildTree(this.child);
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
    /** Модель ЭТОГО шага: в разговоре они чередуются (переключение, субагенты). */
    model?: string;
    content?: { type: string; text?: string; name?: string; input?: unknown; id?: string }[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      /** Разбивка записи в кэш по сроку жизни: часовая стоит вдвое дороже. */
      cache_creation?: { ephemeral_1h_input_tokens?: number };
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
