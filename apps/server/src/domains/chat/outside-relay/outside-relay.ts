/**
 * Сессии, идущие вне панели (терминал, VS Code), — под контролем с телефона:
 * вопросы агента, запросы прав и сообщения посреди хода.
 *
 * Вопросы и права. Хук `PermissionRequest` CLI запускает ОДНОВРЕМЕННО с
 * диалогом своего окна, и принимает первое решение: ответ хука закрывает окно
 * (CLI шлёт ему отмену), ответ в окне делает ответ хука ненужным (замер
 * 11.10.2026, claude 2.1.286, и в потоковом режиме VS Code, и в терминале).
 * Поэтому запрос не «уезжает» на телефон — он стоит в обоих местах. Хук панели
 * (`outside-relay-hook.mjs`) регистрирует запрос здесь и ждёт; телефон решает;
 * хук отдаёт решение CLI. Ответили в окне — хук видит результат вызова в
 * транскрипте и отпускает запрос сам.
 *
 * Сообщения. Человек пишет с телефона, пока агент работает: сообщение ждёт в
 * очереди сессии, и хук `PostToolUse` (после каждого шага) или `Stop` (в конце
 * хода) отдаёт его агенту — тот читает его на ближайшем шаге, не дожидаясь
 * конца хода.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Сколько запрос ждёт телефона, прежде чем хук отпустит его. Копия — `MAX_MS`
 * в `outside-relay-hook.mjs` (хук без сборки сюда не дотянется).
 */
export const RELAY_MAX_MS = 50 * 60 * 1000;
/** Сколько сервер держит один запрос ожидания хука. */
export const RELAY_WAIT_MS = 25 * 1000;
/**
 * Хук молчит дольше — он мёртв: CLI убивает хуки на выходе, и запрос, решённый
 * в окне перед самым выходом, иначе висел бы на телефоне до предела ожидания.
 * Живой хук спрашивает срезами по 3 с и, пока панель недоступна, повторяет
 * через 2 с (`WAIT_SLICE_MS`, `RETRY_MS` в `outside-relay-hook.mjs`).
 */
export const HOOK_SILENT_MS = 15 * 1000;
/** Сколько доставленное сообщение остаётся видно на телефоне со статусом. */
export const DELIVERED_KEEP_MS = 30 * 60 * 1000;
/** Сколько ждёт недоставленное: дольше — ход давно кончился без хуков. */
const QUEUED_KEEP_MS = 6 * 60 * 60 * 1000;

export interface OutsideAskInput {
  toolUseId: string;
  sessionId: string;
  cwd?: string;
  toolName: string;
  input?: unknown;
}

export type OutsideDecision =
  | { state: 'answered'; answers: { [question: string]: string } }
  | { state: 'decided'; behavior: 'allow' | 'deny' };

/** Что получает хук на запрос ожидания. */
export type OutsideWait =
  | OutsideDecision
  | { state: 'released' }
  | { state: 'pending' }
  /** Запроса нет: сервер перезапускался или запрос уже забран. */
  | { state: 'unknown' };

type Outcome = OutsideDecision | { state: 'released' };

interface Entry {
  input: OutsideAskInput;
  askedAt: number;
  /** Когда хук последний раз спрашивал о запросе. */
  seenAt: number;
  outcome?: Outcome;
  waiters: Set<(outcome: Outcome) => void>;
}

/** Ждущий запрос — для сводки «что ждёт человека». */
export interface OutsidePending extends OutsideAskInput {
  askedAt: number;
}

interface Message {
  id: string;
  text: string;
  queuedAt: number;
  deliveredAt?: number;
}

export interface OutsideRelayDeps {
  /** Включена ли пересылка (переключатель на телефоне и в настройках панели). */
  enabled: () => boolean;
  /** Сессия — прогон самой панели: её вопросы закрывает брокер панели. */
  ownSession: (sessionId: string) => boolean;
  now?: () => number;
  /**
   * Папка флагов очереди: файл сессии лежит, пока для неё есть сообщение. Хук
   * `PostToolUse` стоит на каждом шаге каждой сессии и без флага не ходит на
   * сервер вовсе — хук с HTTP шёл 80 мс, без него 47 мс (медиана 15 запусков,
   * 18.10.2026), а сообщение с телефона бывает редко. Нет папки — хук
   * спрашивает каждый раз.
   */
  flagDir?: string;
}

/** Метка в папке флагов: сервер их пишет, отсутствие флага значит «пусто». */
export const RELAY_FLAG_MARKER = '.server';

/** Имя флага сессии — то же правило в `outside-relay-hook.mjs`. */
export const relayFlagName = (sessionId: string): string => sessionId.replace(/[^a-zA-Z0-9-]/g, '');

export class OutsideRelay {
  private readonly asks = new Map<string, Entry>();
  private readonly messages = new Map<string, Message[]>();
  /** Когда хуки панели последний раз отзывались из сессии. */
  private readonly hookedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly deps: OutsideRelayDeps;
  private counter = 0;

  constructor(deps: OutsideRelayDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    // Старые флаги не чистятся: лишний флаг стоит хуку один запрос, и этот же
    // запрос его снимает, а чистка из второй панели (прогоны QA) сняла бы чужой.
    this.flagFile(RELAY_FLAG_MARKER, 'write');
  }

  private flagFile(name: string, op: 'write' | 'remove'): void {
    const dir = this.deps.flagDir;
    if (!dir || !name) return;
    try {
      if (op === 'remove') rmSync(join(dir, name), { force: true });
      else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), '');
      }
    } catch {
      // Флаг — ускорение: без него хук просто идёт на сервер.
    }
  }

  /** Хук сообщил о запросе. `false` — перехвата нет, решает только окно. */
  register(input: OutsideAskInput): boolean {
    this.sweep();
    this.hookedAt.set(input.sessionId, this.now());
    if (!this.deps.enabled() || this.deps.ownSession(input.sessionId)) return false;
    const known = this.asks.get(input.toolUseId);
    if (known) known.seenAt = this.now();
    else {
      const now = this.now();
      this.asks.set(input.toolUseId, { input, askedAt: now, seenAt: now, waiters: new Set() });
    }
    return true;
  }

  /** Ждёт решения не дольше `ms`. Решение отдаётся один раз — запись уходит. */
  wait(toolUseId: string, ms = RELAY_WAIT_MS): Promise<OutsideWait> {
    const entry = this.asks.get(toolUseId);
    if (!entry) return Promise.resolve({ state: 'unknown' });
    entry.seenAt = this.now();
    if (entry.outcome) return Promise.resolve(this.take(toolUseId, entry.outcome));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters.delete(onOutcome);
        entry.seenAt = this.now();
        resolve({ state: 'pending' });
      }, ms);
      const onOutcome = (outcome: Outcome): void => {
        clearTimeout(timer);
        resolve(this.take(toolUseId, outcome));
      };
      entry.waiters.add(onOutcome);
    });
  }

  /**
   * Решение с телефона. `false` — запроса уже нет (ответили в окне, отпущен,
   * истёк) или решение не того рода: на вопрос отвечают вариантами, на права —
   * «разрешить / запретить».
   */
  decide(toolUseId: string, decision: OutsideDecision): boolean {
    const entry = this.asks.get(toolUseId);
    if (!entry) return false;
    const isQuestion = entry.input.toolName === 'AskUserQuestion';
    if (isQuestion !== (decision.state === 'answered')) return false;
    return this.settle(toolUseId, decision);
  }

  /** Отпустить: хук выходит без решения, остаётся окно. */
  release(toolUseId: string): boolean {
    return this.settle(toolUseId, { state: 'released' });
  }

  /** Ждёт ли запрос решения с телефона — тогда на него можно ответить. */
  isPending(toolUseId: string): boolean {
    this.sweep();
    const entry = this.asks.get(toolUseId);
    return Boolean(entry && !entry.outcome);
  }

  /** Все ждущие запросы — сводка раскладывает их по чатам. */
  pending(): OutsidePending[] {
    this.sweep();
    return [...this.asks.values()]
      .filter((entry) => !entry.outcome)
      .map((entry) => ({ ...entry.input, askedAt: entry.askedAt }));
  }

  /** Сообщение с телефона в ход сессии — ждёт ближайшего шага. */
  queue(sessionId: string, text: string): Message {
    this.sweep();
    this.counter += 1;
    const message: Message = { id: `m${this.now()}-${this.counter}`, text, queuedAt: this.now() };
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), message]);
    this.flagFile(relayFlagName(sessionId), 'write');
    return message;
  }

  /**
   * Хук после шага или в конце хода забирает недоставленное. Сам вызов —
   * знак, что хуки в этой сессии работают.
   */
  takeMessages(sessionId: string): string[] {
    this.sweep();
    this.hookedAt.set(sessionId, this.now());
    const fresh = (this.messages.get(sessionId) ?? []).filter(
      (message) => message.deliveredAt === undefined,
    );
    for (const message of fresh) message.deliveredAt = this.now();
    this.flagFile(relayFlagName(sessionId), 'remove');
    return fresh.map((message) => message.text);
  }

  /** Сообщения сессии со статусом — для ленты телефона. */
  listMessages(sessionId: string): { messages: Message[]; hooked: boolean } {
    this.sweep();
    return {
      messages: [...(this.messages.get(sessionId) ?? [])],
      hooked: this.hookedAt.has(sessionId),
    };
  }

  private settle(toolUseId: string, outcome: Outcome): boolean {
    this.sweep();
    const entry = this.asks.get(toolUseId);
    if (!entry || entry.outcome) return false;
    entry.outcome = outcome;
    for (const waiter of [...entry.waiters]) waiter(outcome);
    return true;
  }

  private take(toolUseId: string, outcome: Outcome): OutsideWait {
    this.asks.delete(toolUseId);
    return outcome;
  }

  /** Хук, умерший вместе с окном, не придёт: ни старое, ни брошенное не копится. */
  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.asks) {
      const silent = entry.waiters.size === 0 && entry.seenAt < now - HOOK_SILENT_MS;
      if (entry.askedAt < now - RELAY_MAX_MS || silent) this.asks.delete(id);
    }
    for (const [sessionId, list] of this.messages) {
      const kept = list.filter((message) =>
        message.deliveredAt !== undefined
          ? message.deliveredAt >= now - DELIVERED_KEEP_MS
          : message.queuedAt >= now - QUEUED_KEEP_MS,
      );
      if (kept.length > 0) this.messages.set(sessionId, kept);
      else this.messages.delete(sessionId);
    }
    for (const [sessionId, at] of this.hookedAt) {
      if (at < now - QUEUED_KEEP_MS) this.hookedAt.delete(sessionId);
    }
  }
}
