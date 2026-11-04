import type { AskFields } from '@agentdeck/contracts/core/ask';
import type { AssistantRunResult } from '@agentdeck/contracts';
import { SECRET_MASK, maskSecretsInText, restoreMaskedSecrets } from '@agentdeck/dlp/secret-mask';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import {
  localizeText,
  serverText,
  type ServerTextCode,
  type TextParams,
} from '../../lib/server-texts/server-texts.ts';
import { getActiveProvider, getProvider } from '../../providers/registry.ts';
import { resolvePanelAgentRoute } from '../panel-agent/route/route.ts';
import { runCoreAsk } from './core-ask.ts';
import type {
  AskCarryOutcome,
  CoreAskOutcome,
  CoreAskPort,
  OneShotMessage,
  OneShotRequest,
  OneShotResult,
} from './core-ask.types.ts';

/**
 * Служебный вопрос модели через ядро (этап 10, F2b): окно помощника формы и структуры ресурса,
 * `/api/assistant/run`, вызов модели групп, проверка провайдера. Своего процесса CLI, прямого
 * вызова API вендора и сессии `opencode serve` у панели больше нет: ход — сессия ядра «ask»
 * без инструментов (`tools: 'none'`), маршрут — тот же, что у агента панели
 * (`resolvePanelAgentRoute`: активный CLI, профиль «Ассистент панели», контур), суд маршрута,
 * ключ и DLP — у ядра.
 *
 * Без инструментов ядро пускает только CLI, у которых умеет снять встроенные целиком
 * (`toolsNone` переходника); прочим ядро отказывает с причиной, и она доходит до человека
 * дословно. CLI без судьи ядра вовсе (`NO_GATE_CLIS`) получают отказ панели до ядра: задачу,
 * которую ядро заведомо не исполнит, заводить незачем.
 */

/**
 * CLI, которым служебный вопрос не доверить: у Aider и Continue нет хука ядра вовсе
 * (`adapters/gateless.ts`), у Gemini CLI и Cursor — нет отказа встроенному инструменту на
 * каждом вызове (у Gemini только файл политики), так что «без инструментов» ничем не держится.
 */
export const NO_GATE_CLIS: ReadonlySet<string> = new Set(['gemini', 'cursor', 'aider', 'continue']);

/** Сколько ждать ответа по умолчанию — прежний потолок одноразового CLI (180 с). */
export const ONE_SHOT_TIMEOUT_MS = 180_000;
/** Текст потолка ожидания: по нему вызывающие (опись групп) отличают «не успел» от сбоя. */
export const ONE_SHOT_TIMEOUT_TEXT = 'Помощник не ответил за отведённое время';

/**
 * Хэши коммитов и содержимого окну ассистента и группам нужны как есть (ревью F6): без имени
 * рядом это не секрет, а под секретным именем их ловят именные правила.
 */
const RUNNER_MASK = { keepHashes: true } as const;

/** Собрать один текст из истории: у вопроса ядра одно слово модели первым ходом. */
export function flattenPrompt(messages: readonly OneShotMessage[]): string {
  return messages
    .map((m) => (m.role === 'assistant' ? `Assistant: ${m.content}` : m.content))
    .join('\n\n')
    .trim();
}

function refusal(
  store: AppStore,
  providerId: string,
  reason: 'unsupported' | 'refused' | 'failed',
  code: ServerTextCode,
  params: TextParams,
): OneShotResult {
  const language = store.getSettings().language === 'en' ? 'en' : 'ru';
  return {
    ok: false,
    providerId,
    reason,
    error: localizeText(serverText(code, params), language),
    messageCode: code,
    params,
  };
}

/**
 * Один служебный вопрос. Промпт уже под маской, если вызывающий маскирует сам (окно формы,
 * структура); `askMasked` ниже маскирует за тех, кто шлёт сырые реплики.
 */
export async function askOneShot(
  port: CoreAskPort,
  store: AppStore,
  appDataDir: string,
  request: OneShotRequest,
): Promise<OneShotResult> {
  const provider = request.adapter ? getProvider(request.adapter) : getActiveProvider(store);
  if (NO_GATE_CLIS.has(provider.id)) {
    return refusal(store, provider.id, 'unsupported', 'assistant-provider-unsupported', {
      provider: provider.name,
    });
  }
  const route = request.adapter
    ? ({ ok: true, fields: { adapter: provider.id, consumer: 'assistant' } } as const)
    : resolvePanelAgentRoute(store, appDataDir);
  if (!route.ok) {
    return refusal(store, provider.id, 'refused', 'assistant-route-refused', {
      reason: route.message,
    });
  }
  // Набор панели — по CLI и маршрутам ЭТОГО хода (локальный контур решает вариант набора);
  // не собрался — отказ: ход без набора ушёл бы на чужой слой вопреки режиму.
  const carried: AskCarryOutcome = request.carry?.({
    cli: provider.id,
    routes: 'routes' in route.fields ? route.fields.routes : undefined,
  }) ?? { ok: true };
  if (!carried.ok) {
    return refusal(store, provider.id, 'refused', 'assistant-route-refused', {
      reason: carried.reason,
    });
  }
  const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
  const images = lastUser?.images ?? [];
  const fields: AskFields = {
    title: request.title,
    prompt: flattenPrompt(request.messages),
    tools: 'none',
    ...(request.system ? { system: request.system } : {}),
    ...(images.length > 0 ? { images: [...images] } : {}),
    ...route.fields,
    // Дешёвая ступень вызывающего главнее модели профиля: группам хватает младшей.
    ...(request.model ? { model: request.model } : {}),
    ...(carried.session ? { session: carried.session } : {}),
  };
  const run = runCoreAsk(port, fields, () => undefined, {
    ...(carried.env ? { env: carried.env } : {}),
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    run.stop();
  }, request.timeoutMs ?? ONE_SHOT_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = (): void => run.stop();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const outcome = await run.done;
    if (outcome.ok) return { ok: true, providerId: provider.id, reply: outcome.reply };
    return failureOf(store, provider.id, outcome, timedOut);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
  }
}

function failureOf(
  store: AppStore,
  providerId: string,
  outcome: CoreAskOutcome,
  timedOut: boolean,
): OneShotResult {
  const detail = outcome.error ?? 'no answer';
  switch (outcome.code) {
    case 'extra-tool':
      return refusal(store, providerId, 'failed', 'assistant-extra-tool', { tool: detail });
    case 'stopped':
      if (timedOut) {
        return {
          ok: false,
          providerId,
          reason: 'failed',
          error: ONE_SHOT_TIMEOUT_TEXT,
          messageCode: 'assistant-timeout',
        };
      }
      return { ok: false, providerId, reason: 'failed', error: 'stopped' };
    case 'session-error':
    case 'stream-broke':
    case 'no-answer':
      // Слова CLI об ошибке хода — дословно (отказ модели, HTTP 400), как у агента панели.
      return { ok: false, providerId, reason: 'failed', error: detail };
    default:
      // Отказ ядра до хода: 422 `ask-refused` с проблемами, отказ дороги без сессии
      // (`tools-none-unsupported`), ядро не запущено — причина дословно под кодом окна.
      return refusal(store, providerId, 'refused', 'assistant-route-refused', { reason: detail });
  }
}

/**
 * Вопрос по сырым репликам: секреты под маской до ядра (детектор общий с агентом панели и
 * помощником формы), маска в ответе возвращается секретом только в строке, слово в слово
 * равной прочитанной; в новом месте она остаётся маской.
 */
export async function askMasked(
  port: CoreAskPort,
  store: AppStore,
  appDataDir: string,
  request: OneShotRequest,
): Promise<OneShotResult> {
  const masked = request.messages.map((message) => ({
    ...message,
    content: maskSecretsInText(message.content, RUNNER_MASK),
  }));
  const result = await askOneShot(port, store, appDataDir, { ...request, messages: masked });
  if (!result.ok || !result.reply.includes(SECRET_MASK)) return result;
  const saved = request.messages.map((message) => message.content).join('\n');
  return {
    ...result,
    reply: restoreMaskedSecrets(saved, result.reply, RUNNER_MASK) ?? result.reply,
  };
}

/** Исход вопроса в форме ответа `/api/assistant/run` (контракт окна ассистента). */
export function assistantRunResultOf(result: OneShotResult): AssistantRunResult {
  if (result.ok) {
    return {
      ok: true,
      providerId: result.providerId,
      mode: 'cli',
      reply: result.reply,
      experimental: false,
      reason: 'ok',
      transport: 'one-shot',
    };
  }
  return {
    ok: false,
    providerId: result.providerId,
    mode: result.reason === 'unsupported' ? 'none' : 'cli',
    reply: '',
    experimental: false,
    reason: result.reason === 'unsupported' ? 'unsupported' : 'cli_error',
    error: result.error,
  };
}
