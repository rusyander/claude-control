import type {
  LocalHoldBody,
  LocalHoldView,
  LocalReleaseReply,
} from '@agentdeck/contracts/core/local-hold';
import {
  createCoreIdentityDeps,
  type CoreIdentityDeps,
} from '../../lib/listen-identity/listen-identity.ts';
import { forwardToCore, locateCore, verifyCore } from '../core-proxy/core-proxy.ts';
import { localError } from './errors.ts';

/**
 * Кнопки «Запустить»/«Остановить» раздела — удержание своей модели в ядре (этап 10, зона C):
 * свой llama-server панель больше не поднимает. Ядро держит слот карты (одна модель на карту,
 * общий с задачами ядра), судит память карты до загрузки и слушает постоянный порт, на который
 * смотрят CLI человека. Путь — тот же, что у прокладки панели: строка `procs.json`, сверка ОС до
 * отправки токена (F-19), loopback. Кода ядра здесь нет (граница depcruise).
 */
export interface CoreHold {
  /** Удержать модель; отказ ядра — ошибка раздела с машинным кодом ядра в тексте. */
  hold(body: LocalHoldBody): Promise<LocalHoldView>;
  release(): Promise<LocalReleaseReply>;
  /** Что удержано сейчас; ядро недоступно — `undefined`, а не исключение. */
  view(): Promise<LocalHoldView | undefined>;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCoreHold(
  home: () => string,
  identity: (port: number) => CoreIdentityDeps = createCoreIdentityDeps(),
): CoreHold {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const core = locateCore(home());
    if ('missing' in core)
      throw localError('local-core-unreachable', `ядро не найдено: ${core.missing}`, {
        reason: core.missing,
      });
    const proven = await verifyCore(core, identity(core.entry.port));
    if (!('value' in proven)) {
      const reason = `core entry not verified: ${'unknown' in proven ? proven.unknown : 'absent'}`;
      throw localError('local-core-unreachable', `ядро не отвечает: ${reason}`, { reason });
    }
    try {
      return await forwardToCore(core, { method, path, ...(body === undefined ? {} : { body }) });
    } catch (error) {
      const reason = reasonOf(error);
      throw localError('local-core-unreachable', `ядро не отвечает: ${reason}`, { reason });
    }
  }

  async function refusal(res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    let code = `http ${res.status}`;
    let reason = text.slice(0, 500);
    try {
      // Ошибка API ядра: машинный код в `code`, текст причины в `error`.
      const parsed = JSON.parse(text) as { error?: string; code?: string };
      code = parsed.code ?? code;
      reason = parsed.error ?? reason;
    } catch {
      // Не JSON — текст как есть.
    }
    throw localError('local-hold-refused', `ядро отказало (${code}): ${reason}`, { code, reason });
  }

  return {
    async hold(body) {
      const res = await call('POST', '/v1/local/hold', body);
      if (!res.ok) return refusal(res);
      return (await res.json()) as LocalHoldView;
    },
    async release() {
      const res = await call('POST', '/v1/local/release', {});
      if (!res.ok) return refusal(res);
      return (await res.json()) as LocalReleaseReply;
    },
    async view() {
      try {
        const res = await call('GET', '/v1/local/hold');
        return res.ok ? ((await res.json()) as LocalHoldView) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
