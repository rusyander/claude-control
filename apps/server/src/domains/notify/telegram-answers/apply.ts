import type { InboxQuestion } from '@agentdeck/contracts/chat-inbox';
import type { AskTarget, ApplyOutcome } from './telegram-answers.types.ts';

/**
 * Ответ из Telegram уходит ТЕМ ЖЕ маршрутом панели, что и нажатие в окне или на
 * телефоне, — запросом внутри процесса (`app.inject`). Своего пути к брокеру
 * прав нет намеренно: все проверки маршрута (истёкший запрос, ворота ветки,
 * группа на паузе, очередь занятого разговора) работают и здесь, и второй путь
 * не разойдётся с первым.
 */

export interface InjectRequest {
  method: 'POST' | 'GET';
  url: string;
  payload?: Record<string, unknown>;
}
export interface InjectReply {
  statusCode: number;
  body: string;
}
export type Inject = (request: InjectRequest) => Promise<InjectReply>;

export type Answer =
  | { kind: 'decision'; behavior: 'allow' | 'deny' }
  | { kind: 'branch'; choice: 'here' | 'stop' }
  | { kind: 'questions'; questions: readonly InboxQuestion[]; picks: readonly string[][] };

/** Параметры прошлого хода разговора — ответ на вопрос продолжает его с ними же. */
export interface RunParams {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

export interface ApplyDeps {
  inject: Inject;
  /** Параметры последнего хода по ключам разговора. */
  runParams: (keys: readonly string[]) => RunParams | undefined;
  /** Сколько ждать ответа маршрута отправки: новый ход отвечает потоком до конца. */
  sendWaitMs?: number;
  /** Метка отправки — повтор той же метки маршрут узнаёт и второй раз не шлёт. */
  clientId: string;
}

/**
 * Текст ответа на вопросы — в той же форме, что у телефона (`composeAnswer`):
 * один вопрос — выбранное через запятую; несколько — «заголовок: выбранное»
 * строкой на вопрос.
 */
export function answerText(
  questions: readonly InboxQuestion[],
  picks: readonly string[][],
): string {
  if (questions.length <= 1) return (picks[0] ?? []).join(', ');
  return questions
    .map((question, at) => {
      const chosen = picks[at] ?? [];
      if (chosen.length === 0) return '';
      return `${question.header || question.question || String(at + 1)}: ${chosen.join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
}

function parseBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Понятная строка отказа маршрута — его же текст, без тела целиком. */
function refusal(reply: InjectReply): string {
  const body = parseBody(reply.body);
  const text = [body.message, body.error].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  return `${reply.statusCode}${text ? ` ${text.slice(0, 200)}` : ''}`;
}

/** 404 самого Fastify — маршрута нет вовсе (а не «вопроса уже нет»). */
function routeMissing(reply: InjectReply): boolean {
  if (reply.statusCode !== 404) return false;
  const message = parseBody(reply.body).message;
  return typeof message === 'string' && /^Route .+ not found$/.test(message);
}

function outcomeOf(reply: InjectReply, goneCodes: readonly number[]): ApplyOutcome {
  if (routeMissing(reply)) return { ok: false, detail: `маршрут не найден (${reply.statusCode})` };
  if (goneCodes.includes(reply.statusCode)) return { ok: false, gone: true };
  if (reply.statusCode >= 300) return { ok: false, detail: refusal(reply) };
  // `permission-decision` отвечает `{ok:false}`, когда такого запроса у разговора нет.
  if (parseBody(reply.body).ok === false) return { ok: false, gone: true };
  return { ok: true };
}

const enc = encodeURIComponent;

export async function applyAnswer(
  target: AskTarget,
  answer: Answer,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  const post = (url: string, payload: Record<string, unknown>) =>
    deps.inject({ method: 'POST', url, payload });
  switch (target.kind) {
    case 'permission': {
      if (answer.kind !== 'decision') return { ok: false, detail: 'не то решение' };
      const reply = await post(`/api/chat/${enc(target.runKey)}/permission-decision`, {
        toolUseId: target.toolUseId,
        behavior: answer.behavior,
      });
      return outcomeOf(reply, [404, 409, 410]);
    }
    case 'branchGate': {
      if (answer.kind !== 'branch') return { ok: false, detail: 'не то решение' };
      const reply = await post(`/api/chat/${enc(target.runKey)}/branch-decision`, {
        toolUseId: target.toolUseId,
        choice: answer.choice,
      });
      return outcomeOf(reply, [404, 409, 410]);
    }
    case 'relayPermission': {
      if (answer.kind !== 'decision') return { ok: false, detail: 'не то решение' };
      const reply = await post(`/api/outside/asks/${enc(target.toolUseId)}/answer`, {
        behavior: answer.behavior,
      });
      return outcomeOf(reply, [404, 409]);
    }
    case 'relayQuestion': {
      if (answer.kind !== 'questions') return { ok: false, detail: 'не то решение' };
      const answers: Record<string, string> = {};
      answer.questions.forEach((question, at) => {
        const chosen = answer.picks[at] ?? [];
        if (chosen.length) answers[question.question] = chosen.join(', ');
      });
      const reply = await post(`/api/outside/asks/${enc(target.toolUseId)}/answer`, { answers });
      return outcomeOf(reply, [404, 409]);
    }
    case 'foreign': {
      if (answer.kind !== 'decision') return { ok: false, detail: 'не то решение' };
      const reply = await post(
        `/api/provider-chat/chats/${enc(target.chatId)}/permissions/${enc(target.askId)}`,
        { decision: answer.behavior },
      );
      return outcomeOf(reply, [404]);
    }
    case 'deferred': {
      if (answer.kind !== 'decision') return { ok: false, detail: 'не то решение' };
      const reply = await post(`/api/chat/deferred/${enc(target.id)}/decision`, {
        behavior: answer.behavior,
        // Откуда ответили — подпись в списке D-n, а не право: решает маршрут.
        via: 'telegram',
      });
      const outcome = outcomeOf(reply, [404, 409, 410]);
      // Повтор решения маршрут принимает (200), но ничего не меняет: D-n уже решили
      // в окне или на телефоне. «Принято» и «✅ Разрешено» поверх чужого «нет»
      // солгали бы человеку — нажатие ни на что не повлияло, итог берётся из записи
      // (холодное ревью 23.10, D-L03).
      if (outcome.ok && parseBody(reply.body).changed === false) return { ok: false, gone: true };
      return outcome;
    }
    case 'question': {
      if (answer.kind !== 'questions') return { ok: false, detail: 'не то решение' };
      return sendAnswer(target, answerText(answer.questions, answer.picks), deps);
    }
  }
}

/**
 * Ответ на вопрос — следующим сообщением в разговор, как с телефона: идёт ход —
 * словом посреди хода (или в очередь до его конца), не идёт — новым ходом с
 * прежними моделью, усилием и правами. Новый ход отвечает потоком до самого
 * конца, поэтому ждём недолго: молчание маршрута — ход начался.
 */
async function sendAnswer(
  target: Extract<AskTarget, { kind: 'question' }>,
  text: string,
  deps: ApplyDeps,
): Promise<ApplyOutcome> {
  if (!text.trim()) return { ok: false, detail: 'пустой ответ' };
  const keys = [target.runKey, target.chatId, target.sessionId].filter((key): key is string =>
    Boolean(key),
  );
  const params = deps.runParams(keys);
  const mode = params?.permissionMode;
  const payload: Record<string, unknown> = {
    chatId: target.runKey ?? target.chatId,
    prompt: text,
    ...(target.sessionId ? { sessionId: target.sessionId } : {}),
    projectPath: target.projectPath,
    steer: true,
    queueIfBusy: true,
    clientId: deps.clientId,
    allowEdits: mode !== 'default' && mode !== 'plan',
    fullAccess: mode === 'bypassPermissions',
    ...(params?.model ? { model: params.model } : {}),
    ...(params?.effort ? { effort: params.effort } : {}),
  };
  const sent = deps.inject({ method: 'POST', url: '/api/chat/send', payload });
  const waited = await Promise.race([
    sent,
    new Promise<'streaming'>((resolve) => {
      const timer = setTimeout(() => resolve('streaming'), deps.sendWaitMs ?? 4_000);
      timer.unref?.();
    }),
  ]);
  if (waited === 'streaming') {
    // Ход идёт и пишет поток — ответ принят. Итог потока не нужен, но отказ в
    // нём не должен стать необработанным.
    sent.catch(() => undefined);
    return { ok: true };
  }
  return outcomeOf(waited, []);
}
