import type { CommandKind } from '@agentdeck/contracts/core/commands';
import type { DecisionClassId } from '@agentdeck/contracts/core/decisions';
import type { ActionKind, JournalDataV1, JournalKind } from '@agentdeck/contracts/core/journal';
import type { ModelToolName } from '@agentdeck/contracts/core/model-tools';
import type { DialectId } from '@agentdeck/stub-model';

/**
 * Протоколы задач-заглушек. Gemini API (`google-genai`) вне библиотеки: `script.ts` считает ходы
 * по `messages`/`input`, а у Gemini история в `contents` с ролью `model` — задача на нём
 * разошлась бы со сценарием молча. Нужна задача для Gemini — сначала ветка в `assistantTurns`.
 */
export type TaskDialect = Exclude<DialectId, 'google-genai'>;

/**
 * Библиотека задач-заглушек (07 фаза 2, R:S2-25; 08 вид `stub`): задача = вход + ходы модели +
 * ожидаемые вердикты. Ходы модели описаны без CLI и без протокола (`write`, `shell`, вызов
 * инструмента ядра), сценарий заглушки строит из них `script.ts` под любой протокол и под имена
 * инструментов, которые объявил сам CLI. Вердикты поздних фаз (дирижёр 4, публикатор 6,
 * наблюдатель 8) записаны уже сейчас как данные — фаза 2 проверяет то, что решает её код.
 */

/** Подстановки в строках ходов: `${stepId}` — шаг сессии, `${copy}` — корень копии единицы. */
export type Template = string;

export type Move =
  | { op: 'write'; path: Template; content: string }
  /**
   * Чтение файла; `range` — окно строк (этап 8: перечитывание того же окна против соседних —
   * разные вызовы для наблюдателя). Инструмент чтения CLI без полей окна — чтение целиком.
   */
  | { op: 'read'; path: Template; range?: { offset: number; limit: number } }
  /**
   * Команда оболочки CLI; `background` — фоновый запуск (пробуждение CLI после хода, P48).
   * `exit` — код выхода, который сообщает ПОДДЕЛЬНЫЙ CLI (этап 8: повтор падающей команды);
   * настоящий CLI исполняет команду, и код у него свой — поле он не видит.
   */
  | { op: 'shell'; argv: Template[]; background?: boolean; exit?: number }
  /**
   * Вызов инструмента сервера `agentdeck`. `invalid: true` — ход намеренно не проходит схему
   * (P72): тест библиотеки требует, чтобы схема его ОТВЕРГЛА, а не приняла.
   */
  | { op: 'model-tool'; tool: ModelToolName; args: Record<string, unknown>; invalid?: true }
  | { op: 'text'; text: string };

/** Задержки заглушки на ходе (тишина потока для детектора остановки, P18). */
export interface MoveTiming {
  holdMs?: number;
  stallMs?: number;
  /**
   * Метка: ход CLI кончается ПОСЛЕ этого хода (этап 8: пакет подсказок уходит на конце хода).
   * Настоящий CLI кончает ход сам, на ответе текстом, — поэтому сценарий заглушки за помеченным
   * ходом вставляет ответ текстом (`TURN_END_TEXT`), следующий ход задачи идёт в следующем ходе CLI.
   * Подделка CLI на метке пишет конец хода.
   */
  turnEnd?: true;
  /**
   * Расход ответа модели на этом ходе (этап 8, рост контекста): токены, которые CLI сообщит
   * событием `usage`. Заглушка кладёт их в `usage` ответа протокола (`input` + `cacheWrite` — во
   * вход, `cacheRead` — в поле кеша); подделка CLI пишет событие как есть. Нет — расход заглушки
   * по умолчанию (10 / 2), подделка не пишет ничего.
   */
  usage?: MoveUsage;
  /**
   * Факт окна подписки на ответе этого хода (этап 8, окно маршрута): заглушка отдаёт его
   * заголовками предела протокола, подделка CLI — событием `window`. Нет — заголовков нет.
   */
  window?: MoveWindow;
}

export interface MoveUsage {
  input: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Ответ подагента CLI (у него нет своей сессии ядра — контекст главной он не растит). */
  subagent?: true;
  /** Окно контекста, которое назвала сама сессия (claude `result.modelUsage`), — вход CLI. */
  contextWindow?: number;
}

export interface MoveWindow {
  /** Вердикт источника: обслуживает / обслуживает с предупреждением / отказал. */
  status: 'allowed' | 'allowed_warning' | 'rejected';
  /** Занятая доля окна, 0..100. */
  usedPct: number;
  /** Через сколько мс от ответа окно сбросится. */
  resetInMs: number;
}

/**
 * Аренда маршрута, которую шаг взял при запуске (этап 8, утечка ресурса): ресурс аренды —
 * строка `resource.created` ядра, сессия называет аренду (`session.started.lease`), в конце
 * задачи её снимает настоящий `releaseTaskLeases`. `released` — маршрут снял и подтвердил;
 * `refused` — снятие маршрута отказало с этой причиной (внешняя граница: сервер маршрута).
 */
export type LeaseFault = { release: 'released' } | { release: 'refused'; reason: string };

export type TimedMove = Move & MoveTiming;

export interface RepoFixture {
  /** Файлы первого коммита: путь от корня → текст. */
  files: Record<string, string>;
  baseBranch: string;
}

export interface TaskInput {
  title: string;
  /** Текст задачи человека — первое сообщение сессии. */
  request: string;
  repo: RepoFixture;
  /** Вид шага, в котором идут ходы (02); фаза 2 гонит один шаг `work`. */
  stepKind: string;
  /** Требования задачи (то, что потом извлечёт шаг intake, фаза 4). */
  requirements: { id: string; text: string }[];
}

/** Кто выносит вердикт. Классы решений и виды журнала — из контрактов, а не строки на глаз. */
export type Judge =
  | { kind: 'decision'; class: DecisionClassId }
  | { kind: 'signal'; signal: string }
  | { kind: 'adapter-event'; event: 'turn.cli-initiated' }
  | { kind: 'repo'; fact: 'commits' };

export type PropertyId = `P${number}`;

export interface Verdict {
  property: PropertyId;
  /** Фаза, чей код выносит вердикт (07 §Phases). */
  phase: number;
  judge: Judge;
  /** Ожидаемый вердикт словами — то, что золотой прогон фазы сверяет. */
  expect: string;
  journal?: { present?: JournalKind[]; absent?: JournalKind[] };
}

/** Сигналы наблюдателя (06 §Observer, фаза 8), которых ЖДЁМ на задаче; прочие — ложные (P33). */
export interface ObserverExpectation {
  signals: string[];
}

/** Проверки, которые код фазы 2 исполняет уже сейчас (`phase2-verdicts.test.ts`). */
export type Phase2Probe =
  | {
      kind: 'model-tool';
      /** Номер хода в `moves`: его аргументы и есть вызов. */
      move: number;
      /** Записи проверок, видимые `step_done` (до фазы 3 хранилища нет — факт подаётся). */
      records?: Record<string, 'pass' | 'pass-flaky' | 'fail' | 'no-verdict'>;
      /** Сколько раз подряд подать вызов (P72: второй неверный — отказ без списка полей). */
      repeat?: number;
      expect: {
        ok: boolean;
        /** Код отказа каждого вызова по порядку (`repeat`), либо один код. */
        codes?: string[];
        /** Поля ответа `result` (подмножество). */
        result?: Record<string, unknown>;
        decision?: { class: DecisionClassId; output: Record<string, unknown> };
        journal: { present?: JournalKind[]; absent?: JournalKind[] };
        signals?: string[];
        stepState: string;
      };
    }
  | {
      kind: 'permit';
      /**
       * Ход `shell`: строка команды идёт сырым вызовом через разбор КАЖДОГО переходника фазы 2
       * (Claude, Qwen) в `policy/permit`; решение обязано совпасть с решением по argv хода.
       */
      move: number;
      /** Префиксы argv публикации в наборе запретов платформы (06). */
      denyCommands: string[][];
      expect: { allow: boolean; code?: string };
    }
  | {
      kind: 'command';
      command: { kind: CommandKind; fields: Record<string, unknown> };
      proof: JournalDataV1['command.received']['proof'];
      expect: {
        status: 'applied' | 'rejected';
        code?: string;
        signal?: string;
        journal: { present?: JournalKind[]; absent?: JournalKind[] };
      };
    }
  | {
      kind: 'reconcile';
      action: ActionKind;
      /** Где ядро умерло: до действия (`action.started` есть, мира нет) или после до `action.done`. */
      cut: 'before-effect' | 'after-effect';
      expect: ReconcileExpect;
    };

/** Зона этапа 4, чья проба (`.agent/tmp/core-s4-plan.agent.md` §1). */
export type Stage4Zone = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

/**
 * Проба дирижёра этапа 4: что зона обязана показать на настоящем цикле (волна 2) — свойство,
 * команды человека по дороге, строки журнала и классы решений. До волны 2 тест библиотеки
 * сверяет её с контрактами: вид команды, вид строки и класс решения — существующие.
 */
export interface Phase4Probe {
  zone: Stage4Zone;
  property: PropertyId;
  /** Команды человека, которые проба подаёт, по порядку (тело — из `COMMAND_FIELDS`). */
  commands?: { kind: CommandKind; fields: Record<string, unknown> }[];
  expect: {
    journal: { present?: JournalKind[]; absent?: JournalKind[] };
    decisions?: DecisionClassId[];
  };
}

export interface ReconcileExpect {
  verdict: 'happened' | 'not-happened' | 'retry' | 'ask';
  /** Строка журнала, которую пишет решение (`null` — только само решение). */
  then: JournalKind | null;
  /** Для `retry`: за сроком класса чтения — точка человека 4. */
  pastWindow?: { verdict: 'ask'; then: 'human.asked' };
}

/** Сквозной прогон (часть 2): одна задача до локального коммита на каждом переходнике. */
export interface EndToEnd {
  /** Новых коммитов на ветке копии после задачи (ровно один эффект, P10). */
  commits: number;
  /** Файлы, которые коммит обязан нести (путь → текст). */
  committed: Record<string, string>;
}

export interface StubTask {
  id: string;
  /** Что проверяет задача — одна строка для каталога и Tests block. */
  summary: string;
  adversarial: boolean;
  input: TaskInput;
  moves: TimedMove[];
  /** Протоколы, которыми задача обязана обслуживаться (переходники фазы 2 — Claude и Qwen). */
  dialects: TaskDialect[];
  verdicts: Verdict[];
  observer: ObserverExpectation;
  phase2: Phase2Probe[];
  /** Пробы этапа 4; задача без них — дирижёр её только проводит, ничего своего не судит. */
  phase4?: Phase4Probe[];
  e2e?: EndToEnd;
  /** Аренда маршрута шага и исход её снятия; нет — шаг без аренды. */
  lease?: LeaseFault;
  /** Окно контекста маршрута шага в токенах; нет — неизвестно (рост контекста молчит). */
  routeWindowTokens?: number;
  /** `grantRequired` конфига ядра для репозитория задачи (P130); нет — пусто. */
  grantRequired?: { globs: string[]; ops: ('edit' | 'exec-db')[] }[];
}
