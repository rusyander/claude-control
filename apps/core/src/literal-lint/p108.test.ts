import { describe, expect, it } from 'vitest';
import { CLI_LITERALS, deriveLiterals } from '@agentdeck/providers/literals';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import { scanSources, type LiteralRuleSet } from './literal-lint.ts';
import { P108_CLI_NAMES, p108Rules } from './p108.ts';

/** Каждая запрещённая форма — своей строкой; номер строки = номер в массиве + 1. */
const PROBE = [
  "import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';",
  "const a = 'claude';",
  "const b = 'anthropic';",
  "const c = 'cursor-agent.CMD';",
  "const d = 'set ANTHROPIC_AUTH_TOKEN first';",
  'const e = process.env.ANTHROPIC_AUTH_TOKEN;',
  "const f = 'gemini-flash-lite-2';",
  "const g = 'sonnet';",
  "const h = 'claude-opus-4';",
  "const i = 'cli-login:qwen';",
  "const j = await import('@agentdeck/providers');",
  // Дальше — то, что НЕ должно ловиться: слово внутри фразы, комментарий, похожие имена.
  "const k = 'the claude adapter is chosen by the registry';",
  '// claude, sonnet and ANTHROPIC_AUTH_TOKEN in a comment are prose',
  "const l = 'claudette';",
  "const m = 'geminiXflash';",
  "const n = 'localhost:8080';",
  "const o = 'sonnets';",
  "const p = 'cursor-agentXcmd';",
].join('\n');

const PROBE_RULES: [number, string][] = [
  [1, 'providers-import'],
  [2, 'adapter-id'],
  // `claude` — и id переходника, и имя его бинаря.
  [2, 'binary-name'],
  [3, 'vendor-name'],
  [4, 'binary-name'],
  [5, 'env-var'],
  [6, 'env-var-member'],
  [7, 'model-family'],
  [8, 'model-alias'],
  [9, 'model-alias'],
  [10, 'route-id'],
  [11, 'providers-import'],
];

const sorted = (pairs: [number, string][]): [number, string][] =>
  pairs.sort((x, y) => x[0] - y[0] || x[1].localeCompare(y[1]));

describe('P108 literal lint — CLI names only in adapters/ and routes/', () => {
  it('P108 literal lint probe: every forbidden form caught at its line; prose, comments and look-alikes are not', () => {
    const scan = scanSources([{ path: 'conductor/probe.ts', text: PROBE }], P108_CLI_NAMES);
    const got = scan.hits.map((hit) => [hit.line, hit.rule] as [number, string]);
    expect(sorted(got)).toEqual(PROBE_RULES);
    expect(scan.hits[0]?.message).toMatch(/^P108 \(11-providers R:PR-08/);
    // Самая длинная приставка семейства выигрывает: находка называет её целиком.
    expect(scan.hits.find((hit) => hit.rule === 'model-family')?.match).toBe('gemini-flash-lite');
  });

  it('P108 literal lint probe: the same text inside adapters/, routes/, a test, a fixture and p108.ts itself → no finding; platform/ is checked', () => {
    const scan = scanSources(
      [
        { path: 'adapters/claude/run.ts', text: PROBE },
        { path: 'routes/compat/compat.ts', text: PROBE },
        { path: 'conductor/probe.test.ts', text: PROBE },
        { path: 'session-host/__fixtures__/probe.ts', text: PROBE },
        { path: 'literal-lint/p108.ts', text: PROBE },
      ],
      P108_CLI_NAMES,
    );
    expect(scan).toEqual({ hits: [], checked: [] });
    const platform = scanSources([{ path: 'platform/x.ts', text: PROBE }], P108_CLI_NAMES);
    expect(platform.checked).toEqual(['platform/x.ts']);
    expect(platform.hits).toHaveLength(PROBE_RULES.length);
    // `routesX/` — не `routes/`: разрешение по папке, не по приставке строки.
    expect(scanSources([{ path: 'routesX/x.ts', text: PROBE }], P108_CLI_NAMES).checked).toEqual([
      'routesX/x.ts',
    ]);
  });

  it('P108 literal lint allows only the spec folders: adapters/<cli>/, routes/<kind>/, routes/compat, routes/hops (core-s2 F-94)', () => {
    const checked = (path: string): string[] =>
      scanSources([{ path, text: PROBE }], P108_CLI_NAMES).checked;
    // Общие части слоя переходников и маршрутов не называют CLI: они перебирают реестр.
    for (const path of [
      'adapters/launcher/env.ts',
      'adapters/sdk-stream/session.ts',
      'adapters/deny-overlay.ts',
      'adapters/shell-argv.ts',
      'adapters/nocli/x.ts',
      'routes/registry.ts',
      'routes/endpoint.ts',
      'routes/elsewhere/x.ts',
    ])
      expect(checked(path), path).toEqual([path]);
    for (const path of [
      'adapters/claude/run.ts',
      'adapters/qwen/qwen.ts',
      `adapters/${CLI_LITERALS.adapterIds[CLI_LITERALS.adapterIds.length - 1]}/x.ts`,
      'routes/cli-login/cli-login.ts',
      'routes/local/own/own.ts',
      'routes/stub/stub.ts',
      'routes/compat/compat.ts',
      'routes/hops/hop.ts',
      'hop-host/gateway/frames/frames.ts',
    ])
      expect(checked(path), path).toEqual([]);
    // Сосед с тем же началом имени — не процесс звена.
    expect(checked('hop-hostile/x.ts')).toEqual(['hop-hostile/x.ts']);
  });

  it('P108 literal lint is built from the registry: every adapter id, vendor, binary, env var and family is caught; a new CLI joins by itself', () => {
    const one = (value: string, path = 'policy/x.ts'): string[] =>
      scanSources([{ path, text: `const v = ${JSON.stringify(value)};` }], P108_CLI_NAMES).hits.map(
        (hit) => hit.rule,
      );
    for (const id of CLI_LITERALS.adapterIds) expect(one(id), id).toContain('adapter-id');
    for (const vendor of CLI_LITERALS.vendorNames)
      expect(one(vendor), vendor).toContain('vendor-name');
    for (const binary of CLI_LITERALS.binaryNames)
      expect(one(binary), binary).toContain('binary-name');
    for (const name of CLI_LITERALS.envVarNames) expect(one(name), name).toContain('env-var');
    for (const family of CLI_LITERALS.modelFamilyPrefixes)
      expect(one(`${family}-9`), family).toContain('model-family');
    // Алиасы модели — из ступеней фактов (`modelRungs`): и алиас, и полное имя по приставке.
    expect(CLI_LITERALS.modelAliases.length).toBeGreaterThan(0);
    for (const alias of CLI_LITERALS.modelAliases)
      expect(one(`${alias}-9`), alias).toContain('model-alias');
    expect(CLI_LITERALS.adapterIds.length).toBe(CLI_RUN_FACTS.length);
    // Реестр без литерала вида — правило этого вида молчит, а не ловит любую строку.
    const empty: LiteralRuleSet = { ...P108_CLI_NAMES, rules: p108Rules(deriveLiterals([])) };
    expect(
      scanSources([{ path: 'policy/x.ts', text: "const v = 'anything';" }], empty).hits,
    ).toEqual([]);

    // Новый CLI в реестре — новые правила без правки набора.
    const newcomer = {
      ...CLI_RUN_FACTS[0],
      id: 'zeta-cli',
      binary: { command: 'zeta', windowsCommand: 'zeta.cmd' },
      modelVendors: ['zeta-labs'],
      modelLadder: ['zeta-large'],
    } as (typeof CLI_RUN_FACTS)[number];
    const grown: LiteralRuleSet = {
      ...P108_CLI_NAMES,
      rules: p108Rules(deriveLiterals([...CLI_RUN_FACTS, newcomer])),
    };
    const hits = scanSources(
      [
        {
          path: 'conductor/x.ts',
          text: "const a = 'zeta-cli'; const b = 'zeta.cmd'; const c = 'zeta-labs'; const d = 'zeta-large-2';",
        },
      ],
      grown,
    ).hits.map((hit) => hit.rule);
    expect(hits).toEqual(['adapter-id', 'vendor-name', 'binary-name', 'model-family']);
  });
});
