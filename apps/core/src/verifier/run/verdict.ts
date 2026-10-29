import type { Verdict } from '@agentdeck/contracts/core/records';
import {
  parseFailing,
  selectedNothing,
  testsFailed,
  testsRan,
  type FilterKind,
} from './failing.ts';
import type { RunResult } from './run.types.ts';

/**
 * Вердикт записи по исходу прогона (04:62-63, R:S3-11, G2). Не запустился — `no-verdict(env)`
 * (нет раннера в пине — дело окружения, не кода). Сняли (срок, отмена, отобранная аренда) или
 * убили сигналом снаружи — `no-verdict(aborted)`: aborted ≠ red. Стенд перезапустился за прогон —
 * `no-verdict(stand)`, никогда не красный. Иначе код выхода: 0 — pass, прочее — fail(red).
 * `pass-flaky` здесь не рождается: его даёт только измеренный повтор того же ключа (зона B).
 * Остаток Windows (A1r3-F09, назван, не закрыт): сигналов там нет — снятый извне процесс
 * (диспетчер задач, `taskkill /F`, нехватка памяти) выходит кодом 1 без сигнала и неотличим от
 * своего выхода 1, поэтому ложится `fail(red)`, а не `aborted`. Снятие самим ядром (срок, отмена,
 * отобранная аренда) этим не задето: его `end` ≠ `exit`.
 */
export function verdictOf(run: RunResult): Verdict {
  if (run.end === 'spawn-failed') return { kind: 'no-verdict', reason: 'env' };
  if (run.end !== 'exit') return { kind: 'no-verdict', reason: 'aborted' };
  if (run.standMoved) return { kind: 'no-verdict', reason: 'stand' };
  if (run.exit === null) return { kind: 'no-verdict', reason: 'aborted' };
  return run.exit === 0 ? { kind: 'pass' } : { kind: 'fail', reason: 'red' };
}

/**
 * Поле `failedCount` записи (A1r2-F04): упавших по итогу раннера, только у прогона, дошедшего до
 * выхода. Флаки сверяет его с числом разобранных имён: не сошлось — разбор неполон, повтора нет.
 */
export function failedCountOf(
  end: string,
  kind: FilterKind | undefined,
  log: string,
): number | undefined {
  if (end !== 'exit' || !kind) return undefined;
  return testsFailed(kind, log) ?? undefined;
}

/**
 * Зелёный узкого прогона засчитывается, только если раннер показал ≥1 выполненный тест: выборка,
 * не совпавшая ни с чем, выходит с 0 у vitest/jest/pytest/dotnet — это не зелёный, а прогон без
 * вердикта (`selection`: фильтр раннера не выбрал тест — дело привязки, не кода и не окружения).
 * Причина — в `note`.
 */
export function narrowVerdict(
  verdict: Verdict,
  narrowed: { kind: FilterKind; log: string } | null,
): { verdict: Verdict; note?: string } {
  if (!narrowed) return { verdict };
  if (verdict.kind === 'fail') {
    // Красный узкого прогона без единого упавшего теста, но со своей строкой раннера «фильтр пуст»
    // (A1r3-F05) — выборка, не код. Упавший на утверждении тест в том же выводе оставляет красный.
    const empty =
      parseFailing(narrowed.kind, narrowed.log).length === 0 &&
      selectedNothing(narrowed.kind, narrowed.log);
    if (!empty) return { verdict };
    return {
      verdict: { kind: 'no-verdict', reason: 'selection' },
      note: `narrow run selected no test (${narrowed.kind} failed on an empty filter); not a red`,
    };
  }
  if (verdict.kind !== 'pass') return { verdict };
  const ran = testsRan(narrowed.kind, narrowed.log);
  if (ran !== null && ran > 0) return { verdict };
  return {
    // 0 тестов — выборка ничего не нашла (привязка); итог не прочитан — разбор вывода (окружение).
    verdict: { kind: 'no-verdict', reason: ran === 0 ? 'selection' : 'env' },
    note:
      ran === 0
        ? `narrow run selected no test (${narrowed.kind} filter matched nothing); not a pass`
        : `narrow run: ${narrowed.kind} summary not found, tests run unknown; not a pass`,
  };
}
