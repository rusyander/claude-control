import type {
  Platform,
  PlatformAgentAnswer,
  PlatformAgentMessage,
  PlatformAgentOutcome,
  PlatformAgentSession,
} from '@agentdeck/contracts';
import type { PlatformFetch } from './ca-fetch.ts';
import { foreignTail } from './redact.ts';
import { callUpstream, UpstreamError } from './gateway/upstream.ts';
import { driverOf } from './drivers/index.ts';
import type { DriverAgents } from './drivers/driver.ts';
import { agentsNotDeclared } from './errors.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Опубликованные агенты контура: спросить агента компании из панели.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Агент контура — не CLI и не собеседник с инструментами
 * панели: инструменты ему подбирает платформа, а свои объявить нечем
 * (`no-client-tools`). Панель здесь — клиент чужого агента, и всё, что ей
 * принадлежит, — не соврать про исход.
 *
 * СПИСКА АГЕНТОВ ПАНЕЛЬ ПОЛУЧИТЬ НЕОТКУДА: публичная поверхность ключа — семь
 * маршрутов, и «дай список агентов» среди них нет (справочник §2). Поэтому
 * агент адресуется идентификатором, который человек внёс сам, а проба про
 * агентов честно молчит («не объявлено»).
 *
 * ПЯТЬ ИСХОДОВ, А НЕ ДВА. «Агентов нет в лицензии компании» — это отсутствующая
 * возможность, и показывать её ошибкой значит послать человека чинить то, что
 * не ломалось. «Агент объявил ошибку» — исход, задуманный автором агента.
 * «Ключ отклонён», «запрос не принят» и «сторона контура» чинятся тремя разными
 * способами, и слипшееся «не получилось» не чинится никак.
 */
// compromise: agents-manual-roster — списка агентов у контура не спросить, идентификатор человек берёт в админке

/**
 * Сколько ждём ответа агента.
 *
 * Вызов агента НЕ потоковый — контур сам его так и не принимает
 * (`stream is not supported for agent completions`), — поэтому заголовки
 * приезжают вместе с готовым ответом, в конце прогона. Свой потолок прогона у
 * контура — 100 с плюс хвостовые записи, итого около 115 с; шестидесяти секунд,
 * которых хватает потоковому чату, здесь не хватило бы законному длинному
 * агенту, и панель рвала бы уже оплаченный прогон на середине.
 */
export const AGENT_TIMEOUT_MS = 125_000;

/** Сессии читаются и стираются мгновенно — ждать их столько же незачем. */
const SESSION_TIMEOUT_MS = 20_000;

export interface AskAgentOptions {
  platform: Platform;
  token: string;
  agentId: string;
  messages: PlatformAgentMessage[];
  /** Сессия контура: с ней историю ведёт он сам. */
  sessionId?: string;
  fetchImpl?: PlatformFetch;
  now?: () => Date;
}

export interface AgentSessionOptions {
  platform: Platform;
  token: string;
  sessionId: string;
  /** Сузить до одного агента: сессия на десяток агентов отдаёт всё разом. */
  agentId?: string;
  fetchImpl?: PlatformFetch;
}

/**
 * Пути агентов из манифеста драйвера. Тип контура их не объявил — отказ ДО
 * сети (`agents_not_declared`): это свойство типа, а не исход вызова.
 */
export function requireAgents(platform: Platform): DriverAgents {
  const agents = driverOf(platform).agents;
  if (!agents) throw agentsNotDeclared(platform.title);
  return agents;
}

/**
 * Спросить агента. Исход контура возвращает ЛЮБЫМ и не бросает: недоступный
 * агент — это карточка с причиной, а не сбой панели (инвариант 7). Бросает
 * только тип контура без агентов — до сети.
 */
export async function askAgent(options: AskAgentOptions): Promise<PlatformAgentAnswer> {
  const { platform, token, agentId, messages, sessionId } = options;
  const paths = requireAgents(platform);
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const base = { agentId, text: '', checkedAt, ...(sessionId ? { sessionId } : {}) };

  const invalid = validateMessages(messages, sessionId !== undefined);
  if (invalid) return { ...base, outcome: 'rejected', detail: invalid };

  let response: Response;
  try {
    response = await callUpstream({
      platform,
      token,
      path: paths.completions,
      // Тело ровно из тех полей, которые контур принимает. `model`,
      // `temperature`, `stream` и прочие привычки соседней ручки он отвергает
      // четырёхсотым: настройки модели задаёт автор агента, а не зовущий.
      body: JSON.stringify({
        agent: agentId,
        messages,
        ...(sessionId ? { session: sessionId } : {}),
      }),
      accept: 'application/json',
      headersTimeoutMs: AGENT_TIMEOUT_MS,
      // Повтора здесь нет намеренно, в отличие от чата: прогон агента — это
      // деньги ключа и запись в его истории. Ответ 502 не значит, что прогона
      // не было, и вторая попытка запустила бы и оплатила его заново.
      retry: false,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    return {
      ...base,
      outcome: 'failed',
      detail: error instanceof UpstreamError ? `${error.message}.` : String(error),
    };
  }

  const text = await readBody(response);
  const status = response.status;
  if (status >= 400) {
    return { ...base, status, ...describeRefusal(status, text, token) };
  }

  const payload = parseJson(text);
  if (!payload) {
    return {
      ...base,
      status,
      outcome: 'failed',
      detail: serverText('contour-agent-not-json'),
    };
  }

  const choice = firstChoice(payload);
  // Формы, в которой панель ждёт ответ, в теле нет вовсе. Это НЕ пустой ответ
  // агента: пустой ответ — это факт про агента, а промах разбора — про панель, и
  // выдать второе за первое значит отправить человека к автору агента чинить
  // то, что сломано здесь.
  if (!choice) {
    return {
      ...base,
      status,
      outcome: 'failed',
      detail: serverText('contour-agent-unknown-shape'),
    };
  }
  const answer = typeof choice.message?.content === 'string' ? choice.message.content : '';
  const recorded = payload.session_recorded;

  return {
    ...base,
    status,
    outcome: 'ok',
    text: answer,
    detail: serverText(answer ? 'contour-agent-answered' : 'contour-agent-empty'),
    ...(typeof choice.finish_reason === 'string' ? { finishReason: choice.finish_reason } : {}),
    // Признак сессии переносим только когда контур его прислал: своего мнения о
    // чужом хранилище у панели нет, а `false` по умолчанию читался бы как
    // «сессия не пополнилась» на каждом ответе без сессии вообще.
    ...(typeof recorded === 'boolean' ? { sessionRecorded: recorded } : {}),
  };
}

/**
 * Что помнит контур об этой сессии. Панель своей копии не держит: копия
 * разошлась бы с той историей, из которой агент на самом деле отвечает.
 */
export async function readAgentSession(
  options: AgentSessionOptions,
): Promise<PlatformAgentSession | { error: string }> {
  const query = options.agentId ? `?agent=${encodeURIComponent(options.agentId)}` : '';
  const result = await sessionRequest(options, 'GET', query);
  if ('error' in result) return result;

  const sessions = asArray(parseJson(result.text)?.sessions);
  const messages: PlatformAgentMessage[] = [];
  const agentIds: string[] = [];
  // Ходов у контура может быть БОЛЬШЕ, чем панель умеет показать: инструментные
  // ходы агента и многочастное содержимое ролей вне этого словаря сюда не
  // попадают. Считаем их отдельно — «контур помнит N реплик» обязано быть
  // числом КОНТУРА, иначе панель занижает чужую память и объявляет пустой
  // сессию, которая существует.
  let total = 0;
  for (const record of sessions) {
    const item = asRecord(record);
    const agent = typeof item.agent_id === 'string' ? item.agent_id : '';
    if (agent && !agentIds.includes(agent)) agentIds.push(agent);
    const turns = asArray(item.messages);
    total += turns.length;
    for (const raw of turns) {
      const message = asRecord(raw);
      const role = message.role;
      const content = message.content;
      if (typeof content !== 'string') continue;
      if (role !== 'user' && role !== 'assistant' && role !== 'system') continue;
      messages.push({ role, content });
    }
  }

  return {
    sessionId: options.sessionId,
    agentIds,
    messages,
    total,
    empty: total === 0,
  };
}

/**
 * Забыть переписку сессии. У контура это идемпотентно: стирать было нечего —
 * тоже успех.
 *
 * Агент передаётся тем же параметром, что и при чтении: сессию могут делить
 * несколько агентов, и молча стереть её целиком вместо одной ветки значило бы
 * забрать у человека то, о чём он не просил.
 */
export async function resetAgentSession(
  options: AgentSessionOptions,
): Promise<{ ok: true } | { error: string }> {
  const query = options.agentId ? `?agent=${encodeURIComponent(options.agentId)}` : '';
  const result = await sessionRequest(options, 'DELETE', query);
  return 'error' in result ? result : { ok: true };
}

/** Один запрос к сессиям: общий разбор отказа у чтения и сброса. */
async function sessionRequest(
  options: AgentSessionOptions,
  method: string,
  query: string,
): Promise<{ text: string } | { error: string }> {
  const paths = requireAgents(options.platform);
  let response: Response;
  try {
    response = await callUpstream({
      platform: options.platform,
      token: options.token,
      path: `${paths.sessions}/${encodeURIComponent(options.sessionId)}${query}`,
      method,
      accept: 'application/json',
      headersTimeoutMs: SESSION_TIMEOUT_MS,
      retry: false,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    return { error: error instanceof UpstreamError ? `${error.message}.` : String(error) };
  }

  const text = await readBody(response);
  if (response.status >= 400) {
    // Тексты `describeRefusal` написаны про АГЕНТА, и на маршруте сессий два из
    // них соврали бы: 404 здесь — про сессию, а не про идентификатор агента в
    // админке, а 422 про «завершение агента» тут не значит ничего.
    //
    // 404 вообще не отказ: у чтения это «контур такой сессии не помнит» (пустая
    // переписка — честный ответ, а не ошибка сети), у сброса — обещанная
    // идемпотентность, «стирать было нечего».
    if (response.status === 404) return { text: '' };
    if (response.status === 422) {
      return { error: serverText('contour-agent-session-rejected') };
    }
    const refusal = describeRefusal(response.status, text, options.token);
    return { error: refusal.detail };
  }
  return { text };
}

/**
 * Отказ контура словами. Разбирается по КОДУ и по коду ошибки в теле, а не по
 * тексту: тексты чужие и меняются, а `module_not_licensed` — договор.
 */
function describeRefusal(
  status: number,
  body: string,
  token: string,
): { outcome: PlatformAgentOutcome; detail: string } {
  const payload = parseJson(body);
  // Конвертов два: лицензионный гейт отвечает плоским {error, message}, сами
  // агентские ручки — OpenAI-совместимым {error:{message,type,code}}.
  const flat = typeof payload?.error === 'string' ? payload.error : '';
  const nested = asRecord(payload?.error);
  const message = pickString(nested.message) || pickString(payload?.message);
  const code = pickString(nested.code) || flat;
  const detail = foreignTail(message || body, token);
  // Слова контура вкладываются в нашу фразу, а не приклеиваются: вложенный
  // текст клиент переводит своим словарём, чужой остаётся как есть.
  const said = (message: string): string =>
    detail ? serverText('contour-agent-said', { message, detail }) : message;

  if (code === 'module_not_licensed') {
    return {
      outcome: 'unavailable',
      detail: serverText('contour-agent-no-license'),
    };
  }
  if (code === 'license_inactive') {
    return {
      outcome: 'unavailable',
      detail: serverText('contour-agent-license-inactive'),
    };
  }
  if (code === 'license_check_failed' || status === 503) {
    return {
      outcome: 'not-ready',
      detail: serverText('contour-agent-license-unchecked'),
    };
  }
  if (status === 401) {
    // Отозванный ключ и ключ с кончившимся бюджетом контур отдаёт ОДНИМ кодом
    // (обе причины сходятся в его проверке ключа): называем обе причины.
    return {
      outcome: 'unauthorized',
      detail: said(serverText('contour-agent-key-rejected')),
    };
  }
  if (status === 403) {
    return {
      outcome: 'unauthorized',
      detail: said(serverText('contour-agent-key-forbidden')),
    };
  }
  if (status === 402) {
    // На маршруте агентов контура 402 — бюджет ключа.
    return {
      outcome: 'rejected',
      detail: said(serverText('contour-agent-key-budget')),
    };
  }
  if (status === 404) {
    return {
      outcome: 'rejected',
      detail: said(serverText('contour-agent-not-found')),
    };
  }
  if (status === 422) {
    // Объявленное автором завершение с ошибкой: запрос верный, исход такой.
    return { outcome: 'agent-error', detail: said(serverText('contour-agent-failed')) };
  }
  if (status === 429) {
    return { outcome: 'not-ready', detail: said(serverText('contour-agent-rate-limited')) };
  }
  if (status >= 500) {
    return {
      outcome: 'not-ready',
      detail: said(serverText('contour-agent-status', { status })),
    };
  }
  return { outcome: 'rejected', detail: said(serverText('contour-agent-rejected', { status })) };
}

/**
 * Правила тела, которые контур проверяет сам, — но его отказ приезжает
 * по-английски и стоит целого похода по сети. Проверяем ровно те, что он
 * называет: последний ход — вопрос человека, а с сессией `system` не живёт.
 */
function validateMessages(messages: PlatformAgentMessage[], withSession: boolean): string {
  if (messages.length === 0) return serverText('contour-agent-nothing-to-ask');
  if (messages[messages.length - 1]?.role !== 'user') {
    return serverText('contour-agent-last-must-be-question');
  }
  if (withSession && messages.some((message) => message.role === 'system')) {
    // Историю в сессии ведёт контур, а ролей у неё две: со второго хода
    // инструкция просто исчезла бы, и человек этого не увидел бы.
    return serverText('contour-agent-no-system-with-session');
  }
  return '';
}

function firstChoice(
  payload: Record<string, unknown>,
): { message?: { content?: unknown }; finish_reason?: unknown } | undefined {
  const choices = asArray(payload.choices);
  return choices.length > 0
    ? (asRecord(choices[0]) as { message?: { content?: unknown }; finish_reason?: unknown })
    : undefined;
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pickString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
