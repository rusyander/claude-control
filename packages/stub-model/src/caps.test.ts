/**
 * Покрытие возможностей (P121): заявленная в `STUB_CAPS` возможность без случая в
 * общем наборе — красный; незаявленная (свободный инструмент вне responses) —
 * отказ сценария, а не тихая подмена. И гигиена пакета: ноль зависимостей, только
 * встроенные модули node — иначе голый `node tools/qa/*.mjs` его не загрузит.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DIALECT_IDS, STUB_CAPS, startStubModel, type StubModel } from './index.mjs';
import { casesFor } from './conformance.cases.ts';
import { CLIENTS } from './clients/index.ts';
import { call } from './clients/call.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Чужие импорты модуля пакета (`file` — путь от `src/`): не `node:` и не файл внутри
 * `src/`. Формы: `import … from` и `export … from` (любые кавычки, многострочные),
 * `import '…'` ради побочного эффекта, `import('…')`, `require('…')`; относительный путь,
 * который выходит из `src/`, — тоже чужой.
 */
function foreignImports(file: string, source: string): string[] {
  const forms =
    /\b(?:from|import)\s*(['"])([^'"]+)\1|\b(?:import|require)\s*\(\s*(['"`])([^'"`]+)\3\s*\)/g;
  return [...source.matchAll(forms)]
    .map((match) => (match[2] ?? match[4])!)
    .filter((spec) => {
      if (spec.startsWith('node:')) return false;
      if (!spec.startsWith('./') && !spec.startsWith('../')) return true;
      return relative(here, resolve(here, dirname(file), spec)).startsWith('..');
    })
    .map((spec) => `${file}: ${spec}`);
}

/** Имя возможности → имена случаев, которые её доказывают на протоколе. */
function requiredCases(dialect: string): string[] {
  const required: string[] = [];
  for (const [cap, value] of Object.entries(STUB_CAPS)) {
    if (value === false) continue;
    switch (cap) {
      case 'dialects':
        break; // доказывается наличием клиента-оракула (тест ниже)
      case 'errors':
        for (const status of STUB_CAPS.errors) required.push(`error:${status}`);
        break;
      case 'customTools':
        if (STUB_CAPS.customTools.includes(dialect as never)) required.push('customTools');
        break;
      case 'window':
        if (STUB_CAPS.window.includes(dialect as never)) required.push('window');
        break;
      case 'offline':
        break; // доказывает тест сервера: слушает только 127.0.0.1, сеть не нужна
      default:
        required.push(cap);
    }
  }
  return required;
}

describe('capability coverage', () => {
  it('every declared dialect has an independent client', () => {
    expect(Object.keys(CLIENTS).sort()).toEqual([...DIALECT_IDS].sort());
  });

  it('caps without a known proof are refused (a new cap needs a case first)', () => {
    const known = new Set([
      'dialects',
      'streaming',
      'nonStreaming',
      'tools',
      'customTools',
      'errors',
      'midStreamErrors',
      'window',
      'hold',
      'stall',
      'chunkedText',
      'cachedUsage',
      'extraFields',
      'release',
      'aborted',
      'routes',
      'images',
      'offline',
    ]);
    expect(Object.keys(STUB_CAPS).filter((cap) => !known.has(cap))).toEqual([]);
  });

  it.each(DIALECT_IDS)('every declared cap has a case on %s', (dialect) => {
    const have = new Set(casesFor(dialect).map((c) => c.cap));
    expect(requiredCases(dialect).filter((cap) => !have.has(cap))).toEqual([]);
  });
});

describe('undeclared cap is refused, not substituted', () => {
  let stub: StubModel;
  beforeAll(async () => {
    stub = await startStubModel({
      script: () => ({ custom: { name: 'apply_patch', input: 'x' } }),
    });
  });
  afterAll(() => stub.close());

  it.each(DIALECT_IDS.filter((d) => !STUB_CAPS.customTools.includes(d)))(
    'custom tool step on %s → STUB SCRIPT FAILED text',
    async (dialect) => {
      const outcome = await call(stub.baseUrl, dialect, { text: 'x', stream: true });
      expect(outcome.reply).toMatchObject({ kind: 'message' });
      const parts = (outcome.reply as { parts: { text?: string }[] }).parts;
      expect(parts[0]?.text).toMatch(/^STUB SCRIPT FAILED: step part «custom» does not exist in /);
      expect(stub.requests.at(-1)?.scriptError).toMatch(/custom/);
    },
  );
});

describe('window step on a dialect without window headers is refused, not invented', () => {
  let stub: StubModel;
  beforeAll(async () => {
    stub = await startStubModel({ script: () => ({ text: 'x', window: { utilization: 0.5 } }) });
  });
  afterAll(() => stub.close());

  it.each(DIALECT_IDS.filter((d) => !STUB_CAPS.window.includes(d)))(
    'window step on %s → STUB SCRIPT FAILED text, no rate-limit headers',
    async (dialect) => {
      const outcome = await call(stub.baseUrl, dialect, { text: 'x', stream: true });
      const parts = (outcome.reply as { parts: { text?: string }[] }).parts;
      expect(parts[0]?.text).toMatch(/^STUB SCRIPT FAILED: step window does not exist in /);
      expect([...outcome.headers.keys()].filter((h) => /ratelimit/.test(h))).toEqual([]);
    },
  );

  it('the list is not empty — google-genai has no window headers', () => {
    expect(DIALECT_IDS.filter((d) => !STUB_CAPS.window.includes(d))).toEqual(['google-genai']);
  });
});

describe('package hygiene', () => {
  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
      'bundleDependencies',
      'bundledDependencies',
    ])
      expect(pkg[field], field).toBeUndefined();
  });

  it('library modules import only node built-ins and each other', () => {
    const files = readdirSync(here, { recursive: true, encoding: 'utf8' }).filter((file) =>
      file.endsWith('.mjs'),
    );
    expect(files.length).toBeGreaterThan(5);
    const foreign = files.flatMap((file) =>
      foreignImports(file, readFileSync(join(here, file), 'utf8')),
    );
    expect(foreign).toEqual([]);
  });

  it('the import scan sees every import form (F-81: it cannot go green on a missed form)', () => {
    const source = [
      `import { a } from "zod";`,
      `import 'undici';`,
      `const lazy = await import('undici');`,
      `const old = require('os');`,
      `export * from '../../../apps/server/src/x.ts';`,
      `import {\n  b,\n} from 'left-pad';`,
      `import { ok } from 'node:fs';`,
      `import { sib } from './sse.mjs';`,
      `import { up } from '../index.mjs';`,
    ].join('\n');
    expect(foreignImports('dialects/x.mjs', source)).toEqual([
      'dialects/x.mjs: zod',
      'dialects/x.mjs: undici',
      'dialects/x.mjs: undici',
      'dialects/x.mjs: os',
      'dialects/x.mjs: ../../../apps/server/src/x.ts',
      'dialects/x.mjs: left-pad',
    ]);
  });
});
