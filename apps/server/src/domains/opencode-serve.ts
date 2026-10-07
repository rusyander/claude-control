import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { killChildTree } from '../lib/process-tree.ts';
import { decidePermission } from './provider-chat/live/permission.ts';
import type { LivePermissionPolicy } from './provider-chat/live/types.ts';

/**
 * Сессионный режим OpenCode (IDEA-8) — вторая, более богатая форма ассистента
 * для НЕ-Claude провайдера.
 *
 * ЗАЧЕМ. One-shot (`opencode run "<промпт>"`) поднимает процесс на каждый вопрос
 * и памяти между вызовами не имеет — панель вынуждена склеивать всю историю в
 * один промпт. У OpenCode есть задокументированный локальный сервер
 * (`opencode serve`), который держит диалог сам: панель создаёт сессию один раз
 * и дальше шлёт только НОВОЕ сообщение. Это и есть разница между «basic» и
 * «богатым» ассистентом здесь: контекст на стороне CLI и настоящий id сессии.
 *
 * ЧТО ВЗЯТО ИЗ СПЕЦИФИКАЦИИ СЕРВЕРА (`GET /doc` у 1.18.34) И ТОЛЬКО ИЗ НЕЁ:
 *  - `opencode serve --port <n> --hostname <адрес>` — локальный HTTP-сервер;
 *  - `GET /global/health` — проверка готовности;
 *  - `?directory=<каталог>` у каждого запроса — в каком проекте работает сессия;
 *  - `GET /config`, `GET /agent` — итоговые настройки и правила агентов;
 *  - `POST /session` с `permission` (набор правил сессии) — создать сессию;
 *  - `POST /session/:id/message` с телом `{ agent, parts: [{ type: 'text', text }] }` —
 *    отправить сообщение; ответ — `{ info, parts }`, текст лежит в частях с
 *    `type: 'text'`;
 *  - `GET /permission` — ждущие ответа просьбы о разрешении,
 *    `POST /permission/:id/reply` `{ reply: 'once'|'reject', message? }` — ответ.
 *
 * ПРАВА («Разрешить правки», D2). Сам OpenCode по умолчанию разрешает ВСЁ
 * (правило `"*": "allow"` у агента `build`, проверено `opencode debug agent build`),
 * то есть без вмешательства панели переключатель ничего бы не значил. Поэтому
 * сессия создаётся со своим набором правил: правки и команды, которые
 * разрешены лишь умолчанием, становятся вопросом. Явные правила человека из его
 * конфигурации (`edit`/`bash`) повторяются дословно — запрет остаётся запретом,
 * явное «allow» остаётся его решением. Правила сессии идут ПОСЛЕ правил агента
 * и побеждают (проверено живым прогоном: вопрос сессии перекрыл даже явный
 * запрет — отсюда и дословный повтор). Каждую просьбу решает `decidePermission`:
 * правки включены — «да», иначе вопрос человеку, иначе отказ.
 *
 * FAIL-CLOSED И БЕЗ РЕГРЕССА: любая заминка ДО начала работы сессии (CLI не
 * найден, сервер не поднялся, ответ не той формы, правила агента не прочитаны) —
 * это `undefined`, а не ошибка наружу. Вызывающий молча возвращается к one-shot.
 * Но если сессия уже спрашивала разрешение, к one-shot возвращаться НЕЛЬЗЯ: он
 * повторил бы ту же работу заново, мимо отказа. Тогда ответ — короткая заметка.
 *
 * Живой прогон: `tools/qa/check-cli-opencode.mjs` (opencode 1.18.34, заглушка модели).
 */

/** Ответ сессионного раннера: текст плюс id сессии, которую держит CLI. */
export interface OpencodeSessionReply {
  reply: string;
  sessionId: string;
}

export interface OpencodeServeDeps {
  spawnImpl?: typeof nodeSpawn;
  fetchImpl?: typeof fetch;
  /** Команда CLI (на Windows — `opencode.cmd`). */
  command: string;
  /** Порт сервера. Не задан — свободный, выбранный ОС. */
  port?: number;
  /** Сколько ждать `GET /global/health`, мс. */
  readyTimeoutMs?: number;
  /** Таймаут одного HTTP-запроса к серверу, мс. */
  requestTimeoutMs?: number;
  /** Внешняя отмена запроса — кнопка «Стоп» в чате. Сервер при этом не гасится. */
  signal?: AbortSignal;
  /** Каталог разговора: в нём сессия читает проект и работает инструментами. */
  workdir?: string;
  /**
   * Права разговора. Нет поля — как у неинтерактивного запуска: просьба о
   * разрешении получает отказ (`decidePermission`).
   */
  permission?: LivePermissionPolicy;
  /** Как часто спрашивать сервер о ждущих просьбах, мс. */
  permissionPollMs?: number;
}

const DEFAULT_READY_TIMEOUT = 20_000;
const DEFAULT_REQUEST_TIMEOUT = 180_000;
const HEALTH_POLL_INTERVAL = 250;
const PERMISSION_POLL_INTERVAL = 250;

/**
 * Что уходит модели вместе с отказом. Без `message` OpenCode обрывает ход на
 * отказе и не говорит ничего (проверено на 1.18.34); с ним модель узнаёт причину
 * и отвечает текстом. Это текст для модели — по-английски.
 */
export const OPENCODE_DECLINE_MESSAGE =
  'The user declined this permission request. Do not retry it; answer without this action.';

/**
 * Ответ, когда сессия уже спрашивала разрешение, а текста так и не дала. Не
 * пустота: пустой ответ отправил бы вызывающего в one-shot, а тот повторил бы
 * работу мимо отказа.
 */
export const OPENCODE_STOPPED_REPLY =
  'OpenCode stopped after a permission request and gave no text answer.';

/** Свободный порт от ОС: сокет на `0`, читаем выданный номер, закрываем. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('порт не выдан'))));
    });
  });
}

const isWindows = (): boolean => process.platform === 'win32';

// --- Правила сессии -----------------------------------------------------------

type PermissionAction = 'allow' | 'ask' | 'deny';

/** Правило набора OpenCode — форма `PermissionRule` из спецификации сервера. */
export interface OpencodePermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/**
 * Что держит переключатель: `edit` (у OpenCode это и `write`, и `patch`) и
 * `bash`. Те же два, что у прочих CLI с переключателем: правка файла и команда.
 */
export const GATED_PERMISSIONS = ['edit', 'bash'] as const;

const ACTIONS: readonly string[] = ['allow', 'ask', 'deny'];

function isRule(value: unknown): value is OpencodePermissionRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.permission === 'string' &&
    typeof rule.pattern === 'string' &&
    typeof rule.action === 'string' &&
    ACTIONS.includes(rule.action)
  );
}

/** Шаблон имени разрешения OpenCode: `*` — что угодно, `?` — один символ. */
function wildcardMatch(value: string, pattern: string): boolean {
  const source = pattern
    .split('')
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${source}$`, 's').test(value);
}

/**
 * Набор правил сессии из правил агента. Для каждого держимого разрешения —
 * правила агента, которые его касаются, в том же порядке: правило, названное
 * этим именем, — дословно (явное решение человека), правило-шаблон (`*` и т. п.,
 * среди них умолчание OpenCode) — с «allow», ставшим «ask». Последнее
 * подходящее правило у OpenCode побеждает, поэтому итог для любой команды или
 * файла — решение агента, где «разрешено умолчанием» превратилось в вопрос.
 * Ничего не ослабляется: «deny» и «ask» переходят как есть.
 */
export function sessionPermissionRules(
  agentRules: readonly OpencodePermissionRule[],
): OpencodePermissionRule[] {
  return GATED_PERMISSIONS.flatMap((name) => [
    // Если у агента не нашлось ни одного правила об этом разрешении, OpenCode
    // спрашивает сам; первая строка делает это явным и ничего не меняет.
    { permission: name, pattern: '*', action: 'ask' as const },
    ...agentRules
      .filter((rule) => wildcardMatch(name, rule.permission))
      .map((rule) => ({
        permission: name,
        pattern: rule.pattern,
        action:
          rule.permission === name || rule.action !== 'allow' ? rule.action : ('ask' as const),
      })),
  ]);
}

/**
 * Агент, которым пойдёт сообщение: `default_agent` из настроек, если это
 * основной агент, иначе `build` (умолчание OpenCode). Нет такого — `undefined`:
 * не зная его правил, честный набор сессии не собрать.
 */
export function pickAgent(
  agents: unknown,
  config: unknown,
): { name: string; permission: OpencodePermissionRule[] } | undefined {
  if (!Array.isArray(agents)) return undefined;
  const wanted =
    config && typeof config === 'object'
      ? (config as { default_agent?: unknown }).default_agent
      : undefined;
  const primary = (name: unknown) =>
    agents.find(
      (agent): agent is { name: string; mode?: unknown; permission: unknown } =>
        !!agent &&
        typeof agent === 'object' &&
        (agent as { name?: unknown }).name === name &&
        (agent as { mode?: unknown }).mode !== 'subagent',
    );
  const agent = (typeof wanted === 'string' && primary(wanted)) || primary('build');
  if (!agent || !Array.isArray(agent.permission) || !agent.permission.every(isRule)) {
    return undefined;
  }
  return { name: agent.name, permission: agent.permission };
}

const directoryQuery = (workdir: string | undefined): string =>
  workdir ? `?directory=${encodeURIComponent(workdir)}` : '';

/** Просьба о разрешении — форма `PermissionRequest` из спецификации сервера. */
interface PendingPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
}

function isPending(value: unknown): value is PendingPermission {
  if (!value || typeof value !== 'object') return false;
  const ask = value as Record<string, unknown>;
  return (
    typeof ask.id === 'string' &&
    typeof ask.sessionID === 'string' &&
    typeof ask.permission === 'string' &&
    Array.isArray(ask.patterns)
  );
}

/** Сессия CLI под разговор панели: id, каталог и агент, чьи правила взяты. */
interface OpencodeSession {
  id: string;
  workdir: string | undefined;
  agent: string;
}

/**
 * Локальный сервер OpenCode: поднимается лениво, живёт до конца процесса панели,
 * держит карту «диалог панели → сессия CLI».
 *
 * Один экземпляр на процесс (`opencodeServe` ниже). В тестах создаётся свой — с
 * подменёнными `spawn`/`fetch`, чтобы ни один настоящий процесс не запускался.
 */
export class OpencodeServe {
  private child: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<string | undefined> | undefined;
  /**
   * Процесс, который ещё ждёт /global/health. `dispose()` посреди старта (выход
   * панели, конец проверки) снимает и его: иначе сервер, поднявшийся после
   * снятия, остался бы сиротой держать порт и базу CLI.
   */
  private pending: ChildProcess | undefined;
  /** Растёт на каждом `dispose()`: старт, начатый до снятия, сервер не усыновляет. */
  private generation = 0;
  private readonly sessions = new Map<string, OpencodeSession>();

  /** Адрес поднятого сервера или `undefined`, если поднять не удалось. */
  async ensure(deps: OpencodeServeDeps): Promise<string | undefined> {
    if (this.baseUrl) return this.baseUrl;
    // Параллельные запросы не должны поднимать ВТОРОЙ сервер: ждём один старт.
    this.starting ??= this.start(deps).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(deps: OpencodeServeDeps): Promise<string | undefined> {
    const spawnImpl = deps.spawnImpl ?? nodeSpawn;
    const generation = this.generation;
    let port = deps.port;
    if (!port) {
      try {
        port = await freePort();
      } catch {
        return undefined;
      }
    }
    // Слушаем только петлю: сервер CLI — приватный инструмент панели, наружу его
    // не выставляем ни при каких настройках.
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];

    // stdio: 'ignore' — принципиально. По умолчанию потоки уходят в трубы,
    // которые НИКТО не читает: сервер CLI живёт до конца работы панели и всё
    // это время пишет в лог, а заполненный буфер трубы (единицы килобайт)
    // блокирует его запись НАВСЕГДА — сервер тихо замирает посреди ответа.
    // Вывод нам не нужен: о готовности мы узнаём опросом /global/health.
    let child: ChildProcess;
    try {
      child = isWindows()
        ? spawnImpl(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', deps.command, ...args], {
            windowsHide: true,
            stdio: 'ignore',
          })
        : spawnImpl(deps.command, args, { windowsHide: true, stdio: 'ignore' });
    } catch {
      return undefined;
    }

    // Процесс умер сам (CLI не найден, порт занят) — забываем адрес, следующий
    // запрос попробует поднять заново.
    child.on('error', () => this.forget());
    child.on('exit', () => this.forget());
    this.pending = child;

    const baseUrl = `http://127.0.0.1:${port}`;
    const ready = await this.waitHealthy(baseUrl, deps);
    if (this.pending === child) this.pending = undefined;
    if (!ready || generation !== this.generation) {
      killTree(child);
      return undefined;
    }

    this.child = child;
    this.baseUrl = baseUrl;
    return baseUrl;
  }

  private async waitHealthy(baseUrl: string, deps: OpencodeServeDeps): Promise<boolean> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const deadline = Date.now() + (deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT);
    for (;;) {
      try {
        const res = await fetchImpl(`${baseUrl}/global/health`);
        if (res.ok) return true;
      } catch {
        // Сервер ещё не слушает — это нормальная часть ожидания старта.
      }
      if (Date.now() >= deadline) return false;
      await sleep(HEALTH_POLL_INTERVAL);
    }
  }

  /** Забыть поднятый сервер (процесс умер) — сессии вместе с ним недействительны. */
  private forget(): void {
    this.child = undefined;
    this.baseUrl = undefined;
    this.sessions.clear();
  }

  /**
   * Отправить сообщение в сессию диалога `conversationId`, создав её при первом
   * обращении. Неудача до начала работы → `undefined`: вызывающий вернётся к one-shot.
   */
  async ask(
    conversationId: string,
    text: string,
    deps: OpencodeServeDeps,
  ): Promise<OpencodeSessionReply | undefined> {
    const baseUrl = await this.ensure(deps);
    if (!baseUrl) return undefined;

    let session = this.sessions.get(conversationId);
    // Каталог разговора сменили — старая сессия работает в прежнем проекте.
    if (session && session.workdir !== deps.workdir) session = undefined;
    if (!session) {
      session = await this.createSession(baseUrl, deps);
      if (!session) return undefined;
      this.sessions.set(conversationId, session);
    }

    const outcome = await this.sendMessage(baseUrl, session, text, deps);
    if (outcome.reply === undefined) {
      // Сессия могла протухнуть вместе с сервером — не держим мёртвый id.
      this.sessions.delete(conversationId);
      if (!outcome.asked) return undefined;
      return { reply: OPENCODE_STOPPED_REPLY, sessionId: session.id };
    }
    return { reply: outcome.reply, sessionId: session.id };
  }

  /**
   * Сессия с набором правил из правил агента (`sessionPermissionRules`). Правила
   * не прочитаны — сессии нет: без них переключатель снова ничего бы не значил.
   */
  private async createSession(
    baseUrl: string,
    deps: OpencodeServeDeps,
  ): Promise<OpencodeSession | undefined> {
    const query = directoryQuery(deps.workdir);
    const config = await this.request(baseUrl, `/config${query}`, undefined, deps);
    const agents = await this.request(baseUrl, `/agent${query}`, undefined, deps);
    const agent = pickAgent(agents, config);
    if (!agent) return undefined;

    const body = await this.request(
      baseUrl,
      `/session${query}`,
      { permission: sessionPermissionRules(agent.permission) },
      deps,
    );
    if (!body || typeof body !== 'object') return undefined;
    const id = (body as { id?: unknown }).id;
    return typeof id === 'string' && id
      ? { id, workdir: deps.workdir, agent: agent.name }
      : undefined;
  }

  private async sendMessage(
    baseUrl: string,
    session: OpencodeSession,
    text: string,
    deps: OpencodeServeDeps,
  ): Promise<{ reply: string | undefined; asked: boolean }> {
    const query = directoryQuery(session.workdir);
    const watcher = this.watchPermissions(baseUrl, session, deps);
    let body: unknown;
    try {
      body = await this.request(
        baseUrl,
        `/session/${encodeURIComponent(session.id)}/message${query}`,
        { agent: session.agent, parts: [{ type: 'text', text }] },
        deps,
      );
    } finally {
      watcher.stop();
    }
    const asked = watcher.asked();
    if (!body || typeof body !== 'object') return { reply: undefined, asked };

    const parts = (body as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) return { reply: undefined, asked };

    // Берём только части `type: 'text'` — единственная форма, задокументированная
    // и на отправку, и на приём. Всё прочее (инструменты, служебные части) молча
    // пропускаем: показывать непонятую часть как ответ было бы выдумкой.
    const reply = parts
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('')
      .trim();

    return { reply: reply || undefined, asked };
  }

  /**
   * Пока идёт сообщение — опрос ждущих просьб этой сессии и ответ на каждую
   * ровно один раз. Решение — `decidePermission`; вопрос человеку может ждать
   * сколько угодно, опрос его не дублирует.
   */
  private watchPermissions(
    baseUrl: string,
    session: OpencodeSession,
    deps: OpencodeServeDeps,
  ): { stop: () => void; asked: () => boolean } {
    const query = directoryQuery(session.workdir);
    const seen = new Set<string>();
    let stopped = false;

    const answer = async (ask: PendingPermission): Promise<void> => {
      const title = ask.patterns.filter((item) => typeof item === 'string').join(', ');
      const decision = await decidePermission(deps.permission, {
        cli: 'opencode',
        requestId: ask.id,
        tool: ask.permission,
        ...(title ? { title: title.slice(0, 300) } : {}),
      });
      await this.request(
        baseUrl,
        `/permission/${encodeURIComponent(ask.id)}/reply${query}`,
        decision === 'allow'
          ? { reply: 'once' }
          : { reply: 'reject', message: OPENCODE_DECLINE_MESSAGE },
        deps,
      );
    };

    const loop = async (): Promise<void> => {
      while (!stopped) {
        await sleep(deps.permissionPollMs ?? PERMISSION_POLL_INTERVAL);
        if (stopped) return;
        const pending = await this.request(baseUrl, `/permission${query}`, undefined, deps);
        if (!Array.isArray(pending)) continue;
        for (const ask of pending) {
          if (!isPending(ask) || ask.sessionID !== session.id || seen.has(ask.id)) continue;
          seen.add(ask.id);
          void answer(ask);
        }
      }
    };
    void loop();

    return {
      stop: () => {
        stopped = true;
      },
      asked: () => seen.size > 0,
    };
  }

  /**
   * Запрос с таймаутом: тело есть — POST JSON, нет — GET. Любая ошибка/не-2xx →
   * `undefined`.
   */
  private async request(
    baseUrl: string,
    path: string,
    payload: unknown,
    deps: OpencodeServeDeps,
  ): Promise<unknown> {
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT,
    );
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        ...(payload === undefined
          ? { method: 'GET' }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
        signal: deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal,
      });
      if (!res.ok) return undefined;
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Сообщение в ИДУЩИЙ ответ той же сессии (В1). `prompt_async` ответа не ждёт
   * (204), а цикл OpenCode подхватывает сообщение тем же прогоном — следующим
   * запросом к модели, и уже идущий `message` возвращает ответ с его учётом
   * (проверено живым прогоном 1.18.34 на заглушке модели). Сессии нет, сервер
   * ушёл, не 2xx — `false`: сообщение встаёт в очередь панели.
   */
  async steer(
    conversationId: string,
    text: string,
    deps: Pick<OpencodeServeDeps, 'fetchImpl'> = {},
  ): Promise<boolean> {
    const session = this.sessions.get(conversationId);
    if (!this.baseUrl || !session) return false;
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    try {
      const res = await fetchImpl(
        `${this.baseUrl}/session/${encodeURIComponent(session.id)}/prompt_async${directoryQuery(session.workdir)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agent: session.agent, parts: [{ type: 'text', text }] }),
          signal: AbortSignal.timeout(DEFAULT_READY_TIMEOUT),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Погасить сервер (выход панели, смена провайдера, тесты). */
  dispose(): void {
    this.generation += 1;
    if (this.child) killTree(this.child);
    if (this.pending) killTree(this.pending);
    this.pending = undefined;
    this.forget();
  }

  /** Адрес поднятого сервера — для диагностики; поднимать сам не станет. */
  currentBaseUrl(): string | undefined {
    return this.baseUrl;
  }
}

/**
 * Снять сервер ЦЕЛИКОМ. На Windows CLI запущен через `cmd.exe /c`, и `kill()`
 * убил бы только оболочку — настоящий процесс остался бы держать порт. Дерево
 * снимает общий `killChildTree` (без `taskkill /T`, который цеплял чужих сирот);
 * подделка из теста без кодов выхода по номеру не снимается вовсе.
 */
function killTree(child: ChildProcess): void {
  killChildTree(child);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Единственный экземпляр на процесс панели. */
export const opencodeServe = new OpencodeServe();

// Панель закрывается — сервер CLI не должен пережить её и держать порт.
process.once('exit', () => opencodeServe.dispose());
