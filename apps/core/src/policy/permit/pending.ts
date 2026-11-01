import type { AdapterEvent } from '../../adapters/adapter.types.ts';
import { SDK_TOOL_PROXIES } from '../../adapters/sdk-stream/permit-codec.ts';

/**
 * Какие вопросы о праве сейчас законно ждут ответа (R:S3-09). CLI зовёт `agentdeck-permit`
 * только за вызовом инструмента, который модель уже запросила и который ещё не исполнен:
 * `tool.requested` без `tool.result`. Вызов, который не отвечает на такой запрос (выдуманный
 * id, чужое имя инструмента, второй ответ на тот же запрос, вопрос о самом сервере права), —
 * подделка: ядро отказывает и пишет `signal forged-authority`.
 *
 * Запрос через прокси отложенных инструментов (`proxyToolNames`, `tool_call {name, arguments}`)
 * законно спрашивают о его цели `input.name` (без регистра) — и только о ней: вопрос о самом прокси,
 * о другом инструменте, о сервере права как цели, о прокси без цели — подделка, как прежде.
 *
 * Вызов может прийти раньше, чем ядро дочитало поток сессии, поэтому `claim` ждёт появления
 * запроса не дольше `waitMs` — дольше ждать незачем: CLI спрашивает уже после запроса модели.
 */

export type ClaimOutcome = { pending: true } | { pending: false; reason: string };

export interface PendingPermits {
  observe(sessionId: string, event: AdapterEvent): void;
  claim(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    waitMs: number,
  ): Promise<ClaimOutcome>;
  forget(sessionId: string): void;
  /**
   * Вопрос о праве этой сессии принят и ещё ждёт своего запроса в потоке (`claim` не ответил):
   * CLI стоит посреди хода и ждёт ядро — тишина потока тогда не тишина модели (этап 8, F9).
   * Именно ожидание, а не состояние `claimed`: то держится до `tool.result`, через всё
   * исполнение разрешённого инструмента, и зависший инструмент никогда не стал бы тишиной.
   */
  deciding(sessionId: string): boolean;
}

interface Entry {
  name: string;
  /** Запрос через прокси: цель `input.name`, о которой спросит CLI; `null` — цели нет. */
  target?: string | null;
  state: 'requested' | 'claimed' | 'finished';
}

/** Цель вызова прокси — непустое `input.name`. */
function proxyTarget(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const name = (input as Record<string, unknown>).name;
  return typeof name === 'string' && name !== '' ? name : null;
}

/** Предел записей на сессию: поток вызовов не раздувает память ядра. */
export const PENDING_LIMIT = 2_000;

export function createPendingPermits(opts: {
  selfToolNames: readonly string[];
  /** Прокси отложенных инструментов; по умолчанию — прокси CLI формата SDK. */
  proxyToolNames?: readonly string[];
}): PendingPermits {
  const sessions = new Map<string, Map<string, Entry>>();
  /** Ждущие `claim`: `forgotten` — сессию забыли, ответ «нет» сразу, а не по таймеру. */
  const waiters = new Map<string, Set<(forgotten?: boolean) => void>>();
  const selfLower = new Set(opts.selfToolNames.map((n) => n.toLowerCase()));
  const proxies = new Set(opts.proxyToolNames ?? SDK_TOOL_PROXIES);

  const entriesOf = (sessionId: string): Map<string, Entry> => {
    let entries = sessions.get(sessionId);
    if (!entries) {
      entries = new Map();
      sessions.set(sessionId, entries);
    }
    return entries;
  };
  const wake = (sessionId: string): void => {
    for (const fn of waiters.get(sessionId) ?? []) fn();
  };
  const judge = (entry: Entry | undefined, toolName: string): ClaimOutcome | undefined => {
    if (!entry) return undefined;
    const target = entry.target;
    // Имя сервера права — без регистра: CLI находит инструмент и под другим регистром (F-92).
    if (
      selfLower.has(entry.name.toLowerCase()) ||
      (target && selfLower.has(target.toLowerCase()))
    ) {
      return { pending: false, reason: 'the permission server itself was called as a tool' };
    }
    if (entry.state === 'claimed') return { pending: false, reason: 'request already answered' };
    if (entry.state === 'finished') return { pending: false, reason: 'tool call already finished' };
    if (target === null) {
      return { pending: false, reason: `pending proxy ${entry.name} names no tool` };
    }
    if (target !== undefined) {
      if (target.toLowerCase() !== toolName.toLowerCase()) {
        return {
          pending: false,
          reason: `pending tool is ${entry.name} → ${target}, not ${toolName}`,
        };
      }
    } else if (entry.name !== toolName) {
      return { pending: false, reason: `pending tool is ${entry.name}, not ${toolName}` };
    }
    entry.state = 'claimed';
    return { pending: true };
  };

  return {
    observe(sessionId, event) {
      if (event.type !== 'tool.requested' && event.type !== 'tool.result') return;
      const entries = entriesOf(sessionId);
      if (event.type === 'tool.requested') {
        if (!entries.has(event.toolUseId)) {
          entries.set(event.toolUseId, {
            name: event.name,
            ...(proxies.has(event.name) ? { target: proxyTarget(event.input) } : {}),
            state: 'requested',
          });
        }
        // Сверх предела уходят сначала отвеченные и законченные: открытый запрос, который CLI
        // ещё спросит, не вытесняется потоком чужих вызовов (F-92).
        while (entries.size > PENDING_LIMIT) {
          let victim: string | undefined;
          for (const [id, e] of entries) {
            if (e.state !== 'requested') {
              victim = id;
              break;
            }
          }
          victim ??= entries.keys().next().value;
          if (victim === undefined) break;
          entries.delete(victim);
        }
      } else {
        const entry = entries.get(event.toolUseId);
        if (entry) entry.state = 'finished';
      }
      wake(sessionId);
    },
    async claim(sessionId, toolUseId, toolName, waitMs) {
      const now = judge(sessions.get(sessionId)?.get(toolUseId), toolName);
      if (now) return now;
      return new Promise<ClaimOutcome>((done) => {
        const set = waiters.get(sessionId) ?? new Set<(forgotten?: boolean) => void>();
        waiters.set(sessionId, set);
        const finish = (outcome: ClaimOutcome): void => {
          clearTimeout(timer);
          set.delete(check);
          if (set.size === 0) waiters.delete(sessionId);
          done(outcome);
        };
        const check = (forgotten?: boolean): void => {
          if (forgotten) return finish({ pending: false, reason: 'session is gone' });
          const got = judge(sessions.get(sessionId)?.get(toolUseId), toolName);
          if (got) finish(got);
        };
        const timer = setTimeout(
          () => finish({ pending: false, reason: 'no pending tool call with this id' }),
          waitMs,
        );
        set.add(check);
      });
    },
    deciding: (sessionId) => (waiters.get(sessionId)?.size ?? 0) > 0,
    forget(sessionId) {
      sessions.delete(sessionId);
      for (const fn of [...(waiters.get(sessionId) ?? [])]) fn(true);
      waiters.delete(sessionId);
    },
  };
}
