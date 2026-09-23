import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatEvent, RawEvent } from './chat-events.ts';
import { safeSessionId, safeName, safeModel, safeEffort, shellArgs } from '../../lib/cli-args.ts';
import { killChildTree } from '../../lib/process-tree.ts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { TurnTracker } from './stream-usage.ts';
import { userMemorySettings } from '../platform/layers.ts';
import { LiveSession, type LiveSessionPool, type TurnOutcome } from './live-session.ts';
import { CHILD_DENIED_TOOLS, CHILD_PROMPT } from './initiative.ts';

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
   * Адрес шлюза контура для ЭТОГО прогона (Т3) — то, чем «чат через контур,
   * тесты своим ключом» отличается от одной записи в общем конфиге CLI.
   *
   * Заполняет реестр прогонов на КАЖДОМ старте, руками задавать нечего:
   * решение зависит от активного контура и отмеченных потребителей, а они
   * меняются между прогонами. Отдельным полем от `env` именно поэтому —
   * значение, оставшееся в параметрах остановленного прогона, не должно
   * пережить снятую галочку при продолжении.
   */
  platformEnv?: Record<string, string>;
  /**
   * Системный промпт контура ВМЕСТО промпта CLI (Т5.4а). Пустая строка —
   * «работать обычным промптом»: реестр обязан уметь снять его так же, как
   * ставит, иначе продолжение прогона переживало бы выключенную галочку.
   *
   * Уходит ФАЙЛОМ (`--system-prompt-file`), и не только на Windows: текст
   * многострочный, с примерами JSON внутри, и в командной строке ему делать
   * нечего ни на одной системе.
   */
  platformSystemPrompt?: string;
  /**
   * Флаги снятия НАШИХ слоёв для прогона через контур (Т8): `--setting-sources`,
   * `--disable-slash-commands`, `--strict-mcp-config`.
   *
   * Отдельным полем от общих аргументов, и по той же причине, что у
   * `platformEnv`: состав решается на каждом старте, и флаг, оставшийся в
   * параметрах остановленного прогона, пережил бы возвращённую галочку. Значения
   * сюда кладёт домен контура, из запроса они не приходят ни в каком виде.
   */
  platformArgs?: string[];
  /**
   * Снята ли НАША дописка к системному промпту слоем `systemPrompt` (Т8).
   *
   * Именно отдельным флагом, а не затиранием `appendSystemPrompt` пустой строкой:
   * дописку собирает маршрут чата, а снятый слой — состояние контура, и затёртый
   * текст уже не вернуть. Прогон, поставленный на паузу со снятым слоем и
   * продолженный после того, как галочку вернули, уходил БЕЗ инициатив,
   * разделения и продолжения сессии — в сохранённых параметрах лежала пустая
   * строка, а восстановить её было неоткуда (ревью Т8, MAJOR-4). Флаг реестр
   * ставит на КАЖДОМ старте, поэтому прошлая жизнь прогона его не переживает.
   */
  platformDropAppend?: boolean;
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
  /**
   * Ход, начатый самим CLI живой сессии (см. `live-session.ts`): прогон не
   * отправляет сообщения, а забирает уже идущий ход — фоновая задача агента
   * кончилась, и CLI продолжил работу сам.
   */
  wake?: boolean;
  /**
   * Прогон ребёнка разделения: закрыты инструменты обмена с другими сессиями и
   * дописаны правила ребёнка (`CHILD_PROMPT`). Решает реестр на КАЖДОМ старте
   * по связи разговора — продолжение после паузы дерева несёт прежние
   * параметры, и прошлое решение пережило бы переезд связи.
   */
  child?: boolean;
}

/** Сборка запуска CLI: общая у разового прогона и живой сессии. */
interface Launch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runIdFile?: string;
}

export class ChatRun {
  private child: ChildProcessWithoutNullStreams | undefined;
  /**
   * Живые сессии разговоров. Есть — ход уходит в процесс, который переживает
   * конец хода вместе с фоновыми командами агента; нет (песочница) — разовый
   * `claude -p`, как прежде.
   */
  private readonly pool: LiveSessionPool | undefined;
  private session: LiveSession | undefined;

  constructor(pool?: LiveSessionPool) {
    this.pool = pool;
  }
  private isStopped = false;
  /**
   * Временная папка прогона: конфиг MCP для брокера прав и дописка к системному
   * промпту. Одна на прогон, потому что убирать её надо одинаково и в один
   * момент — при любом исходе.
   */
  private tempDir: string | undefined;

  /**
   * PID запущенного процесса — известен сразу после `start()`: `spawn` идёт до
   * первого `await`. Реестр пишет его в журнал на диске, чтобы после перезапуска
   * панели усыновить живой процесс. На Windows это pid оболочки `cmd.exe`,
   * которая ждёт CLI, — по нему валится дерево при остановке; в журнал же
   * реестр пишет найденный под ней pid самого CLI (`resolveCliPid`): оболочку
   * перезапуск сервера убивает, а CLI живёт дальше.
   */
  get pid(): number | undefined {
    return this.session?.pid ?? this.child?.pid;
  }

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
    if (this.pool) return this.runLive(options, onEvent, this.pool);
    const { command, args, env } = this.prepare(options, onEvent, false);
    return this.runOnce(options, onEvent, command, args, env);
  }

  private prepare(options: RunOptions, onEvent: (event: ChatEvent) => void, live: boolean): Launch {
    const args = [
      '-p',
      // Живая сессия ждёт сообщения строками JSON в stdin и не выходит после хода.
      ...(live ? ['--input-format', 'stream-json'] : []),
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
    // Имя, не прошедшее грамматику, до CLI не доедет — и до этой строки уезжало
    // МОЛЧА: шапка показывала одну модель, прогон шёл той, которую CLI выбрал
    // сам, и узнать об этом было неоткуда. Грамматика намеренно уже, чем «похоже
    // на имя модели» (оболочка Windows считает командой `& | < > ^ " % ( ) ; , !`
    // и пробел), так что отбрасывать такое имя правильно, а молчать о нём — нет.
    this.modelNotice(options, onEvent);
    if (effort) args.push('--effort', effort);
    if (options.child) args.push('--disallowedTools', CHILD_DENIED_TOOLS.join(','));

    // Свой промпт контура — ВМЕСТО промпта CLI, и только файлом: текст
    // многострочный и с примерами JSON, а разбор кавычек в командной строке
    // (cmd.exe → claude.cmd → claude.exe) ломает такой аргумент молча.
    const contourPrompt = options.platformSystemPrompt?.trim();
    if (contourPrompt) {
      const file = join(this.ensureTempDir(), 'contour-system-prompt.txt');
      writeFileSync(file, contourPrompt, 'utf8');
      args.push('--system-prompt-file', file);
    }

    // Переводы строки вырезаем здесь, а не полагаемся на дисциплину вызывающего:
    // на Windows такой аргумент разорвал бы командную строку (см. RunOptions).
    // Слой Т8 снимает дописку ЗДЕСЬ, а не затиранием текста в параметрах:
    // сохранённый снимок прогона переживает паузу дерева и перезапуск панели, и
    // затёртую строку было бы неоткуда вернуть, когда галочку включат обратно.
    const appended = options.platformDropAppend
      ? ''
      : [options.appendSystemPrompt, options.child ? CHILD_PROMPT : '']
          .filter(Boolean)
          .join(' ')
          .replace(/[\r\n]+/g, ' ')
          .trim();
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

    // Наши слои, снятые с прогона через контур (Т8). Стоят перед флагами брокера
    // прав для читаемости, и только: ПОРЯДОК тут ничего не решает — настоящий
    // CLI оставляет сервер, приехавший своим `--mcp-config`, в любом порядке
    // (проверено обоими, `tools/qa/check-run-layers.mjs`; прежнее «переставь — и
    // права умрут» было неверно, ревью Т8). Решает другое: брокер обязан ехать
    // своим `--mcp-config`, иначе `--strict-mcp-config` унёс бы и его, а каждый
    // запрос прав стал бы молчаливым отказом посреди работы.
    if (options.platformArgs?.length) args.push(...options.platformArgs);

    const env = {
      ...process.env,
      ...(options.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : {}),
      ...options.env,
      // Маршрут контура — ПОСЛЕДНИМ и отдельно от `env`: он пересобирается на
      // каждом старте (реестр прогонов), и значение прошлой жизни разговора не
      // должно пережить снятую галочку.
      ...options.platformEnv,
    };

    // Снятые личные настройки обязаны снять и `~/.claude/CLAUDE.md`, который CLI
    // находит поиском вверх у проекта под домом и читает как проектный
    // (`userMemorySettings`). Дом и каталог конфигурации — из окружения САМОГО
    // процесса: CLI берёт их оттуда же, и другой ответ исключил бы не тот файл.
    const memory = userMemorySettings(options.platformArgs ?? [], {
      cwd: options.cwd,
      env,
      platform: process.platform,
      fallbackHome: homedir(),
    });
    if (memory) {
      const file = join(this.ensureTempDir(), 'layers-settings.json');
      writeFileSync(file, memory, 'utf8');
      args.push('--settings', file);
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
    let runIdFile: string | undefined;
    if (options.permissionPrompt && options.permissionMode !== 'bypassPermissions') {
      const mcpConfigPath = join(this.ensureTempDir(), 'mcp.json');
      // Живая сессия переживает ходы, а ключ прогона у каждого хода свой: брокер
      // читает его из файла, который сессия переписывает перед ходом.
      if (live) {
        runIdFile = join(this.ensureTempDir(), 'run-id.txt');
        writeFileSync(runIdFile, options.permissionPrompt.runId, 'utf8');
      }
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
                ...(runIdFile ? { PERM_RUN_ID_FILE: runIdFile } : {}),
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
    return { command, args: shellArgs(args), env, ...(runIdFile ? { runIdFile } : {}) };
  }

  /**
   * Ход в живой сессии разговора. Свободный процесс с теми же параметрами —
   * сообщение уходит в него; нет такого — поднимается новый (`--resume`, если
   * разговор уже есть), и после хода остаётся ждать следующего.
   */
  private async runLive(
    options: RunOptions,
    onEvent: (event: ChatEvent) => void,
    pool: LiveSessionPool,
  ): Promise<void> {
    const sessionId = safeSessionId(options.sessionId);
    const runId = options.permissionPrompt?.runId;
    const tracker = new TurnTracker();
    let streamError = false;
    const onRaw = (raw: RawEvent): void => {
      for (const event of tracker.track(raw)) onEvent(event);
      for (const event of translate(raw)) {
        if (event.kind === 'error') streamError = true;
        onEvent(event);
      }
    };

    if (options.wake) {
      const session = pool.waking(sessionId);
      const claimed = session?.claimWake(runId, onRaw);
      if (!session || !claimed) return;
      this.session = session;
      const outcome = await claimed;
      this.settleLive(outcome, pool, session, onEvent, streamError, options.command);
      return;
    }

    // Ход, начатый CLI, которого реестр не принял, — не повод поднимать второй
    // процесс на тот же транскрипт: этот прогон сначала показывает его, потом
    // отправляет сообщение человека.
    const unclaimed = options.fork ? undefined : pool.waking(sessionId);
    if (unclaimed?.alive && unclaimed.pendingWake) {
      const claimed = unclaimed.claimWake(runId, onRaw);
      if (claimed) {
        this.session = unclaimed;
        await claimed;
        if (this.isStopped) return;
      }
    }

    const launch = options.fork ? undefined : this.prepareSignature(options);
    let session = launch ? pool.take(sessionId, launch) : undefined;
    if (!session) {
      const { command, args, env, runIdFile } = this.prepare(options, onEvent, true);
      session = new LiveSession({
        command,
        args,
        cwd: options.cwd,
        env,
        shell: isWindows,
        signature: launch ?? `fork:${Date.now()}`,
        ...(this.tempDir ? { tempDir: this.tempDir } : {}),
        ...(runIdFile ? { runIdFile } : {}),
      });
      // Папка прогона теперь принадлежит процессу: уберёт её сессия, когда он закроется.
      this.tempDir = undefined;
    } else {
      // Тот же отказ, что в `prepare`, — без нового процесса его некому сказать.
      this.modelNotice(options, onEvent);
    }
    this.session = session;
    const outcome = await session.turn(options.prompt, runId, onRaw);
    this.settleLive(outcome, pool, session, onEvent, streamError, options.command);
  }

  /** Имя модели, не прошедшее грамматику, до CLI не доезжает — и молчать об этом нельзя. */
  private modelNotice(options: RunOptions, onEvent: (event: ChatEvent) => void): void {
    if (options.model && !safeModel(options.model)) {
      onEvent({
        kind: 'notice',
        code: 'modelDropped',
        text: `Имя модели «${options.model.slice(0, 80)}» не прошло проверку аргументов командной строки и до CLI не доехало: прогон идёт моделью, которую CLI выбрал сам. Имя из каталога контура обычно проходит — здесь в нём знак, который оболочка Windows приняла бы за команду.`,
      });
    }
  }

  /** Конец хода живой сессии: процесс жив — в пул, умер — причина в ленту. */
  private settleLive(
    outcome: TurnOutcome,
    pool: LiveSessionPool,
    session: LiveSession,
    onEvent: (event: ChatEvent) => void,
    streamError: boolean,
    command: string | undefined,
  ): void {
    if (this.isStopped) return;
    if (!outcome.closed) {
      pool.keep(session);
      return;
    }
    pool.forget(session);
    const failure = exitFailure(command ?? defaultCliCommand(), outcome, streamError);
    if (failure) onEvent(failure);
  }

  /**
   * Подпись запуска: всё, что уходит в командную строку и окружение, кроме
   * сообщения, имени чата и ключа прогона. Совпала — ход можно отдать живому
   * процессу; нет — нужен новый (модель, права, дописка к промпту иначе не
   * меняются).
   */
  private prepareSignature(options: RunOptions): string {
    return JSON.stringify({
      command: options.command ?? defaultCliCommand(),
      cwd: options.cwd,
      model: safeModel(options.model) ?? '',
      effort: safeEffort(options.effort) ?? '',
      permissionMode: options.permissionMode ?? 'acceptEdits',
      configDir: options.configDir ?? '',
      env: options.env ?? {},
      platformEnv: options.platformEnv ?? {},
      platformSystemPrompt: options.platformSystemPrompt?.trim() ?? '',
      platformArgs: options.platformArgs ?? [],
      append: options.platformDropAppend
        ? ''
        : (options.appendSystemPrompt?.replace(/[\r\n]+/g, ' ').trim() ?? ''),
      child: Boolean(options.child),
      broker: options.permissionPrompt
        ? [options.permissionPrompt.baseUrl, options.permissionPrompt.tokenFile ?? '']
        : [],
    });
  }

  private async runOnce(
    options: RunOptions,
    onEvent: (event: ChatEvent) => void,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: isWindows,
      windowsHide: true,
      env,
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
    // Причину провала CLI уже назвал потоком (`result` с `is_error`): «API Error:
    // 400 Проверки контента контура остановили ответ…». Код выхода при этом тоже
    // ненулевой, а в stderr лежит только служебная строка CLI
    // (`[claude-code:unrecognized_model]` у модели не из каталога Anthropic) —
    // вторая ошибка затирала первую, и человек видел её вместо причины (живой
    // прогон dev 14.09.2026).
    let streamError = false;
    for await (const line of lines) {
      if (!line.trim()) continue;

      try {
        const raw = JSON.parse(line) as RawEvent;
        for (const event of tracker.track(raw)) onEvent(event);
        for (const event of translate(raw)) {
          if (event.kind === 'error') streamError = true;
          onEvent(event);
        }
      } catch {
        // Строка не JSON — предупреждение CLI, для чата это шум.
      }
    }

    const code = await closed;

    if (this.isStopped) return;
    const failure = exitFailure(
      command,
      { spawnError, code, stderr: stderr.join('').trim() },
      streamError,
    );
    if (failure) onEvent(failure);
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
    // Живую сессию — тоже деревом и из пула вон: «Остановить» гасит и фоновые
    // команды агента, как гасил их разовый процесс.
    if (this.session) {
      this.pool?.forget(this.session);
      this.session.kill();
    }
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
 * Ошибка закрывшегося CLI для ленты — общая у разового прогона и живой сессии.
 *
 * Сбой запуска молчать не может: несуществующий CLI закрывает потоки мгновенно,
 * и без этой ветки прогон выглядел бы как удачный, но пустой ответ. Причину,
 * которую CLI уже назвал потоком (`result` с `is_error`), ненулевой код не
 * затирает.
 */
function exitFailure(
  command: string,
  exit: { spawnError?: Error | undefined; code?: number | undefined; stderr: string },
  streamError: boolean,
): ChatEvent | undefined {
  if (exit.spawnError) {
    return {
      kind: 'error',
      message: `Не удалось запустить «${command}»: ${exit.spawnError.message}`,
    };
  }
  if (exit.code === 0 || streamError) return undefined;
  return {
    kind: 'error',
    message: exit.stderr || `claude завершился с кодом ${exit.code ?? '?'}`,
  };
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
