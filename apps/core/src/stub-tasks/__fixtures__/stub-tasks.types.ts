import type { CommandKind } from '@agentdeck/contracts/core/commands';
import type { DecisionClassId } from '@agentdeck/contracts/core/decisions';
import type { ActionKind, JournalDataV1, JournalKind } from '@agentdeck/contracts/core/journal';
import type { ModelToolName } from '@agentdeck/contracts/core/model-tools';
import type { DialectId } from '@agentdeck/stub-model';

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
  | { op: 'read'; path: Template }
  /** Команда оболочки CLI; `background` — фоновый запуск (пробуждение CLI после хода, P48). */
  | { op: 'shell'; argv: Template[]; background?: boolean }
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
}

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
  dialects: DialectId[];
  verdicts: Verdict[];
  observer: ObserverExpectation;
  phase2: Phase2Probe[];
  e2e?: EndToEnd;
}
