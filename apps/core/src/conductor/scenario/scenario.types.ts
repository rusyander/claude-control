import type { PrecedenceDecision } from '@agentdeck/contracts/core/decisions';
import type {
  OverlayEntry,
  PresetId,
  ProjectScenario,
  Scenario,
  ScenarioRef,
} from '@agentdeck/contracts/core/scenario';

/** Уровень правки поверх сценария (00 §Precedence): 4 — файлы проекта, 5 — слой пользователя. */
export type NarrowLevel = 4 | 5;

/** Один слой сужения: чей файл и что в нём. Источник называется в причине каждой строки. */
export interface OverlayLayer {
  level: NarrowLevel;
  /** Кто это сказал — для человека на экране запуска: `r1: .agentdeck/scenario.json`. */
  source: string;
  file: ProjectScenario;
}

export interface OverlayResult {
  /** Сценарий после принятых строк; при отказе уровня 3 — исходный без изменений. */
  scenario: Scenario;
  applied: OverlayEntry[];
  rejected: OverlayEntry[];
  /** Сценарий нарушает правила платформы (уровень 3): запуск отказан, названо. */
  refused: boolean;
  /** Решение старшинства по каждому задетому пути (`steps.<id>.<ключ>`, `ciWait`), G1. */
  precedence: PrecedenceDecision[];
}

/** Чтение, на котором стоит итог, — строкой `decision.facts` (класс чтения и вид факта). */
export interface ReadNote {
  readClass: string;
  kind: 'value' | 'absent' | 'unknown';
}

export interface ScenarioRefusal {
  level: 3 | NarrowLevel;
  source: string;
  reason: string;
}

/**
 * Итог разрешения сценария задачи. Отказ — каждое препятствие своей строкой и пресеты на
 * замену (02:32: негодный файл не подменяется молча, человеку предлагают пресет).
 */
export type ScenarioResolution =
  | {
      ok: true;
      scenario: Scenario;
      base: ScenarioRef;
      overlay: { applied: OverlayEntry[]; rejected: OverlayEntry[] };
      /** Решение старшинства ключей сценария (G1): оценка, правка и деление получают одно и то же. */
      precedence: PrecedenceDecision[];
      facts: ReadNote[];
    }
  | { ok: false; refusals: ScenarioRefusal[]; offer: readonly PresetId[]; facts: ReadNote[] };

/** Репозиторий задачи, чей файл проекта читается (`task.created.repos[]`). */
export interface ScenarioRepo {
  repoKey: string;
  path: string;
}
