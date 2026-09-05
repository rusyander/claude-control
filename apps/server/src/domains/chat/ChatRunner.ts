import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatEvent, RawEvent } from './chat-events.ts';
import { safeSessionId, safeName, safeModel, safeEffort, shellArgs } from '../../lib/cli-args.ts';
import { killChildTree } from '../../lib/process-tree.ts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { TurnTracker } from './stream-usage.ts';

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

export type { ChatEvent, RawEvent, RawUsage } from './chat-events.ts';


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
   * `tokenFile` — ПУТЬ к ключу доступа: при включённом удалённом доступе гейт
   * требует ключ и от собственного MCP-сервера (по HTTP тот — такой же клиент,
   * как телефон), а без ключа каждый запрос прав получал 401 и превращался в
   * отказ. Именно путь, а не значение: файл читается на каждый запрос, поэтому
   * смена ключа посреди прогона не ломает права до конца работы, а на машине,
   * где удалённый доступ не включали, ключ и не заводится.
   */
  permissionPrompt?: { runId: string; baseUrl: string; tokenFile?: string };
  /**
   * Дописка к системному промпту: правда про вопрос человеку, разделение задач
   * по чатам и продолжение в чистой сессии — тем составом, который включён.
   *
   * ОДНА СТРОКА, без переводов строки: на Windows аргументы уезжают через
   * оболочку, а перевод строки внутри аргумента cmd.exe разрывает командную
   * строку — остаток инструкции выполнился бы как отдельная команда.
   *
   * Кавычки внутри одной строки та же оболочка тоже не переживает, поэтому на
   * Windows значение уходит ФАЙЛОМ (`--append-system-prompt-file`) — разбор
   * этого случая в `run()`.
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
  /**
   * Временная папка прогона: конфиг MCP для брокера прав и дописка к системному
   * промпту. Одна на прогон, потому что убирать её надо одинаково и в один
   * момент — при любом исходе.
   */
  private tempDir: string | undefined;

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
    if (appended) {
      if (isWindows) {
        // ФАЙЛОМ, а не аргументом, и это не перестраховка. Замерено 2 сентября
        // 2026 на claude 2.1.177 настоящим запуском: в тексте инициатив есть
        // примеры JSON (`{"done":"что закрыто","next":"чем продолжить"}`), а
        // цепочка `cmd.exe` → `claude.cmd` → `claude.exe` разбирает кавычки
        // по-разному. Удвоение кавычек, которое понимает cmd.exe, до `claude.exe`
        // доезжает уже развалившимся: системная строка обрезалась на первом
        // пробеле после кавычки, а её ОБЛОМОК становился позиционным аргументом,
        // то есть промптом. В транскрипте это выглядело так:
        // `"контекст\nВот три независимые задачи…"` — человек отправлял одно, а
        // агент получал другое, и так на КАЖДОМ сообщении.
        //
        // Путь через файл кавычек в командной строке не создаёт вовсе. Проверено
        // тем же запуском: системная строка действует, промпт доезжает дословно.
        const file = join(this.ensureTempDir(), 'append-system-prompt.txt');
        writeFileSync(file, appended, 'utf8');
        args.push('--append-system-prompt-file', file);
      } else {
        args.push('--append-system-prompt', appended);
      }
    }

    // Интерактивные права: добавляем свой MCP-сервер и указываем его инструмент
    // как обработчик запросов на разрешение. Конфиг сливается с настоящим (без
    // --strict-mcp-config), поэтому пользовательские MCP-серверы остаются. При
    // полном доступе не подключаем — там подтверждать нечего.
    //
    // ВОПРОС ЧЕЛОВЕКУ ЧЕРЕЗ ЭТОТ КАНАЛ НЕ ОТВЕЧАЕТСЯ. Живьём (claude 2.1.177,
    // 05.09.2026) `AskUserQuestion` до брокера доходит — и прогон стоит, пока
    // брокер не ответит; а «разрешить» ему нечего: в `-p` спросить не у кого,
    // вызов вернётся ошибкой `Answer questions?`. Поэтому брокер отклоняет его
    // сам и сразу (`QUESTION_DENIED`), а ответ человека едет следующим
    // сообщением — весь путь живёт на стороне панели (см. `QUESTION_PROMPT`).
    if (options.permissionPrompt && options.permissionMode !== 'bypassPermissions') {
      const mcpConfigPath = join(this.ensureTempDir(), 'mcp.json');
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
                ...(options.permissionPrompt.tokenFile
                  ? { PERM_TOKEN_FILE: options.permissionPrompt.tokenFile }
                  : {}),
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

    // Расход хода и границы блоков — у трекера: по одной строке их не разобрать,
    // правда размазана по нескольким (см. stream-usage.ts). С потоковыми
    // событиями расход хода приходит ПОСЛЕ его вызовов (message_delta замыкает
    // ход), без них — до; интерфейсу порядок не важен, он сводит их по id.
    const tracker = new TurnTracker();
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      if (!line.trim()) continue;

      try {
        const raw = JSON.parse(line) as RawEvent;
        for (const event of tracker.track(raw)) onEvent(event);
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
  /** Папка прогона по требованию: заводится один раз, убирается вместе с прогоном. */
  private ensureTempDir(): string {
    this.tempDir ??= mkdtempSync(join(tmpdir(), 'cc-perm-'));
    return this.tempDir;
  }

  private cleanup(): void {
    if (!this.tempDir) return;
    try {
      rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // Временную папку подчистит и сама ОС — не критично.
    }
    this.tempDir = undefined;
  }
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
