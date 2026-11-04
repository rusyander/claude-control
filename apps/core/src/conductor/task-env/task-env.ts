import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import { PANEL_SESSION_ENV } from '@agentdeck/contracts/core/session-carry';
import { isChatScenario } from '../estimate/placement.ts';

/**
 * Окружение задачи от вызывающего (этап 10, F6): то, что прежний исполнитель панели передавал
 * своему CLI сам (`ChatRun.start({env})`), — каталог конфигурации песочницы, секреты стенда
 * прогона тестов. ИМЕНА ложатся в `task.created.session.env`, ЗНАЧЕНИЯ живут только в этой книге,
 * в памяти ядра от оценки до конца задачи: ни журнала, ни `state.json`, ни логов. Дорога кладёт
 * их в пин сеанса и отмечает в книге ключей (маска `known`). Перезапуск ядра книгу теряет —
 * сеанс без значений отказан по именам (`stepStart`), а не запущен на окружении ядра: песочница
 * на настоящем `CLAUDE_CONFIG_DIR` человека правила проверила бы не те.
 */

export interface TaskEnvBook {
  put(taskId: string, values: Readonly<Record<string, string>>): void;
  get(taskId: string): Readonly<Record<string, string>> | undefined;
  drop(taskId: string): void;
  /** Для проверки «значения не пережили задачу»: сколько задач ещё держит книга. */
  size(): number;
}

export function createTaskEnvBook(): TaskEnvBook {
  const book = new Map<string, Readonly<Record<string, string>>>();
  return {
    put: (taskId, values) => void book.set(taskId, { ...values }),
    get: (taskId) => book.get(taskId),
    drop: (taskId) => void book.delete(taskId),
    size: () => book.size,
  };
}

/**
 * Имена, которые держит само ядро: PATH и дом ОС собирает дорога (обёртки, оболочка входа), свои
 * переменные `AGENTDECK_*` — мост и токен сеанса. Подмена вызывающим сломала бы границы сеанса.
 * Исключение — переменные панели (`PANEL_SESSION_ENV`, G6): их читают хуки набора и блока
 * «Тесты», ядро их не читает и своих с такими именами не ставит.
 */
const CORE_OWNED =
  /^(PATH|PATHEXT|SystemRoot|SYSTEMROOT|windir|ComSpec|NODE_OPTIONS|AGENTDECK_.*)$/i;

const coreOwned = (name: string): boolean =>
  CORE_OWNED.test(name) && !(PANEL_SESSION_ENV as readonly string[]).includes(name);

/**
 * Имена `session.env` против значений тела: у каждого имени значение, у каждого значения имя, и
 * ни одной переменной ядра. Один суд для оценки и для вопроса `ask` (G13).
 */
export function envNamesProblems(
  names: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = [];
  const given = Object.keys(values);
  const missing = names.filter((n) => !(n in values));
  const extra = given.filter((n) => !names.includes(n));
  if (missing.length > 0) out.push(`session.env: no value for ${missing.join(', ')}`);
  if (extra.length > 0) out.push(`env: ${extra.join(', ')} not named in session.env`);
  const owned = names.filter(coreOwned);
  if (owned.length > 0) out.push(`session.env: ${owned.join(', ')} are set by the core itself`);
  return out;
}

/** Почему настройки сеанса негодны; пусто — годны (или их нет). */
export function sessionProblems(body: Pick<EstimateBody, 'fields' | 'env'>): string[] {
  const session = body.fields.session;
  const values = body.env ?? {};
  const given = Object.keys(values);
  if (!session) {
    return given.length > 0 ? ['env: values without fields.session.env names'] : [];
  }
  const out: string[] = [];
  if (!isChatScenario(body.fields.scenario)) {
    out.push('session: only the chat scenario takes session settings');
  }
  out.push(...envNamesProblems(session.env ?? [], values));
  // Два ответа на один вопрос «какие источники настроек»: какой из них главнее, ядро не угадывает.
  if (session.sources && session.settingSources) {
    out.push('session: sources and settingSources both narrow the setting sources — send one');
  }
  return out;
}
