import type { CheckRecord } from '@agentdeck/contracts/core/records';
import type { RedInput, RedOutcome } from './red.types.ts';
import { isAbsoluteForm, sameFileTail, sameTest } from './test-path.ts';

/**
 * Класс красного (04:78-81, R:S2-13, P75) — чистая функция. Дефект → шаг исправления; стенд и
 * окружение → действие над окружением, никогда правка кода; устаревший (красный и на базе, вне
 * изменения) → только итоговый отчёт: старые красные — не наша работа (владелец). Сомнение — не
 * «устарел»: без записи базы вне замыкания ответ `need-base`, внутри замыкания — дефект.
 */

type Failing = CheckRecord['failing'][number];

// База и финал — один раннер: файл сверяется строкой; другая форма (база в другом каталоге) — другой тест (fail-closed).
const sameRun = (a: Failing, b: Failing): boolean =>
  a.name === b.name && (a.file === undefined || b.file === undefined || a.file === b.file);

/** Красное базы: fail — его список; pass — пусто (база зелёная); иначе — неизвестно. */
function baseRed(base: CheckRecord | null): Failing[] | 'green' | undefined {
  if (base === null) return undefined;
  if (base.verdict.kind === 'fail' && base.verdict.reason === 'red') return base.failing;
  if (base.verdict.kind === 'pass') return 'green';
  return undefined;
}

export function classifyRed(input: RedInput): RedOutcome {
  const { final } = input;
  const verdict = final.verdict;
  if (verdict.kind === 'pass')
    throw new Error(`classifyRed: запись ${final.id} зелёная — классифицировать нечего`);
  if (verdict.kind === 'pass-flaky')
    return {
      kind: 'class',
      red: 'flaky',
      why: `доказанный переход на повторе: ${verdict.retries.join(', ')}`,
    };
  if (verdict.kind === 'no-verdict') {
    if (verdict.reason === 'stand')
      return { kind: 'class', red: 'stand', why: 'стенд перезапускался во время прогона' };
    if (verdict.reason === 'aborted')
      return { kind: 'rerun', why: 'прогон прерван — это не красный (04:63)' };
    if (verdict.reason === 'selection')
      return {
        kind: 'class',
        red: 'stale',
        why: 'узкая выборка не нашла ни одного теста — имя теста в привязке устарело',
      };
    return { kind: 'class', red: 'env', why: `нет вердикта: ${verdict.reason}` };
  }
  if (verdict.reason === 'absent')
    return {
      kind: 'class',
      red: 'defect',
      why: `проверка ${final.checkId} запрошена, но её нет в реестре`,
    };
  return classifyFail(input);
}

function classifyFail(input: RedInput): RedOutcome {
  const { final, quarantined, changed } = input;
  const base = baseRed(input.base);
  const all = final.failing;
  const inQuarantine = (t: Failing): boolean =>
    quarantined.some((q) => sameTest({ name: q.test, ...(q.file ? { file: q.file } : {}) }, t));
  const open = all.filter((t) => !inQuarantine(t));

  if (all.length > 0 && open.length === 0) {
    // Красны только тесты в карантине: дефект, если хоть один зелёный на базе (P75).
    if (base === undefined)
      return { kind: 'need-base', why: 'красны только тесты в карантине — нужна база' };
    const greenOnBase = all.filter((t) => base === 'green' || !base.some((b) => sameRun(b, t)));
    if (greenOnBase.length > 0)
      return {
        kind: 'class',
        red: 'defect',
        why: `тест в карантине красный на финале и зелёный на базе: ${greenOnBase[0]?.name ?? ''}`,
      };
    return {
      kind: 'class',
      red: 'flaky',
      why: 'красны только тесты в карантине, они красные и на базе',
    };
  }

  // «Вне изменения» — только доказуемо: файл назван, сводится к пути репо и не совпал ни с одним
  // изменённым (раннер печатает от своего корня и с `\` — сверка по хвосту). Абсолютный путь с
  // неизвестным корнем вне изменения не доказывает — дефект, не «устарел».
  const outside = (t: Failing): boolean => {
    if (!input.inChangedClosure) return true;
    const file = t.file;
    return (
      file !== undefined && !isAbsoluteForm(file) && !changed.some((c) => sameFileTail(c, file))
    );
  };
  // Неразобранный красный (без имён тестов) вне замыкания ещё может быть старым, внутри — дефект.
  const candidate =
    !input.scenarioRequired && (open.length > 0 ? open.every(outside) : !input.inChangedClosure);
  if (!candidate)
    return {
      kind: 'class',
      red: 'defect',
      why: input.scenarioRequired
        ? `проверку ${final.checkId} сценарий называет обязательной`
        : 'красный в изменённом замыкании на финальном дереве',
    };
  if (base === undefined)
    return { kind: 'need-base', why: 'красный вне изменения — нужен прогон базы' };
  const staleOnBase =
    base !== 'green' &&
    (open.length > 0 ? open.every((t) => base.some((b) => sameRun(b, t))) : base.length === 0);
  if (staleOnBase)
    return {
      kind: 'class',
      red: 'stale',
      why: 'красный и на базе, вне изменения — только в итоговый отчёт',
    };
  return {
    kind: 'class',
    red: 'defect',
    why: 'на базе этот тест не красный — красный внесён задачей',
  };
}
