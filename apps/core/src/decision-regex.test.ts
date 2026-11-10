import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DECISION_CLASSES } from '@agentdeck/contracts/core/decisions';

/**
 * P32 (02 §Requirements, F16): судья решает по типизированным полям, никогда по прозе. Самый
 * короткий путь к «суду по прозе» — регулярное выражение по тексту модели или человека; поэтому в
 * модулях классов решений (`DECISION_CLASSES`) нет ни литерала `/…/`, ни `RegExp(…)`. Разбор —
 * синтаксическое дерево TypeScript, а не поиск по тексту: `/` в делении и в комментарии не в счёт,
 * `new RegExp(x)` и `RegExp(x)` — в счёт.
 *
 * Исключения — разбор машинного синтаксиса (пути, вывод git, argv), не прозы; у каждого причина.
 * Исключение, в котором выражения больше нет, — красный: список не копит мёртвых строк.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

const ALLOWED: Record<string, string> = {
  'conductor/copy/decide.ts': 'git stderr: the first `fatal:` line of a failed worktree add',
  'routes/compat/compat.ts': 'route-id glob (`*` wildcard), not prose',
  'policy/human-point/human-point.ts': 'path normalisation: separators, drive letter, ./ ../',
  'policy/resolve/resolve.ts': 'route-id glob of an allowed set (`*` wildcard), not prose',
  'policy/permit/target-path.ts': 'Windows path syntax: device, UNC, drive, trailing dots',
  'policy/permit/exec-paths.ts': 'argv path operands: --opt=, VAR=, file://, ~, cygwin/WSL drives',
  'policy/permit/exec-argv/bash.ts': 'POSIX shell lexer: names, escapes, heredocs',
  'policy/permit/exec-argv/foreign.ts': 'cmd.exe and PowerShell lexers',
  'policy/permit/exec-argv/git.ts': 'git config key names that run programs',
  'policy/permit/exec-argv/marks.ts': 'lexer hole markers, executable suffixes, glob words',
  'policy/permit/exec-argv/runners.ts': 'runner flags (cmd /c, -e, -EncodedCommand)',
  'policy/permit/exec-argv/visit.ts': 'shell word shapes while unwrapping wrappers',
  'verifier/compose/coverage.ts': 'test-file naming convention of a repo path',
  'observer/hook-block.ts':
    'CLI hook matcher: the CLI itself evaluates it as a regex over the tool name',
};

interface RegexHit {
  file: string;
  line: number;
  text: string;
}

/** Литералы `/…/` и вызовы `RegExp` (с `new` и без) в тексте одного файла. */
function regexHits(file: string, text: string): RegexHit[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: RegexHit[] = [];
  const hit = (node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ file, line: line + 1, text: node.getText(sf).slice(0, 80) });
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) hit(node);
    else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'RegExp'
    )
      hit(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function sources(abs: string): string[] {
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { recursive: true, encoding: 'utf8' })
    .map((rel) => join(abs, rel))
    .filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.test.ts') &&
        !f.split(/[\\/]/).includes('__fixtures__') &&
        statSync(f).isFile(),
    );
}

/** Файлы модулей классов решений: `<module>.ts` или папка `<module>/` (как у теста P01). */
function decisionFiles(): string[] {
  const out = new Set<string>();
  for (const c of DECISION_CLASSES) {
    for (const f of sources(resolve(SRC, `${c.module}.ts`))) out.add(f);
    for (const f of sources(resolve(SRC, c.module))) out.add(f);
  }
  return [...out].sort();
}

const rel = (abs: string) => relative(SRC, abs).split('\\').join('/');

describe('P32 no regex in decision modules', () => {
  it('no decision module parses text with a regex outside the reasoned allow-list', () => {
    const files = decisionFiles();
    expect(files.length).toBeGreaterThan(10);
    const offending = files
      .filter((f) => ALLOWED[rel(f)] === undefined)
      .flatMap((f) => regexHits(rel(f), readFileSync(f, 'utf8')))
      .map((h) => `${h.file}:${h.line} ${h.text}`);
    expect(offending).toEqual([]);
  });

  it('every allow-list entry is a decision module file that still holds a regex (no dead rows)', () => {
    const files = new Set(decisionFiles().map(rel));
    const dead = Object.keys(ALLOWED).filter(
      (f) => !files.has(f) || regexHits(f, readFileSync(resolve(SRC, f), 'utf8')).length === 0,
    );
    expect(dead).toEqual([]);
  });

  it('the scan sees literals and RegExp calls, not division or comments', () => {
    const src = [
      'const a = 4 / 2 / 1; // a /comment/',
      'const b = /x+/i.test(s);',
      'const c = new RegExp(p);',
      'const d = RegExp(`q`);',
      "const e = '/not/';",
    ].join('\n');
    expect(regexHits('probe.ts', src).map((h) => h.line)).toEqual([2, 3, 4]);
  });
});
