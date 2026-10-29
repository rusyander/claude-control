import type { CheckEntry, CheckRecord } from '@agentdeck/contracts/core/records';

/**
 * Упавшие тесты из вывода раннера (04:68-71, D§3.7): по ним идут узкий перепрогон, флаки и
 * красное-до (засчитывается только тест, упавший на своём утверждении). Имя — полный путь в
 * форме vitest «a > b > it» (блок тестов, AGENTS). Ошибка сбора/импорта тестом не считается:
 * её строки сюда не попадают, а пустой список при ненулевом выходе — «красное без имени»,
 * которое decide/compose трактуют консервативно (вся единица).
 */

export type FilterKind = NonNullable<CheckEntry['filter']>['kind'];
type Failing = CheckRecord['failing'];

// Цвета терминала: ESC собран из кода символа — правило о control-символах в регулярках молчит.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

type LineParser = (line: string, ctx: { file?: string }) => Failing[number] | null;

const PARSERS: Record<FilterKind, LineParser> = {
  // ` FAIL  [|proj| ]src/a.test.ts > d > it` — строка файла без «>» — ошибка сбора, не тест.
  vitest: (line) => {
    const m = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+?)\s*$/.exec(line);
    return m ? { file: m[1]!, name: m[2]! } : null;
  },
  // `FAIL path` задаёт файл; `● d › it` — тест («Test suite failed to run» — сбор).
  jest: (line, ctx) => {
    const file = /^\s*FAIL\s+(\S+)/.exec(line);
    if (file) {
      ctx.file = file[1]!;
      return null;
    }
    const m = /^\s*●\s+(.+?)\s*$/.exec(line);
    if (!m || /^Test suite failed to run/.test(m[1]!)) return null;
    return { ...(ctx.file ? { file: ctx.file } : {}), name: m[1]!.split(/\s+›\s+/).join(' > ') };
  },
  // `FAILED tests/a.py::Cls::test - msg`; `ERROR` — сбор.
  pytest: (line) => {
    const m = /^FAILED\s+([^:\s]+)::(\S+?)(?:\s+-\s+.*)?$/.exec(line.trim());
    return m ? { file: m[1]!, name: m[2]! } : null;
  },
  go: (line) => {
    const m = /^\s*--- FAIL:\s+(\S+)\s+\(/.exec(line);
    return m ? { name: m[1]! } : null;
  },
  cargo: (line) => {
    const m = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/.exec(line.trim());
    return m ? { name: m[1]! } : null;
  },
  dotnet: (line) => {
    const m = /^\s*Failed\s+(\S+)\s+\[[^\]]*\]\s*$/.exec(line);
    return m ? { name: m[1]! } : null;
  },
  // `  1) [chromium] › a.spec.ts:3:5 › d › name ───`
  playwright: (line) => {
    const m = /^\s*\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?([^\s:›]+):\d+:\d+\s+›\s+(.+?)\s*─*\s*$/.exec(
      line,
    );
    return m ? { file: m[1]!, name: m[2]!.split(/\s+›\s+/).join(' > ') } : null;
  },
  gradle: (line) => {
    const m = /^\s*(\S+\s+>\s+.+?)\s+FAILED\s*$/.exec(line);
    return m ? { name: m[1]! } : null;
  },
  // Surefire: `[ERROR] a.b.Cls.method -- Time elapsed … <<< FAILURE!` и старое `method(a.b.Cls)  Time…`.
  maven: (line) => {
    const m = /^\[ERROR\]\s+(\S+?)\s+(?:--\s+)?Time elapsed.*<<<\s+(?:FAILURE|ERROR)!/.exec(
      line.trim(),
    );
    if (!m || m[1] === 'Tests') return null;
    return { name: m[1]! };
  },
};

export function parseFailing(kind: FilterKind | undefined, log: string): Failing {
  return kind ? collect(PARSERS[kind], log) : [];
}

function collect(parse: LineParser, log: string): Failing {
  const ctx: { file?: string } = {};
  const out: Failing = [];
  const seen = new Set<string>();
  for (const raw of log.replace(ANSI, '').split(/\r?\n/)) {
    const hit = parse(raw, ctx);
    if (!hit) continue;
    const id = `${hit.file ?? ''}\u0000${hit.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
  }
  return out;
}

export const FILTER_KINDS = Object.keys(PARSERS) as FilterKind[];

// Хвост времени у строки теста: ` 12ms`, ` 1.2s`, ` (0.00s)`, ` [12 ms]`, `   [ 50%]`.
const TIME_TAIL = /\s+(?:\(?[\d.]+\s?m?s\)?|\[\s*[\d.]+\s?m?s\]|\[\s*\d+%\])\s*$/;

/** Прошедшие тесты — только у раннеров, чей вывод их называет; формы имён — как у `PARSERS`. */
const PASS_PARSERS: Partial<Record<FilterKind, LineParser>> = {
  // verbose: ` ✓ [|proj| ]src/a.test.ts > d > it 12ms` (√ — консоль Windows без юникода).
  vitest: (line) => {
    const m = /^\s*[✓√]\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+?)\s*$/.exec(line.replace(TIME_TAIL, ''));
    return m ? { file: m[1]!, name: m[2]! } : null;
  },
  // -v: `tests/a.py::Cls::test PASSED   [ 50%]`
  pytest: (line) => {
    const m = /^([^:\s]+)::(\S+?)\s+PASSED\b/.exec(line.trim());
    return m ? { file: m[1]!, name: m[2]! } : null;
  },
  go: (line) => {
    const m = /^\s*--- PASS:\s+(\S+)\s+\(/.exec(line);
    return m ? { name: m[1]! } : null;
  },
  cargo: (line) => {
    const m = /^test\s+(\S+)\s+\.\.\.\s+ok$/.exec(line.trim());
    return m ? { name: m[1]! } : null;
  },
  dotnet: (line) => {
    const m = /^\s*Passed\s+(\S+)\s+\[[^\]]*\]\s*$/.exec(line);
    return m ? { name: m[1]! } : null;
  },
  // list: `  ✓  1 [chromium] › a.spec.ts:3:5 › d › name (1.2s)`
  playwright: (line) => {
    const m = /^\s*[✓√]\s+\d+\s+(?:\[[^\]]+\]\s+›\s+)?([^\s:›]+):\d+:\d+\s+›\s+(.+?)\s*$/.exec(
      line.replace(TIME_TAIL, ''),
    );
    return m ? { file: m[1]!, name: m[2]!.split(/\s+›\s+/).join(' > ') } : null;
  },
  gradle: (line) => {
    const m = /^\s*(\S+\s+>\s+.+?)\s+PASSED\s*$/.exec(line);
    return m ? { name: m[1]! } : null;
  },
};

/**
 * Прошедшие тесты из вывода (P50): без них запись не доказывает, что тест кейса вообще есть, —
 * переименованный тест под зелёной единицей выглядел бы зелёным. `undefined` — вывод прошедших
 * не называет (обычный репортёр vitest, jest, maven): про отдельный тест запись молчит.
 */
export function parsePassing(kind: FilterKind | undefined, log: string): Failing | undefined {
  const parse = kind ? PASS_PARSERS[kind] : undefined;
  if (!parse) return undefined;
  const out = collect(parse, log);
  return out.length > 0 ? out : undefined;
}

/** Поле `passing` результата прогона: только у прогона, дошедшего до выхода, и только непустое. */
export function passingOf(
  end: string,
  kind: FilterKind | undefined,
  log: string,
): { passing?: Failing } {
  const passing = end === 'exit' ? parsePassing(kind, log) : undefined;
  return passing ? { passing } : {};
}

/** Сумма чисел перед словами-исходами в строке итога («1 failed | 2 passed», «3 passed, 1 skipped»). */
function counted(line: string, words: readonly string[]): number {
  let sum = 0;
  for (const m of line.matchAll(/(\d+)\s+([a-z]+)/gi))
    if (words.includes((m[2] as string).toLowerCase())) sum += Number(m[1]);
  return sum;
}

const RAN = ['passed', 'failed', 'flaky'];

/**
 * Сколько тестов узкий прогон действительно выполнил (D§3.7): выборка, не совпавшая ни с чем,
 * у многих раннеров выходит с 0 — «зелёный» без единого теста. `null` — итог не найден (сомнение
 * → не зелёный). Gradle сам падает, когда фильтр не нашёл тестов: его выход 0 значит ≥1.
 */
export function testsRan(kind: FilterKind, rawLog: string): number | null {
  const log = rawLog.replace(ANSI, '');
  const last = (re: RegExp): string | null => {
    const all = [...log.matchAll(re)];
    return all.length ? ((all.at(-1) as RegExpMatchArray)[1] as string) : null;
  };
  switch (kind) {
    case 'vitest': {
      // ` Tests  1 passed | 3 skipped (4)`; без итога и с «No test files found» — ни одного.
      const line = last(/^\s*Tests\s+(.+)$/gm);
      if (line !== null) return counted(line, RAN);
      return /No test files found|no tests/i.test(log) ? 0 : null;
    }
    case 'jest': {
      const line = last(/^\s*Tests:\s+(.+)$/gm);
      if (line !== null) return counted(line, RAN);
      return /No tests found/i.test(log) ? 0 : null;
    }
    case 'playwright': {
      const lines = [...log.matchAll(/^\s+(\d+)\s+(passed|failed|flaky)\b/gm)];
      if (lines.length) return lines.reduce((s, m) => s + Number(m[1]), 0);
      return /No tests found/i.test(log) ? 0 : null;
    }
    case 'pytest': {
      // `=== 1 passed, 3 deselected in 0.1s ===`; `no tests ran` — ни одного.
      const line = last(/^=+\s+(.+?)\s+in\s+[\d.]+s.*=+$/gm);
      if (line !== null) return counted(line, ['passed', 'failed', 'error', 'errors']);
      return null;
    }
    case 'go': {
      // Без -v числа нет: `ok pkg 0.1s` — ≥1, `ok pkg 0.1s [no tests to run]` — 0.
      const pkgs = [...log.matchAll(/^(ok|FAIL)\s+\S+.*$/gm)].map((m) => m[0]);
      if (pkgs.length === 0) return null;
      return pkgs.filter((l) => !/\[no tests to run\]/.test(l)).length;
    }
    case 'cargo': {
      const lines = [...log.matchAll(/test result: \w+\.\s+(\d+) passed; (\d+) failed/g)];
      if (lines.length === 0) return null;
      return lines.reduce((s, m) => s + Number(m[1]) + Number(m[2]), 0);
    }
    case 'dotnet': {
      if (/No test matches the given testcase filter/i.test(log)) return 0;
      const total = last(/Total tests:\s*(\d+)/g);
      if (total !== null) return Number(total);
      const line = last(/^\s*(?:Passed|Failed)!\s+-\s+(.+)$/gm);
      return line === null ? null : sumPairs(line);
    }
    case 'maven': {
      // `Tests run: N, …, Skipped: S` — итог модуля не меньше строк классов (узкий идёт без `-q`).
      // Узкий идёт с failIfNoSpecifiedTests=false (многомодульная сборка): пустая выборка выходит
      // с 0 и пишет «No tests to run.» — ни одного; ни итога, ни этой строки — сомнение.
      const rows = [
        ...log.matchAll(
          /Tests run:\s*(\d+),\s*Failures:\s*\d+,\s*Errors:\s*\d+,\s*Skipped:\s*(\d+)/g,
        ),
      ];
      if (rows.length === 0) return /No tests to run/i.test(log) ? 0 : null;
      return Math.max(...rows.map((m) => Number(m[1]) - Number(m[2])));
    }
    case 'gradle':
      return Infinity;
  }
}

/**
 * Сколько тестов упало по итогу самого раннера (A1r2-F04) — независимо от разбора имён. `null` —
 * итога нет (go без -v, вывод оборван до итога): повтор флаки тогда не идёт, красный стоит.
 */
export function testsFailed(kind: FilterKind, rawLog: string): number | null {
  const log = rawLog.replace(ANSI, '');
  const last = (re: RegExp): string | null => {
    const all = [...log.matchAll(re)];
    return all.length ? ((all.at(-1) as RegExpMatchArray)[1] as string) : null;
  };
  const sum = (re: RegExp): number | null => {
    const all = [...log.matchAll(re)];
    return all.length ? all.reduce((s, m) => s + Number(m[1]), 0) : null;
  };
  switch (kind) {
    case 'vitest': {
      const line = last(/^\s*Tests\s+(.+)$/gm);
      return line === null ? null : counted(line, ['failed']);
    }
    case 'jest': {
      const line = last(/^\s*Tests:\s+(.+)$/gm);
      return line === null ? null : counted(line, ['failed']);
    }
    case 'playwright': {
      if (!/^\s+\d+\s+(?:passed|failed|flaky)\b/m.test(log)) return null;
      return sum(/^\s+(\d+)\s+failed\b/gm) ?? 0;
    }
    case 'pytest': {
      const line = last(/^=+\s+(.+?)\s+in\s+[\d.]+s.*=+$/gm);
      return line === null ? null : counted(line, ['failed', 'error', 'errors']);
    }
    case 'cargo':
      return sum(/test result: \w+\.\s+\d+ passed; (\d+) failed/g);
    case 'dotnet': {
      const line = last(/^\s*(?:Passed|Failed)!\s+-\s+(.+)$/gm);
      const failed = line === null ? null : /Failed:\s*(\d+)/.exec(line);
      return failed ? Number(failed[1]) : null;
    }
    case 'maven': {
      // Итог модуля — строка без `Time elapsed` (строки классов её несут); модулей может быть много.
      const rows = [
        ...log.matchAll(/^.*Tests run:\s*\d+,\s*Failures:\s*(\d+),\s*Errors:\s*(\d+).*$/gm),
      ]
        .filter((m) => !/Time elapsed/.test(m[0]))
        .map((m) => Number(m[1]) + Number(m[2]));
      return rows.length ? rows.reduce((s, n) => s + n, 0) : null;
    }
    case 'gradle':
      return sum(/\d+ tests? completed, (\d+) failed/g);
    case 'go':
      return null;
  }
}

/**
 * Свой отказ раннера на пустой выборке (A1r3-F05): Gradle, Surefire, jest, playwright и vitest
 * выходят с ненулевым кодом, когда фильтр не нашёл ни одного теста; pytest — кодом 5 с итогом без
 * единого выполненного. Это не красный код, а выборка, не совпавшая ни с чем.
 */
export function selectedNothing(kind: FilterKind, rawLog: string): boolean {
  const log = rawLog.replace(ANSI, '');
  switch (kind) {
    case 'gradle':
      return /No tests found for given includes/.test(log);
    case 'maven':
      return /No tests matching pattern .* were executed|No tests were executed!/.test(log);
    case 'jest':
    case 'playwright':
      return /No tests found/i.test(log);
    case 'vitest':
      return /No test files found/i.test(log);
    case 'pytest':
      return testsRan('pytest', log) === 0 || /\bno tests ran\b/i.test(log);
    case 'dotnet':
      return /No test matches the given testcase filter/i.test(log);
    case 'go':
    case 'cargo':
      // Пустая выборка у них выходит с 0 — её ловит `testsRan` на зелёном.
      return false;
  }
}

/** `Failed: 0, Passed: 2, Skipped: 0` — сумма Failed + Passed. */
function sumPairs(line: string): number {
  let sum = 0;
  for (const m of line.matchAll(/(Failed|Passed):\s*(\d+)/g)) sum += Number(m[2]);
  return sum;
}
