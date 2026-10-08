import type { spawn as nodeSpawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AssistantRunReason,
  ModelInfo,
  ProviderChatMessage,
  ProviderChatTransport,
} from '@agentdeck/contracts';
import { spawnCliProcess } from '../../../lib/cli-spawn/cli-spawn.ts';
import { killChildTree } from '../../../lib/process-tree/process-tree.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import { withCodexKit } from '../../kit/codex.ts';
import type { ConfigProvider } from '../../../providers/types/types.ts';
import { providerCliCommand } from '../../../providers/cli/cli.ts';
import { resolveRunner, getRawKey } from '../../provider-keys/provider-keys.ts';
import { runProviderApi } from '../../assistant-runner/api.ts';
import { opencodeServe, type OpencodeServe } from '../../opencode-serve/opencode-serve.ts';
import type {
  SessionStartSource,
  SupervisorEventInput,
  SupervisorRun,
} from '../../portability/supervisor/payload.ts';
import { runSupervisorEvent, type SupervisorHook } from '../../portability/supervisor/run.ts';
import {
  planSkillTurn,
  type SkillCatalogEntry,
  type SkillBodySource,
} from '../../portability/supervisor/skills-router.ts';
import { buildPrompt } from '../prompt/prompt.ts';
import { createLiveTurn } from '../live/index.ts';
import type { LivePermissionPolicy, LiveTurn } from '../live/types.ts';

/** У прогона есть своё окружение (контур, набор, слой группы). */
const hasEnv = (env: Record<string, string> | undefined): boolean =>
  env !== undefined && Object.keys(env).length > 0;

/** Откуда прогон берёт каталог скиллов и тело названного (П3.4). */
export interface SkillTurnSource {
  readonly entries: readonly SkillCatalogEntry[];
  /** Бюджет каталога в символах — он же предел того, что уедет в argv. */
  readonly budgetChars: number;
  readonly readBody: (name: string) => SkillBodySource | undefined;
}

/**
 * Один ответ чужого провайдера.
 *
 * Три пути дают одну и ту же ленту событий, поэтому чат наверху про них не
 * знает:
 *  - `stream` — CLI запускается на один вопрос, и текст отдаётся по мере того,
 *    как CLI его печатает. Ничего чужого здесь не разбирается: показывается
 *    ровно то, что процесс вывел в stdout. Именно это и делает чат «живым» у
 *    всех восьми CLI сразу — задокументированного потокового ФОРМАТА нет ни у
 *    кого, а поток байтов есть у всех.
 *  - `session` — диалог держит локальный сервер CLI (сейчас только OpenCode).
 *    Ответ приходит целиком, зато контекст не пересылается заново.
 *  - `live` — CLI запущен в своём серверном режиме на один ответ (В1: Codex,
 *    Qwen Code): у хода есть вход, и сообщение посреди ответа уходит в него же.
 *  - `api` — прямой вызов модельного API по ключу, когда CLI не установлен.
 *
 * Claude сюда не попадает никогда: у него свой богатый чат, и эта ветка его не
 * касается.
 */

const DEFAULT_TIMEOUT_MS = 300_000;

export type ProviderChatRunEvent =
  | { type: 'delta'; text: string }
  /** Ход начат и принимает сообщения посреди ответа (В1). */
  | { type: 'steerable' }
  | { type: 'done'; reply: string; transport: ProviderChatTransport }
  | { type: 'error'; error: string; reason: AssistantRunReason };

export interface ProviderChatRunOptions {
  provider: ConfigProvider;
  /** Переписка вместе с новым вопросом — из неё собирается промпт. */
  history: ProviderChatMessage[];
  /** Идентификатор разговора: по нему находится сессия CLI. */
  chatId: string;
  appDataDir: string;
  /** Рабочий каталог CLI. Не задан — каталог сервера. */
  workdir?: string;
  /**
   * Указание, которое дописывается к переписке ПЕРЕД первой репликой, — у чужого
   * CLI это единственный способ передать что-то вроде системного промпта:
   * отдельного флага для него нет ни у одного из них, а контекст всё равно
   * собирает панель. В переписку не пишется и человеку не показывается.
   */
  systemPrefix?: string;
  timeoutMs?: number;
  models?: ModelInfo[];
  /**
   * Подбор модели под задачу (Т12): чем вести ЭТОТ прогон. Уходит в argv только
   * тем CLI, у которых способ передать модель задокументирован (`oneShotArgs`
   * второго аргумента). Пусто — CLI работает своей настроенной моделью.
   *
   * Путь `api` его НЕ использует намеренно: там модель выбирает панель по
   * собственному скромному умолчанию и по ключу пользователя, за который платит
   * он сам, — подставлять туда ступень лестницы значит менять его расходы.
   */
  model?: string;
  effort?: string;
  /**
   * Права прогона по «Разрешить правки» разговора. Живой ход отдаёт просьбы CLI
   * о разрешении решению `decidePermission` (включено — «да», иначе вопрос
   * человеку); одиночный запуск — флагами CLI, где они проверены
   * (`oneShotArgs`, `allowEdits`). Нет поля — как до переключателя.
   */
  permission?: LivePermissionPolicy;
  /**
   * Маршрут контура для ЭТОГО прогона (Т3): адрес локального шлюза в
   * переменных одного процесса. Собирает служба чатов на каждом запуске —
   * решение зависит от активного контура и отмеченного потребителя
   * `foreign:<cli>`, а они меняются между прогонами.
   *
   * Достаётся только потоковому пути: он и есть запуск CLI. Путь `api` ходит
   * ключом самого человека, и подменять ему адрес значило бы отправить его
   * платный запрос в корпоративный шлюз.
   */
  platformEnv?: Record<string, string>;
  /**
   * Надзиратель рантайма (П3.2): события вокруг ЭТОГО прогона.
   *
   * Собирает вызывающий — набор скриптов зависит от разделов панели, а описание
   * прогона от разговора; здесь они только отыгрываются. Не задан — надзиратель
   * молчит, и прогон идёт точно так же, как шёл до него.
   */
  supervisor?: {
    readonly run: SupervisorRun;
    readonly hooks: readonly SupervisorHook[];
    /** Чем начат разговор — уходит в `SessionStart`. Не задан — события не будет. */
    readonly sessionStart?: SessionStartSource;
    readonly timeoutMs?: number;
  };
  /**
   * Переменные канона для окружения чужого CLI (П3.5).
   *
   * Функция, а не готовый объект, намеренно: снимок настроек прогона панель
   * сохраняет, и значение секрета в таком снимке уехало бы в `state.json`.
   * Вызывается в момент запуска и никуда не записывается.
   */
  portableEnv?: () => Record<string, string>;
  /**
   * Скиллы для цели без своего механизма (П3.4): каталог в инструкции, тело —
   * по имени в следующий запрос.
   *
   * Собирает вызывающий: каталог зависит от раздела скиллов панели, а он читает
   * диск и знает про области видимости. Здесь только отыгрывается — не задан,
   * и прогон идёт точно так же, как шёл без скиллов.
   */
  skills?: SkillTurnSource;
  /** Подменяемые зависимости: в тестах ничего настоящего не запускается. */
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  detect?: (command: string) => boolean;
  sessionServe?: OpencodeServe;
  /**
   * Подмена живого хода (В1). Подменённый `spawnImpl` без неё живой путь
   * отключает: подделка процесса говорит протоколом одиночного запуска, а не
   * серверного режима, и иначе её бы спросили не тем языком.
   */
  liveTurn?: (kind: NonNullable<ConfigProvider['assistant']>['liveServer']) => LiveTurn | undefined;
}

export interface ProviderChatRunLike {
  start(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void>;
  stop(): void;
  /**
   * Сообщение в идущий ответ (В1). `false` — у этого пути входа посреди хода
   * нет или ход его не принял: сообщение ждёт в очереди.
   */
  steer?(text: string): Promise<boolean>;
}

/** Синтетическая реплика с указанием: в файл разговора она не попадает. */
function prefixMessage(content: string): ProviderChatMessage {
  return { id: 'system-prefix', role: 'user', content, at: new Date().toISOString() };
}

export class ProviderChatRun implements ProviderChatRunLike {
  private child?: ChildProcessWithoutNullStreams;
  private liveTurn?: LiveTurn;
  private stopped = false;
  /** Отмена HTTP-путей (`api`, `session`): у них нет процесса, который можно снять. */
  private readonly abort = new AbortController();
  /** Куда идёт сообщение посреди хода: живой ход или сессия OpenCode. */
  private steerTarget?: (text: string) => Promise<boolean>;

  async start(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const { provider } = options;

    if (provider.id === 'claude') {
      onEvent({
        type: 'error',
        error: 'Claude ведёт свой собственный чат — этот путь для него не используется.',
        reason: 'unsupported',
      });
      return;
    }

    // Каталог скиллов и тело названного встают тем же способом, что и указание, —
    // и РАНЬШЕ него: первой репликой цель должна прочитать свою роль, а список
    // доступных ей скиллов уже после. Порядок наложения обратный порядку строк:
    // каждый блок дописывается в начало, поэтому последний из них окажется первым.
    const skillPrefixes = this.planSkills(options);
    if (skillPrefixes.length > 0) {
      options = { ...options, history: [...skillPrefixes.map(prefixMessage), ...options.history] };
    }

    // Указание встаёт первой репликой и дальше живёт как часть переписки: все
    // пути ниже строят промпт из `history`, поэтому подмешать его надо ровно
    // здесь — иначе про него пришлось бы помнить в каждом из них по отдельности.
    if (options.systemPrefix) {
      options = { ...options, history: [prefixMessage(options.systemPrefix), ...options.history] };
    }

    // Надзиратель рантайма отыгрывает события ПЕРЕД выбором раннера: отказ
    // блокирующего хука обязан остановить прогон до того, как чужой CLI будет
    // запущен, — иначе запрет сработал бы уже после действия.
    const supervised = await this.runSupervisorBefore(options, onEvent);
    if (supervised.blocked) return;

    // Контекст, дописанный хуком, встаёт перед перепиской тем же способом, что и
    // `systemPrefix`: у чужого CLI другого канала для этого нет.
    if (supervised.addedContext.length > 0) {
      options = {
        ...options,
        history: [...supervised.addedContext.map(prefixMessage), ...options.history],
      };
    }

    try {
      await this.dispatch(options, onEvent);
    } finally {
      // `Stop` отыгрывается и когда прогон упал: событие конца принадлежит
      // прогону, а не его успеху, и потерять его молча нельзя.
      await this.runSupervisorAfter(options, onEvent);
    }
  }

  /**
   * Каталог скиллов и — если скилл назван — его тело, текстами для врезки (П3.4).
   *
   * Имя ищется в ПОСЛЕДНЕЙ реплике человека: скилл, названный три хода назад,
   * уже отработал, и подкладывать его тело в каждый следующий запрос значило бы
   * съедать контекст цели тем, о чём никто не просил.
   *
   * Тело не попадает в argv ни при каком его размере: отсюда уезжают только
   * каталог (ограничен бюджетом) и ОДНА строка с путём до `SKILL.md`. Файлом
   * инструкций цели прогон не распоряжается — он её не переписывает, поэтому
   * `instructionsBudget` здесь не задаётся и канал остаётся один.
   */
  private planSkills(options: ProviderChatRunOptions): readonly string[] {
    const source = options.skills;
    if (!source) return [];

    const lastUser = [...options.history].reverse().find((message) => message.role === 'user');
    return planSkillTurn({
      entries: source.entries,
      budgetChars: source.budgetChars,
      ...(lastUser ? { prompt: lastUser.content } : {}),
      readBody: source.readBody,
    }).prefixes;
  }

  /** Выбор пути и сам прогон. Вынесено, чтобы события конца отыграл один `finally`. */
  private async dispatch(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const { provider, appDataDir } = options;
    const resolution = resolveRunner(provider, appDataDir, options.detect);

    if (resolution.mode === 'cli') {
      if (await this.runLive(options, resolution.cliCommandFound, onEvent)) return;
      const session = await this.runSession(options, resolution.cliCommandFound, () =>
        onEvent({ type: 'steerable' }),
      );
      // Остановили, пока сессия отвечала: разговор закрыт тем, что успело
      // прийти (обычно ничем), и ни к одиночному запуску, ни к API дальше не идём.
      if (this.stopped) {
        onEvent({ type: 'done', reply: session ?? '', transport: 'session' });
        return;
      }
      if (session) {
        onEvent({ type: 'delta', text: session });
        onEvent({ type: 'done', reply: session, transport: 'session' });
        return;
      }

      const run = {
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.permission ? { allowEdits: options.permission.allowEdits } : {}),
        ...(options.workdir ? { workdir: options.workdir } : {}),
      };
      const args = provider.assistant?.oneShotArgs?.(buildPrompt(options.history).text, run);
      if (args) {
        // Режим прогона окружением — у CLI без флага режима (Goose: `GOOSE_MODE`).
        const runEnv = provider.assistant?.oneShotEnv?.(run);
        await this.runStreaming(options, args, resolution.cliCommandFound, onEvent, runEnv);
        return;
      }
      // CLI есть, но неинтерактивный флаг не задокументирован — придумывать его
      // нельзя, поэтому пробуем ключ, а не «угадаем аргументы».
    }

    const key = getRawKey(provider, appDataDir);
    if (key && provider.assistant?.apiKind && provider.assistant.apiKind !== 'none') {
      await this.runApi(options, key, onEvent);
      return;
    }

    onEvent({
      type: 'error',
      error:
        resolution.mode === 'cli'
          ? `Для «${provider.name}» не задан неинтерактивный флаг запуска CLI.`
          : 'Нужен вход в CLI провайдера или API-ключ.',
      reason: resolution.mode === 'cli' ? 'cli_not_scriptable' : 'no_key_no_cli',
    });
  }

  /**
   * Снять ответ на полуслове: процесс валится целиком, вместе с детьми, а
   * HTTP-запрос к модели или к сессии обрывается — иначе ответ пришёл бы после
   * остановки и лёг в переписку так, будто её и не было.
   */
  async steer(text: string): Promise<boolean> {
    if (this.stopped || !this.steerTarget) return false;
    return this.steerTarget(text);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    this.liveTurn?.stop();
    if (this.child) killChildTree(this.child);
  }

  /**
   * События надзирателя ДО прогона: `SessionStart` (если разговор начинается) и
   * `UserPromptSubmit`.
   *
   * Возвращает `true`, если прогон отказан. Причина уходит человеку событием
   * `error` с поводом `hook_blocked` — это не ошибка запуска: CLI не запускался
   * вовсе, и показывать «CLI упал» здесь значило бы соврать.
   *
   * Контекст, дописанный хуком (`additionalContext`), встаёт в переписку тем же
   * способом, что и `systemPrefix`: у чужого CLI другого канала для этого нет.
   */
  private async runSupervisorBefore(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<{ blocked: boolean; addedContext: readonly string[] }> {
    const supervisor = options.supervisor;
    if (!supervisor) return { blocked: false, addedContext: [] };

    const lastUser = [...options.history].reverse().find((message) => message.role === 'user');

    const events: SupervisorEventInput[] = [
      ...(supervisor.sessionStart
        ? [{ event: 'SessionStart' as const, source: supervisor.sessionStart }]
        : []),
      // Текста может не быть вовсе (прогон без нового вопроса) — тогда поля
      // `prompt` в нагрузке не будет, а пустой строки там быть не должно:
      // «данных нет» и «данные пустые» скрипт обязан различать.
      {
        event: 'UserPromptSubmit' as const,
        ...(lastUser ? { prompt: lastUser.content } : {}),
      },
    ];

    const addedContext: string[] = [];

    for (const input of events) {
      const outcome = await runSupervisorEvent({
        provider: options.provider,
        run: supervisor.run,
        input,
        hooks: supervisor.hooks,
        // `spawnImpl` здесь НЕ передаётся намеренно. Подменяем только внешнюю
        // границу — чужой CLI; исполнение хука это и есть то, что проверяется,
        // и подменённый хук доказывал бы подмену, а не запрет.
        ...(supervisor.timeoutMs ? { timeoutMs: supervisor.timeoutMs } : {}),
      });

      if (outcome.blocked) {
        onEvent({
          type: 'error',
          error: outcome.reason ?? `Хук события ${outcome.event} отказал действию.`,
          reason: 'hook_blocked',
        });
        return { blocked: true, addedContext };
      }

      addedContext.push(...outcome.addedContext);
    }

    return { blocked: false, addedContext };
  }

  /**
   * Событие `Stop` — прогон кончился.
   *
   * У Claude код 2 на `Stop` заставляет агента продолжить работу. Одиночный
   * прогон чужого CLI продолжать НЕЧЕМ: процесс закончился, второго вопроса
   * панель сама не задаёт. Поэтому отказ здесь не прячется и не выдаётся за
   * продолжение — он приезжает человеку заметкой, чтобы причина была видна.
   *
   * `SessionEnd`, `SubagentStop`, `Notification` и `PreCompact` отыгрываются не
   * здесь: они принадлежат закрытию разговора, конвейеру разделения и чек-пойнту
   * передачи — то есть другим точкам, у каждой свой вызывающий.
   */
  private async runSupervisorAfter(
    options: ProviderChatRunOptions,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const supervisor = options.supervisor;
    if (!supervisor) return;

    const outcome = await runSupervisorEvent({
      provider: options.provider,
      run: supervisor.run,
      input: { event: 'Stop', stopHookActive: false },
      hooks: supervisor.hooks,
      ...(supervisor.timeoutMs ? { timeoutMs: supervisor.timeoutMs } : {}),
    });

    if (outcome.blocked) {
      onEvent({
        type: 'error',
        error: outcome.reason ?? 'Хук события Stop потребовал продолжения, а продолжать нечем.',
        reason: 'hook_blocked',
      });
    }
  }

  /**
   * Сессионный режим. `undefined` = «не сложилось, иди дальше»: своих ошибок
   * этот путь не даёт — он не должен уметь сломать то, что работало без него.
   */
  private async runSession(
    options: ProviderChatRunOptions,
    cliCommand?: string,
    onSteerable?: () => void,
  ): Promise<string | undefined> {
    const { provider } = options;
    if (provider.assistant?.sessionServer !== 'opencode') return undefined;
    // Сервер сессий общий на все разговоры: окружение ЭТОГО прогона (адрес
    // контура в `OPENCODE_CONFIG_CONTENT`) до него не доходит, и ход ушёл бы
    // провайдером человека. С окружением — только одиночный запуск.
    if (hasEnv(options.platformEnv)) return undefined;

    const lastUser = [...options.history].reverse().find((message) => message.role === 'user');
    const text = lastUser?.content.trim();
    if (!text) return undefined;

    const serve = options.sessionServe ?? opencodeServe;
    this.steerTarget = (steered) =>
      serve.steer(options.chatId, steered, { fetchImpl: options.fetchImpl });
    onSteerable?.();
    const result = await serve.ask(options.chatId, text, {
      command: cliCommand ?? providerCliCommand(provider),
      spawnImpl: options.spawnImpl,
      fetchImpl: options.fetchImpl,
      requestTimeoutMs: options.timeoutMs,
      signal: this.abort.signal,
      // Каталог разговора и «Разрешить правки» — сессия работает в проекте
      // разговора, а просьбы CLI о разрешении решает `decidePermission` (D2).
      ...(options.workdir ? { workdir: options.workdir } : {}),
      ...(options.permission ? { permission: options.permission } : {}),
    });

    this.steerTarget = undefined;
    return result?.reply;
  }

  /**
   * Живой ход (В1). `true` — ход отыгран здесь (ответом или ошибкой); `false` —
   * серверного режима нет или он не поднялся, и ответ идёт дальше по старым путям
   * так, будто этой попытки не было: до начала хода живой путь ничего не печатает.
   */
  private async runLive(
    options: ProviderChatRunOptions,
    cliCommand: string | undefined,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<boolean> {
    const kind = options.provider.assistant?.liveServer;
    if (!kind || this.stopped) return false;
    // Контур окружением прогона (`runEndpoint`: Kimi Code, Goose): живые серверы
    // с адресом контура не проверены, а `kimi web` вдобавок берёт модель из своего
    // `/config`, то есть из конфига человека. Ход идёт одиночным запуском — этот
    // путь проверен живьём (`check-run-endpoint-cli.mjs`).
    if (options.provider.runEndpoint && hasEnv(options.platformEnv)) return false;
    const factory = options.liveTurn ?? (options.spawnImpl ? undefined : createLiveTurn);
    const turn = factory?.(kind);
    if (!turn) return false;

    this.liveTurn = turn;
    this.steerTarget = (text) => turn.steer(text);
    const result = await turn.run(
      {
        command: cliCommand ?? providerCliCommand(options.provider),
        prompt: buildPrompt(options.history).text,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(options.workdir ? { workdir: options.workdir } : {}),
        ...(options.platformEnv && Object.keys(options.platformEnv).length > 0
          ? { env: options.platformEnv }
          : {}),
        ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.permission ? { permission: options.permission } : {}),
      },
      (text) => onEvent({ type: 'delta', text }),
      () => onEvent({ type: 'steerable' }),
    );
    this.liveTurn = undefined;
    this.steerTarget = undefined;

    if (this.stopped) {
      onEvent({
        type: 'done',
        reply: result.kind === 'done' ? result.reply : '',
        transport: 'live',
      });
      return true;
    }
    if (result.kind === 'unavailable') return false;
    if (result.kind === 'error') {
      onEvent({ type: 'error', error: result.error, reason: 'cli_error' });
      return true;
    }
    if (!result.reply) {
      onEvent({ type: 'error', error: 'CLI закончил ход без ответа', reason: 'cli_error' });
      return true;
    }
    onEvent({ type: 'done', reply: result.reply, transport: 'live' });
    return true;
  }

  /** Прямой вызов модельного API: ответ приходит целиком, поток эмулируется одним куском. */
  private async runApi(
    options: ProviderChatRunOptions,
    key: string,
    onEvent: (event: ProviderChatRunEvent) => void,
  ): Promise<void> {
    const result = await runProviderApi(
      options.provider,
      options.history
        // Заметки панели — её слова человеку о том, чего не получилось, а не
        // реплика разговора: в контекст модели они не идут ни здесь, ни в
        // текстовом промпте (`prompt.ts`).
        .filter(
          (message): message is typeof message & { role: 'user' | 'assistant' } =>
            !message.failed && message.role !== 'notice',
        )
        .map((message) => ({ role: message.role, content: message.content })),
      key,
      {
        appDataDir: options.appDataDir,
        fetchImpl: options.fetchImpl,
        signal: this.abort.signal,
        ...(options.models ? { models: options.models } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      },
    );

    // Обрыв по кнопке — не ошибка модели: ответа нет, и разговор закрывается пустым.
    if (this.stopped) {
      onEvent({ type: 'done', reply: '', transport: 'api' });
      return;
    }

    if (!result.ok) {
      onEvent({
        type: 'error',
        error: result.error ?? 'Модель не ответила',
        reason: result.reason,
      });
      return;
    }

    onEvent({ type: 'delta', text: result.reply });
    onEvent({ type: 'done', reply: result.reply, transport: 'api' });
  }

  /**
   * Потоковый запуск CLI. Куски stdout декодируются потоковым декодером: граница
   * чтения рвёт многобайтовую последовательность UTF-8, и посимвольная склейка
   * без него превращала бы русский ответ в «крокозябры» ровно на стыках.
   */
  private runStreaming(
    options: ProviderChatRunOptions,
    args: string[],
    cliCommand: string | undefined,
    onEvent: (event: ProviderChatRunEvent) => void,
    runEnv?: Record<string, string>,
  ): Promise<void> {
    // Остановили раньше, чем процесс успел стартовать, — стартовать уже незачем.
    if (this.stopped) {
      onEvent({ type: 'done', reply: '', transport: 'stream' });
      return Promise.resolve();
    }

    const command = cliCommand ?? providerCliCommand(options.provider);
    // Набор панели в Codex (`domains/kit/codex.ts`) — без переменной наложения ничего не меняет.
    const kit = withCodexKit(args, options.platformEnv, 'exec');
    if (kit.missing || kit.refusal) {
      onEvent({
        type: 'error',
        error: kit.refusal ?? serverText('kit-compose-failed'),
        reason: 'cli_error',
      });
      return Promise.resolve();
    }
    // Режим прогона — поверх контура и слоя группы: это решение человека на этот ход.
    // `PWD` — вслед за `cwd`: унаследованный от оболочки панели, он указывал бы на
    // её каталог, а `opencode run` берёт каталог проекта из `PWD`, а не из `cwd`
    // (проверено 1.18.34) — и правил файлы мимо разговора.
    const env = {
      ...kit.env,
      ...runEnv,
      ...(options.workdir ? { PWD: options.workdir } : {}),
    };
    const spawned = spawnCliProcess(command, kit.args, {
      spawnImpl: options.spawnImpl,
      ...(options.workdir ? { cwd: options.workdir } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      // Канон ложится ПОД `env`: адрес контура собран для этого прогона и обязан
      // побеждать. Значения секретов живут только в окружении процесса — на диск
      // из этого пути не попадает ничего.
      ...(options.portableEnv ? { portableEnv: options.portableEnv } : {}),
    });

    if (spawned.error) {
      onEvent({ type: 'error', error: spawned.error.message, reason: 'cli_error' });
      return Promise.resolve();
    }

    const child = spawned.child;
    this.child = child;
    // Промпт — в argv, stdin этому прогону не нужен, и его надо ЗАКРЫТЬ: CLI,
    // читающий stdin, когда это не терминал (`opencode run`, проверено 1.18.34),
    // иначе ждёт его конца вечно. Ошибка потока (CLI уже вышел) — не событие.
    child.stdin?.on('error', () => {});
    child.stdin?.end();

    return new Promise<void>((resolve) => {
      const outDecoder = new TextDecoder('utf8');
      const errDecoder = new TextDecoder('utf8');
      // Свой разбор stdout — у CLI, что печатает вокруг ответа служебный вывод или
      // отвечает потоком JSON. Не задан — stdout и есть ответ.
      const parser = options.provider.assistant?.parseStdout?.();
      let reply = '';
      let errorText = '';
      let timedOut = false;
      let settled = false;

      const finish = (event: ProviderChatRunEvent): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = undefined;
        onEvent(event);
        resolve();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killChildTree(child);
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        const raw = outDecoder.decode(chunk, { stream: true });
        const text = parser && raw ? parser.push(raw) : raw;
        if (!text) return;
        reply += text;
        onEvent({ type: 'delta', text });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        errorText += errDecoder.decode(chunk, { stream: true });
      });

      child.on('error', (error) =>
        finish({ type: 'error', error: error.message, reason: 'cli_error' }),
      );

      child.on('close', (code) => {
        const rest = outDecoder.decode();
        const tail = parser ? `${rest ? parser.push(rest) : ''}${parser.end()}` : rest;
        if (tail) {
          reply += tail;
          onEvent({ type: 'delta', text: tail });
        }

        // Остановка по кнопке — не ошибка: то, что модель успела сказать,
        // остаётся ответом, и разговор им продолжается.
        if (this.stopped) {
          finish({ type: 'done', reply: reply.trim(), transport: 'stream' });
          return;
        }

        if (timedOut) {
          finish({
            type: 'error',
            error: 'CLI не ответил за отведённое время',
            reason: 'cli_error',
          });
          return;
        }

        const text = reply.trim();
        // CLI сам сказал «ход удался» (`settled`) — ненулевой код после этого
        // сбой выхода процесса, ответ цел (gemini 0.62 на win32, см. gemini-stream.ts).
        if ((code !== 0 && !parser?.settled?.()) || !text) {
          finish({
            type: 'error',
            error: errorText.trim().slice(0, 500) || `CLI завершился с кодом ${code}`,
            reason: 'cli_error',
          });
          return;
        }

        finish({ type: 'done', reply: text, transport: 'stream' });
      });
    });
  }
}
