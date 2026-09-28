import type { InboxAsk, InboxChat } from '@agentdeck/contracts/chat-inbox';

/**
 * Карточка вопросов ОДНОГО чата: по одному вопросу за раз.
 *
 * Ответ на текущий вопрос сворачивает его в строку с выбранным и открывает
 * следующий; после последнего — одна кнопка «Отправить» на весь чат. Так же,
 * как карточка вопросов в панели: каждое сообщение — это ход агента, и ответ
 * на вопрос с вариантами обязан уехать ОДНИМ сообщением, иначе агент отвечал
 * бы на первый вопрос, ничего не зная про остальные. Решения по правам уходят
 * тем же нажатием — отдельными запросами, но из той же карточки: человек
 * отвечает «за чат», а не за каждый запрос порознь.
 *
 * Состояние — чистые данные: сервер опрашивается каждые несколько секунд, и
 * вопросы между опросами приходят и уходят. `reconcile` сводит выбранное с
 * тем, что сервер отдаёт сейчас.
 */

export type AskAnswer =
  | { kind: 'permission'; behavior: 'allow' | 'deny' }
  | { kind: 'branchGate'; choice: 'here' | 'stop' }
  | { kind: 'question'; labels: string[] };

export interface CardState {
  /** Готовые ответы по `ask.key`. */
  answers: { [key: string]: AskAnswer };
  /** Вопрос, к которому вернулись кнопкой «Изменить». */
  editing?: string;
}

export const EMPTY_CARD: CardState = { answers: {} };

export interface CardView {
  /** Отвеченные — свёрнутыми строками, в порядке вопросов. */
  done: { ask: InboxAsk; answer: AskAnswer }[];
  /** Тот, что спрашиваем сейчас. Нет — отвечено всё. */
  current?: InboxAsk;
  /** Ещё не дошли. */
  upcoming: InboxAsk[];
  /** Всё отвечено — можно отправлять. */
  ready: boolean;
  /** Номер текущего (с единицы) и сколько всего. */
  step: number;
  total: number;
}

export function cardView(asks: readonly InboxAsk[], state: CardState): CardView {
  const editing = asks.find((ask) => ask.key === state.editing);
  const pending = asks.find((ask) => !state.answers[ask.key]);
  const current = editing ?? pending;
  const done: CardView['done'] = [];
  const upcoming: InboxAsk[] = [];
  for (const ask of asks) {
    if (ask === current) continue;
    const answer = state.answers[ask.key];
    if (answer) done.push({ ask, answer });
    else upcoming.push(ask);
  }
  return {
    done,
    ...(current ? { current } : {}),
    upcoming,
    ready: asks.length > 0 && !pending && !editing,
    step: current ? asks.indexOf(current) + 1 : asks.length,
    total: asks.length,
  };
}

/** Ответить на вопрос: он сворачивается, открывается следующий. */
export function answerAsk(state: CardState, key: string, answer: AskAnswer): CardState {
  const { editing: _editing, ...rest } = state;
  return { ...rest, answers: { ...state.answers, [key]: answer } };
}

/** Вернуться к уже отвеченному. */
export function editAsk(state: CardState, key: string): CardState {
  return { ...state, editing: key };
}

/**
 * Свести выбранное с ответом сервера. Вопрос исчез (ответили за компьютером,
 * прогон остановлен) — его ответ забывается, текущим становится следующий.
 * Пришёл новый — встаёт в конец и ждёт своей очереди, не перебивая текущий.
 * Ничего не изменилось — тот же объект: перерисовывать нечего.
 */
export function reconcile(state: CardState, asks: readonly InboxAsk[]): CardState {
  const live = new Set(asks.map((ask) => ask.key));
  const stale = Object.keys(state.answers).filter((key) => !live.has(key));
  const editingGone = state.editing !== undefined && !live.has(state.editing);
  if (stale.length === 0 && !editingGone) return state;
  const answers = { ...state.answers };
  for (const key of stale) delete answers[key];
  return editingGone ? { answers } : { ...state, answers };
}

/**
 * Ответ на вопросы одного вызова `AskUserQuestion` — одним текстом, как у
 * панели (`composeAnswer` окна чата): один вопрос — просто выбранное, несколько
 * — строкой «заголовок: выбранное» на вопрос.
 */
export function composeAnswer(
  asks: readonly Extract<InboxAsk, { kind: 'question' }>[],
  answers: CardState['answers'],
): string {
  const picked = asks.map((ask) => {
    const answer = answers[ask.key];
    return answer?.kind === 'question' ? answer.labels : [];
  });
  if (asks.length === 1) return (picked[0] ?? []).join(', ');
  return asks
    .map((ask, at) => {
      const chosen = picked[at] ?? [];
      if (chosen.length === 0) return '';
      const title = ask.question.header || ask.question.question || String(ask.index + 1);
      return `${title}: ${chosen.join(', ')}`;
    })
    .filter(Boolean)
    .join('\n');
}

export type Submission =
  | {
      kind: 'permission';
      runKey: string;
      toolUseId: string;
      behavior: 'allow' | 'deny';
      keys: string[];
    }
  | {
      kind: 'branchGate';
      runKey: string;
      toolUseId: string;
      choice: 'here' | 'stop';
      keys: string[];
    }
  | { kind: 'message'; text: string; keys: string[] };

/**
 * Что отправить по нажатию «Отправить». Решения по правам — первыми: за ними
 * стоит живой процесс, который ждёт. Ответ на вопросы — последним и одним
 * сообщением: если агент ещё работает, оно встанет в очередь и уйдёт по концу
 * хода, как в панели.
 */
export function planSubmissions(
  chat: Pick<InboxChat, 'runKey'>,
  asks: readonly InboxAsk[],
  state: CardState,
): Submission[] {
  const out: Submission[] = [];
  const questions: Extract<InboxAsk, { kind: 'question' }>[] = [];
  for (const ask of asks) {
    const answer = state.answers[ask.key];
    if (!answer) continue;
    if (ask.kind === 'question') {
      questions.push(ask);
      continue;
    }
    if (!chat.runKey) continue;
    if (ask.kind === 'permission' && answer.kind === 'permission') {
      out.push({
        kind: 'permission',
        runKey: chat.runKey,
        toolUseId: ask.toolUseId,
        behavior: answer.behavior,
        keys: [ask.key],
      });
    }
    if (ask.kind === 'branchGate' && answer.kind === 'branchGate') {
      out.push({
        kind: 'branchGate',
        runKey: chat.runKey,
        toolUseId: ask.toolUseId,
        choice: answer.choice,
        keys: [ask.key],
      });
    }
  }
  const text = composeAnswer(questions, state.answers);
  if (text) out.push({ kind: 'message', text, keys: questions.map((ask) => ask.key) });
  return out;
}

export interface SubmitDeps {
  post: (path: string, body: unknown) => Promise<unknown>;
  /** Сообщение в разговор. Ложь — не принято (текст причины рядом). */
  sendMessage: (text: string) => Promise<{ ok: boolean; message?: string }>;
}

export interface SubmitOutcome {
  /** Ключи, чьи ответы ушли, — карточка их больше не показывает. */
  sentKeys: string[];
  error?: string;
}

/**
 * Отправить по порядку и остановиться на первом отказе. Ушедшее запоминается:
 * повтор после ошибки шлёт только оставшееся, а не второе «разрешить» и не
 * второе сообщение — второе сообщение было бы вторым ходом агента.
 */
export async function submitAll(
  submissions: readonly Submission[],
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const sentKeys: string[] = [];
  for (const item of submissions) {
    try {
      if (item.kind === 'permission') {
        // `ok: false` — запрос уже снят (решили за компьютером): ответ не нужен.
        await deps.post(`/chat/${encodeURIComponent(item.runKey)}/permission-decision`, {
          toolUseId: item.toolUseId,
          behavior: item.behavior,
        });
      } else if (item.kind === 'branchGate') {
        await deps.post(`/chat/${encodeURIComponent(item.runKey)}/branch-decision`, {
          toolUseId: item.toolUseId,
          choice: item.choice,
        });
      } else {
        const outcome = await deps.sendMessage(item.text);
        if (!outcome.ok) return { sentKeys, error: outcome.message ?? '' };
      }
    } catch (error) {
      return { sentKeys, error: error instanceof Error ? error.message : String(error) };
    }
    sentKeys.push(...item.keys);
  }
  return { sentKeys };
}
