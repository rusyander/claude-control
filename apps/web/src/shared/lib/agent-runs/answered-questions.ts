import { emit } from './agent-runs.state';

const KEY = 'claude-control:answered-questions';

/**
 * Сколько отвеченных вопросов помним. Двухсот хватает на любую живую переписку,
 * а расти без конца этому списку незачем: старые карточки давно уехали за
 * пределы окна ленты и переспросить их нельзя.
 */
const LIMIT = 200;

/**
 * Память об отвеченных вопросах — общая для всей панели.
 *
 * Регрессия, ради которой она заведена: «отправлено» жило в состоянии самой
 * карточки. Ответил ребёнку, ушёл на другую вкладку, вернулся — карточка
 * смонтирована заново и снова выглядит неотвеченной, а источник вопроса
 * продолжает его отдавать (пока прогон ребёнка жив, это тот же последний
 * `AskUserQuestion`). Второй ответ — это второй ход агента и лишние деньги.
 *
 * Ключ вопроса даёт тот, кто его показывает: у чужого вопроса это `toolUseId`
 * вызова, у своего — сообщение и номер блока в нём (`<id сообщения>#<блок>`),
 * потому что в транскрипте у блока собственного идентификатора нет.
 *
 * Список переживает и перезагрузку страницы: вопрос, на который ответили,
 * остаётся в транскрипте, и после F5 карточка иначе снова выглядела бы живой.
 */
let answered: string[] = load();
let known = new Set(answered);

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(answered));
  } catch {
    // Хранилище недоступно — память живёт до перезагрузки, как и раньше.
  }
}

/** Снимок для `useSyncExternalStore`: ссылка меняется только вместе с составом. */
export function getAnsweredQuestions(): ReadonlySet<string> {
  return known;
}

/** Ответ на этот вопрос уже ушёл — карточка рисуется отправленной. */
export function markQuestionAnswered(key: string | undefined): void {
  if (!key || known.has(key)) return;
  answered = [...answered, key].slice(-LIMIT);
  known = new Set(answered);
  save();
  emit();
}
