import type {
  AdapterChannelSummary,
  AdapterEvent,
  BoundEndpoint,
  CliAdapter,
  SessionSpec,
} from '../../adapter.types.ts';
import { EventTap, HOOK_LOG, livePin, liveSpec, type LiveRoot } from './live.ts';

/**
 * Живое продолжение разговора (Codex, Goose, Kimi над stub-model): сессия на настоящем CLI, один
 * ход, id разговора из `init` и тела запросов к модели за этот ход. Хук ядра — подставной,
 * разрешающий всё (`hook-log.mjs core`): здесь проверяется перенос разговора, не политика (её держат
 * P81-прогоны тех же переходников).
 */

export interface ResumeStand {
  live: LiveRoot;
  channel: AdapterChannelSummary;
  dialect: BoundEndpoint['dialect'];
  baseUrl: string;
  /** Переменные системы, без которых CLI не стартует (TEMP, PATHEXT, …) — из процесса теста. */
  keep?: readonly string[];
}

const q = (path: string): string => `"${path}"`;

/** Пин стенда: одноразовый дом + переменные `keep` + `extra` (дом CLI человека для усыновления). */
export function resumePin(stand: ResumeStand, extra: Record<string, string> = {}) {
  const kept: Record<string, string> = {};
  for (const name of stand.keep ?? []) {
    const value = process.env[name];
    if (value !== undefined) kept[name] = value;
  }
  return livePin(stand.live, { ...kept, ...extra });
}

export function resumeSpec(stand: ResumeStand, over: Partial<SessionSpec> = {}): SessionSpec {
  const base = liveSpec(stand.live);
  return {
    ...base,
    coreHook: `${q(process.execPath)} ${q(HOOK_LOG)} core`,
    endpoint: {
      channel: stand.channel,
      endpoint: {
        baseUrl: stand.baseUrl,
        dialect: stand.dialect,
        model: 'stub-model',
        key: 'stub-key',
      },
    },
    env: { pin: resumePin(stand) },
    ...over,
  };
}

export interface ResumeTurn {
  conversationId: string;
  ended: AdapterEvent;
  /** Тела запросов к модели, пришедшие за этот ход. */
  seen: string[];
}

/** Запуск, один ход, остановка; `requests` — общий журнал тел запросов заглушки модели. */
export async function resumeTurn(
  adapter: CliAdapter,
  spec: SessionSpec,
  text: string,
  requests: readonly string[],
): Promise<ResumeTurn> {
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  const before = requests.length;
  try {
    // Сорванное рукопожатие (`session/load` отказан) — провал сразу, а не ожидание `init` до срока.
    const init = await tap.until(
      (e) => e.type === 'init' || (e.type === 'error' && e.code === 'protocol'),
      120_000,
    );
    if (init.type === 'error') throw new Error(`handshake failed: ${init.detail}`);
    await adapter.send(launched.handle, text, crypto.randomUUID());
    const ended = await tap.until((e) => e.type === 'turn.ended', 180_000);
    return {
      conversationId: init.type === 'init' ? init.conversationId : '',
      ended,
      seen: requests.slice(before),
    };
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
}
