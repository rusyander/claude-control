import type { ActionKind, JournalKind } from '@agentdeck/contracts/core/journal';

/**
 * Сквозной прогон задачи-заглушки (07 фаза 2, P10): ядро — дочерний процесс, его можно убить
 * в названной точке. Дирижёра в фазе 2 нет — его роль играет `conduct.ts` внутри процесса ядра:
 * задача, единица, копия (действие outbox), аренда заглушки, шаг, запуск сессии (действие
 * outbox), прикрепление, первое сообщение.
 */

export type AdapterUnderTest = 'claude' | 'qwen';

/**
 * Где умирает ядро.
 * - `journal`: сразу после того, как `nth`-я строка вида `kind` (с этого запуска) записана — до
 *   того, как записавший код пошёл дальше. Для `action.*` — только строки действия `action`,
 *   для `decision` — только класса `decisionClass`; `decisionRoad` разделяет решения о праве:
 *   `hook` — хук ядра (каждый вызов инструмента), `tool` — вопрос CLI инструментом права или
 *   в своей полосе (то, что считали точки до дороги сессии).
 * - `effect`: внутри действия outbox — эффект сделан, `action.done` ещё не записан.
 */
export type KillPoint =
  | {
      at: 'journal';
      kind: JournalKind;
      nth: number;
      action?: ActionKind;
      decisionClass?: string;
      decisionRoad?: 'hook' | 'tool';
    }
  | { at: 'effect'; action: ActionKind };

/** Чем кончается задача: заявление `step_done` или ход, начатый самим CLI (P48). */
export type Until = 'claimed' | 'cli-initiated';

export interface ChildConfig {
  home: string;
  adapter: AdapterUnderTest;
  /** Одноразовый репозиторий-источник: копия единицы клонируется из него. */
  repo: string;
  baseBranch: string;
  copiesDir: string;
  sessionsDir: string;
  /** Дом CLI (закреплённое окружение): не настоящий конфиг человека. */
  cliHome: string;
  routeId: string;
  taskTitle: string;
  request: string;
  stepKind: string;
  until: Until;
  /** Задача уже есть (перезапуск ядра) — продолжаем её; нет — создаём. */
  taskId?: string;
  kill?: KillPoint;
  /** Сколько ждать конца шага (мс). */
  waitMs: number;
}

/**
 * Настройка одного запуска процесса ядра: `runCore` ставит свежий `runId` на каждый запуск
 * (F-124). Файл итога и записи процесса метятся им, а не pid: pid переиспользуется, и итог
 * чужого прогона того же стенда иначе читался бы как свой.
 */
export type ChildLaunch = ChildConfig & { runId: string };

/** Что ядро сделало на загрузке и что сделал дирижёр — строкой `RESULT` в stdout. */
export interface ChildResult {
  taskId: string;
  unitId: string;
  copy: string;
  stepState: string;
  /** `parked` — задача ждёт (сверка `retry`/`ask`): дирижёр не повторяет вслепую. */
  /** `session-unknown` — живость хоста прежней сессии не прочитана: её не хоронят и не заменяют. */
  outcome: 'claimed' | 'cli-initiated' | 'parked' | 'timeout' | 'session-ended' | 'session-unknown';
  parkedOn?: { actionId: string; kind: ActionKind };
  /** Сессии, которые запустил ЭТОТ процесс ядра. */
  launched: string[];
  /** Запуски прежнего ядра без строки сессии (и потерянные сессии), снятые деревом. */
  stoppedOrphans: string[];
  /** Сессии прежнего ядра, к живому хосту которых ЭТО ядро прикрепилось заново (P89). */
  reattached: ReattachedSession[];
  events: string[];
}

/** Прикреплённая заново сессия: личность хоста и id разговора CLI — как их увидело новое ядро. */
export interface ReattachedSession {
  sessionId: string;
  hostPid: number;
  hostStart: string;
  conversationId: string | null;
  /** Событий потока, восстановленных из stdout.log до живого хвоста. */
  replayed: number;
}
