import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatHits,
  scanSources,
  sourceViews,
  type LiteralRuleSet,
  type LiteralSource,
} from './literal-lint.ts';
import { LITERAL_RULE_SETS, P51_OS_BRANCH } from './rule-sets.ts';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function coreSources(): LiteralSource[] {
  const out: LiteralSource[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Любой исходник JS/TS (B1 r8 C13): `.mjs`/`.cts` вне `__fixtures__` тоже проходит наборы.
      else if (/\.[cm]?[jt]s$/.test(entry.name))
        out.push({
          path: relative(SRC, full).split('\\').join('/'),
          text: readFileSync(full, 'utf8'),
        });
    }
  };
  walk(SRC);
  return out;
}

/** Каждая запрещённая форма — своей строкой; номер строки = номер в массиве + 1. */
const PROBE = [
  "import { EOL, homedir } from 'node:os';",
  "import { sep } from 'path';",
  "import * as os from 'node:os';",
  'const a = process.platform;',
  'const { platform } = process;',
  'const b = os.type();',
  'const c = path.win32.join;',
  'const d = process.env.USERPROFILE;',
  "const e = process.env['APPDATA'];",
  'const { HOME } = process.env;',
  "const f = 'tool.EXE';",
  'const g = `run ${f}.cmd now`;',
  "const h = 'a\\r\\nb';",
  '// process.platform in a comment is prose, not a branch',
  '/* os.EOL and .exe in a block comment */',
  "const i = 'process.platform inside a string is text';",
  "const j = await import('node:os');",
  'const k = spec.cmd;',
].join('\n');

const PROBE_RULES: [number, string][] = [
  [1, 'os-import'],
  [2, 'path-flavour-import'],
  [4, 'process-platform'],
  [5, 'process-platform-destructured'],
  [6, 'os-member'],
  [7, 'path-flavour'],
  [8, 'home-env-member'],
  [9, 'home-env-name'],
  [10, 'home-env-destructured'],
  [11, 'windows-suffix'],
  [12, 'windows-suffix'],
  [13, 'crlf'],
];

describe('P51 literal lint — OS branches only inside platform/', () => {
  it('P51+P108 literal lint over apps/core/src: no finding of any set outside its allowed folders, tests and fixtures', () => {
    const sources = coreSources();
    for (const set of LITERAL_RULE_SETS) {
      const scan = scanSources(sources, set);
      expect(formatHits(scan.hits), set.id).toBe('');
      // Пустой список находок ничего не значит, если набор никуда не смотрел.
      expect(scan.checked.length, set.id).toBeGreaterThan(20);
      expect(scan.checked).toContain('literal-lint/rule-sets.ts');
      // Каждый набор не заходит в СВОИ разрешённые папки: `platform/` — только у P51, у P108 —
      // `adapters/` и `routes/` (платформу P108 проверяет: имён CLI в ней быть не должно).
      const inAllowed = (path: string): boolean =>
        set.allowed.some((folder) => path.startsWith(`${folder}/`));
      expect(scan.checked.filter(inAllowed), set.id).toEqual([]);
      expect(scan.checked.some((path) => path.endsWith('.test.ts'))).toBe(false);
    }
    expect(LITERAL_RULE_SETS.map((set) => set.id)).toEqual(['P51', 'P108']);
    expect(P51_OS_BRANCH.allowed).toEqual(['platform']);
  });

  it('P51 literal lint probe: every forbidden form caught at its line outside platform/; comments, strings-as-text and module specifiers are not', () => {
    const scan = scanSources([{ path: 'conductor/probe.ts', text: PROBE }], P51_OS_BRANCH);
    const got = scan.hits.map((hit) => [hit.line, hit.rule] as [number, string]);
    expect(got.sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]))).toEqual(PROBE_RULES);
    expect(scan.hits[0]?.message).toMatch(/^P51 \(09-platforms/);
  });

  it('F-81 P51 evasion forms: whole-module bindings under any name, load calls, index access, aliases, home and XDG variables are caught', () => {
    // Каждая форма — отдельный файл: псевдоним модуля привязывается на файл.
    const cases: [string, string][] = [
      ["import * as o from 'node:os'; const x = o.platform();", 'os-member'],
      ["import o from 'os'; const x = o['EOL'];", 'os-member'],
      ["import o = require('os'); const x = o.type();", 'os-member'],
      ["const o = await import('node:os'); const x = o?.platform();", 'os-member'],
      ["const o = (await import('node:os')) as typeof import('os'); o.homedir();", 'os-member'],
      ["const o = require('os'); o.homedir();", 'os-member'],
      ["const x = require('node:os').userInfo();", 'os-member'],
      ["const x = (await import('os')).platform();", 'os-member'],
      ["const { platform: p } = await import('node:os');", 'os-destructured'],
      ["const { EOL } = require('os');", 'os-destructured'],
      ["import * as o from 'node:os'; const { type } = o;", 'os-destructured'],
      ["import { homedir as h } from 'node:os';", 'os-import'],
      ["export { platform } from 'os';", 'os-import'],
      ["const x = process['platform'];", 'process-platform'],
      ['const x = process?.[`platform`];', 'process-platform'],
      ["import p from 'node:process'; const x = p.platform;", 'process-platform'],
      ["import * as p from 'process'; const { platform } = p;", 'process-platform-destructured'],
      ["import { platform as pl } from 'node:process';", 'process-platform-import'],
      ["import p from 'node:path'; p.win32.join('a');", 'path-flavour'],
      ["const nodePath = require('path'); const s = nodePath.sep;", 'path-flavour'],
      ["const d = path['delimiter'];", 'path-flavour'],
      ["const { posix } = await import('node:path');", 'path-flavour-destructured'],
      ["import w from 'node:path/win32';", 'path-flavour-module'],
      ['const x = process.env.HOMEPATH;', 'home-env-member'],
      ['const x = process.env.HOMEDRIVE;', 'home-env-member'],
      ['const x = env.XDG_RUNTIME_DIR;', 'home-env-member'],
      ['const { XDG_CONFIG_HOME } = process.env;', 'home-env-destructured'],
      ["const x = process.env['XDG_DATA_HOME'];", 'home-env-name'],
    ];
    for (const [text, rule] of cases) {
      const scan = scanSources([{ path: 'conductor/x.ts', text }], P51_OS_BRANCH);
      expect(
        scan.hits.map((hit) => hit.rule),
        text,
      ).toEqual([rule]);
    }
    // Не развилка: модуль целиком без запретного члена, разрешённые члены, чужое имя с тем же
    // членом, псевдоним другого файла и ключ-строка, совпадающая с именем члена, у чужого объекта.
    const clean = [
      "import * as o from 'node:os'; const t = o.tmpdir(); const h = o.hostname();",
      "const o = await import('node:os'); const n = o.cpus().length;",
      "import p from 'node:path'; const j = p.join('a', 'b');",
      "const x = require('node:path').resolve('a');",
      "import { tmpdir } from 'node:os';",
      'const o = getOptions(); const x = o.platform;',
      "const x = config['platform'];",
      "const k = 'XDG is a word, not a variable name';",
    ];
    for (const text of clean)
      expect(scanSources([{ path: 'conductor/x.ts', text }], P51_OS_BRANCH).hits, text).toEqual([]);
    // Псевдоним привязывается к файлу: `o` из соседнего файла здесь — просто имя.
    const two = scanSources(
      [
        { path: 'conductor/a.ts', text: "import * as o from 'node:os';" },
        { path: 'conductor/b.ts', text: 'const x = o.platform;' },
      ],
      P51_OS_BRANCH,
    );
    expect(two.hits).toEqual([]);
  });

  it('P51 literal lint probe: the same text inside platform/, in a test and in a fixture → no finding', () => {
    const scan = scanSources(
      [
        { path: 'platform/probe.ts', text: PROBE },
        { path: 'platform/deep/probe.ts', text: PROBE },
        { path: 'conductor/probe.test.ts', text: PROBE },
        { path: 'session-host/__fixtures__/probe.ts', text: PROBE },
      ],
      P51_OS_BRANCH,
    );
    expect(scan).toEqual({ hits: [], checked: [] });
    // `platformer/` — не `platform/`: разрешение по папке, не по префиксу строки.
    expect(scanSources([{ path: 'platformer/x.ts', text: PROBE }], P51_OS_BRANCH).checked).toEqual([
      'platformer/x.ts',
    ]);
  });
});

describe('literal lint machinery — pluggable rule sets', () => {
  it('P51 literal lint machinery: a second data-only set runs on the same engine with its own folders and exemptions', () => {
    const names: LiteralRuleSet = {
      id: 'PX',
      spec: 'probe',
      allowed: ['adapters/alpha'],
      exempt: ['\\.spec\\.ts$'],
      rules: [
        {
          id: 'name-literal',
          in: 'strings',
          pattern: '\\balpha\\b',
          message: 'name only in its adapter.',
        },
        {
          id: 'name-route',
          in: 'code',
          pattern: "from\\s*'\\./adapters/alpha/",
          message: 'no reach-in.',
        },
      ],
    };
    const text = "import { x } from './adapters/alpha/run.ts';\nconst n = 'alpha';\n// alpha\n";
    const scan = scanSources(
      [
        { path: 'conductor/a.ts', text },
        { path: 'adapters/alpha/b.ts', text },
        { path: 'adapters/alphabet/c.ts', text },
        { path: 'conductor/a.spec.ts', text },
      ],
      names,
    );
    expect(scan.checked).toEqual(['conductor/a.ts', 'adapters/alphabet/c.ts']);
    // Указатель модуля — не строка-значение (строка 1 не ловится `strings`), комментарий — не код.
    expect(scan.hits.map((hit) => `${hit.path}:${hit.line}:${hit.rule}`)).toEqual([
      'conductor/a.ts:2:name-literal',
      'conductor/a.ts:1:name-route',
      'adapters/alphabet/c.ts:2:name-literal',
      'adapters/alphabet/c.ts:1:name-route',
    ]);
  });

  it('P51 literal lint views: comments and string bodies blanked with offsets kept; cooked string values; surrogate pairs do not shift', () => {
    const text =
      "const s = '😀 a\\tb'; // tail\nconst t = `x${s}y`; /* c */ go();\n/* two\nlines */ end();\n";
    const views = sourceViews('v.ts', text);
    expect(views.code.length).toBe(text.length);
    // Перевод строки внутри комментария остаётся — номера строк после него не съезжают.
    expect(views.code).toBe(
      "const s = '       ';        \nconst t = ` ${s} `;         go();\n      \n         end();\n",
    );
    expect(views.strings.map((s) => s.value)).toEqual(['😀 a\tb', 'x', 'y']);
  });

  it('F-81 literal lint views: require specifier and index keys stay in code; whole-module bindings are collected per module', () => {
    const text =
      "import * as a from 'node:os';\nimport b, { c } from 'path';\nconst d = require('os');\nconst e = await import('node:path');\nconst f = x['k'];\nconst g = 'v';\n";
    const views = sourceViews('v.ts', text);
    expect(views.code).toContain("require('os')");
    expect(views.code).toContain("x['k']");
    expect(views.code).toContain("const g = ' ';");
    // Ключ по индексу — ещё и строка-значение: правила `strings` его видят.
    expect(views.strings.map((s) => s.value)).toEqual(['k', 'v']);
    expect(Object.fromEntries(views.bindings)).toEqual({ os: ['a', 'd'], path: ['b', 'e'] });
  });
});
