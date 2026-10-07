import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComparisonInput, ComparisonResult } from './compare.ts';
import { runComparison } from './compare.ts';
import type { PairEntry } from './registry.ts';
import { GlobalLayerError, createGlobalLayer } from './service.ts';

/**
 * Сервис сверки на временном каталоге конфигурации: ни один тест не читает и
 * не пишет настоящий `~/.claude`. Сверка подменена там, где проверяется
 * отметка правки и запись, и настоящая (git, дочерние процессы, модуль сит
 * панели) — там, где проверяется вердикт.
 */

const GLOBAL_MODULE = 'hooks/lib/fake-sieves.mjs';

/** Глобальная сторона-подделка: ловит только `.env` среди добавленных файлов. */
const WEAK_GLOBAL = `export function scanBranch(git, { cwd, base, ref }) {
  const names = git(cwd, ['diff', '--name-only', base, ref]).stdout.split('\\n').filter(Boolean);
  const env = names.filter((name) => name.endsWith('.env'));
  return { blocks: env.length ? [{ id: 'committed-artifacts', items: env }] : [], advisories: [] };
}
`;
/** Она же, но ловит и сфокусированный тест — «предложение» переноса. */
const STRONG_GLOBAL = WEAK_GLOBAL.replace(
  'return { blocks: env.length',
  `const only = git(cwd, ['diff', base, ref]).stdout.includes('.only(') ? names.filter((name) => name.includes('.test.')) : [];
  const blocks = env.length ? [{ id: 'committed-artifacts', items: env }] : [];
  if (only.length) blocks.push({ id: 'debug-leftovers', items: only });
  return { blocks, advisories: [] };
  return { blocks: env.length`,
);

let root: string;
let configRoot: string;
let appData: string;
let backupDir: string;

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function pairWith(corpus: string): PairEntry {
  return {
    id: 'sieves',
    title: { ru: 'Сита', en: 'Sieves' },
    runner: 'sieves',
    corpus: pathToFileURL(corpus).href,
    panel: {
      module: 'apps/server/src/domains/project-git/sieve-facts.ts',
      files: ['apps/server/src/domains/project-git/sieve-scan.ts'],
      tests: ['apps/server/src/domains/project-git/sieve-scan.test.ts'],
    },
    global: { module: GLOBAL_MODULE, files: [GLOBAL_MODULE], tests: ['hooks/tests/fake.test.mjs'] },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-global-layer-'));
  configRoot = join(root, 'claude');
  appData = join(configRoot, 'agentdeck');
  backupDir = join(root, 'backups');
  write(join(configRoot, GLOBAL_MODULE), WEAK_GLOBAL);
});

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const fakeResult = (global = 'g1'): ComparisonResult => ({
  rows: [],
  panel: { ok: true, failing: 0 },
  global: { ok: true, failing: 0 },
  cases: 0,
  hashes: { panel: 'p', global },
});

describe('createGlobalLayer', () => {
  function layer(compare: (input: ComparisonInput) => Promise<ComparisonResult>) {
    let changes = 0;
    const service = createGlobalLayer({
      read: () => ({ configRoot, appData, backupDir }),
      onChange: () => (changes += 1),
      registry: [pairWith(join(root, 'corpus.json'))],
      compare,
    });
    return { service, changes: () => changes };
  }

  it('первая выдача сама запускает сверку, вердикт переживает новый сервис', async () => {
    const { service, changes } = layer(async () => ({
      ...fakeResult(),
      hashes: { panel: 'stable', global: 'stable' },
    }));
    expect(service.list()[0]!.comparing).toBe(true);
    await service.settled('sieves');
    expect(changes()).toBeGreaterThanOrEqual(2);
    const state = JSON.parse(readFileSync(join(appData, 'global-layer', 'state.json'), 'utf8'));
    expect(state.sieves.comparedAt).toBeTypeOf('string');
  });

  it('правка глобального файла после сверки — отметка и новая сверка; ручная сверка её снимает', async () => {
    const { service } = layer((input) => runHashesOnly(input));
    service.list();
    await service.settled('sieves');
    expect(service.list()[0]!.changed).toBeUndefined();

    write(join(configRoot, GLOBAL_MODULE), `${WEAK_GLOBAL}// tweak\n`);
    service.onGlobalChanged();
    const marked = service.list()[0]!;
    expect(marked.changed?.sides).toEqual(['global']);
    expect(marked.comparing).toBe(true);
    await service.settled('sieves');
    // Автоматическая сверка отметку не снимает: правку должен увидеть человек.
    expect(service.list()[0]!.changed?.sides).toEqual(['global']);

    service.compare('sieves');
    await service.settled('sieves');
    expect(service.list()[0]!.changed).toBeUndefined();
  });

  it('предложение пишется в слой только по отпечаткам из диффа и с резервной копией', async () => {
    const { service } = layer((input) => runHashesOnly(input));
    const proposal = join(appData, 'global-layer', 'sieves', 'proposal', GLOBAL_MODULE);
    write(proposal, STRONG_GLOBAL);

    const shown = service.proposal('sieves');
    expect(shown.files).toHaveLength(1);
    const file = shown.files[0]!;
    expect(file).toMatchObject({ path: GLOBAL_MODULE, isNew: false });
    expect(file.added).toBeGreaterThan(0);

    expect(() =>
      service.apply('sieves', { files: [{ ...file, afterSha: 'not-what-was-shown' }] }),
    ).toThrow(GlobalLayerError);
    expect(readFileSync(join(configRoot, GLOBAL_MODULE), 'utf8')).toBe(WEAK_GLOBAL);

    expect(() =>
      service.apply('sieves', {
        files: [{ path: 'hooks/other.mjs', beforeSha: 'x', afterSha: 'y' }],
      }),
    ).toThrow(/not a proposal/);

    const applied = service.apply('sieves', { files: [file] });
    expect(applied.written).toEqual([GLOBAL_MODULE]);
    expect(readFileSync(join(configRoot, GLOBAL_MODULE), 'utf8')).toBe(STRONG_GLOBAL);
    expect(readFileSync(applied.backups[0]!, 'utf8')).toBe(WEAK_GLOBAL);
    expect(readdirSync(backupDir)[0]).toMatch(/^global-layer__hooks__lib__fake-sieves\.mjs\./);
    expect(existsSync(proposal)).toBe(false);
    await service.settled('sieves');
  });

  it('задание переноса в глобальный слой запрещает писать в слой и называет каталог предложения', () => {
    const { service } = layer((input) => runHashesOnly(input));
    const task = service.transfer('sieves', { direction: 'toGlobal', sieve: 'debug-leftovers' });
    const dir = join(appData, 'global-layer', 'sieves', 'proposal').replace(/\\/g, '/');
    expect(task.prompt).toContain(`Do NOT edit anything under ${configRoot.replace(/\\/g, '/')}`);
    expect(task.prompt).toContain(`--proposal ${dir}`);
    expect(task.prompt).toContain('sieve `debug-leftovers`');
    expect(existsSync(dir)).toBe(true);

    const back = service.transfer('sieves', { direction: 'toPanel' });
    expect(back.prompt).toContain('Edit the panel files in this working copy. Do not commit.');
    expect(back.prompt).not.toContain('--proposal');
  });

  it('незнакомая пара — ошибка с кодом, а не падение', () => {
    const { service } = layer((input) => runHashesOnly(input));
    expect(() => service.compare('nope')).toThrow(
      expect.objectContaining({ code: 'unknown-pair' }),
    );
  });
});

/** Подменная сверка, которая честно считает отпечатки сторон, — для отметки правки. */
async function runHashesOnly(input: ComparisonInput): Promise<ComparisonResult> {
  const { fingerprint, PANEL_REPO_ROOT } = await import('./compare.ts');
  return {
    ...fakeResult(),
    hashes: {
      panel: fingerprint(input.repoRoot ?? PANEL_REPO_ROOT, input.pair.panel.files),
      global: fingerprint(input.configRoot, input.pair.global.files),
    },
  };
}

describe('runComparison — настоящие репозитории и процессы сторон', () => {
  const corpus = {
    base: { 'README.md': '# demo\n', 'src/app.ts': 'export const a = 1;\n' },
    cases: [
      {
        id: 'env-file',
        title: { ru: 'env file', en: 'env file' },
        branch: { '.env': 'TOKEN=abc\n' },
        expect: { 'committed-artifacts': ['.env'] },
      },
      {
        id: 'only',
        title: { ru: 'focused test', en: 'focused test' },
        branch: { 'src/app.test.ts': "it.only('a', () => {});\n" },
        expect: { 'debug-leftovers': ['src/app.test.ts'] },
      },
      {
        id: 'placeholder',
        title: { ru: 'placeholder key', en: 'placeholder key' },
        branch: { 'README.md': '# demo\nKEY={{secret:sk-placeholder}}\n' },
        expect: { secrets: [] },
      },
    ],
  };

  it('вердикт по поведению: каждая сторона лучше там, где права только она', async () => {
    write(join(root, 'corpus.json'), JSON.stringify(corpus));
    const pair = pairWith(join(root, 'corpus.json'));
    const result = await runComparison({ pair, configRoot });
    const verdict = Object.fromEntries(result.rows.map((row) => [row.sieve, row.verdict]));
    expect(verdict).toEqual({
      'committed-artifacts': 'equal',
      'debug-leftovers': 'panel',
      secrets: 'global',
    });
    expect(result.panel).toMatchObject({ ok: true, failing: 1 });
    expect(result.global).toMatchObject({ ok: true, failing: 1 });

    // Предложение ложится поверх слоя в копии: сверка меряет его, слой не тронут.
    const proposalDir = join(root, 'proposal');
    write(join(proposalDir, GLOBAL_MODULE), STRONG_GLOBAL);
    const proposed = await runComparison({ pair, configRoot, proposalDir });
    expect(proposed.rows.find((row) => row.sieve === 'debug-leftovers')!.verdict).toBe('equal');
    expect(proposed.global.failing).toBe(0);
    expect(readFileSync(join(configRoot, GLOBAL_MODULE), 'utf8')).toBe(WEAK_GLOBAL);
  }, 120_000);

  it('нет модуля глобальной стороны — сторона не прошла, панель всё равно измерена', async () => {
    write(join(root, 'corpus.json'), JSON.stringify({ ...corpus, cases: [corpus.cases[0]] }));
    rmSync(join(configRoot, GLOBAL_MODULE));
    const result = await runComparison({ pair: pairWith(join(root, 'corpus.json')), configRoot });
    expect(result.global).toMatchObject({ ok: false, error: `missing ${GLOBAL_MODULE}` });
    expect(result.panel).toMatchObject({ ok: true, failing: 0 });
    expect(result.rows[0]!.verdict).toBe('panel');
  }, 60_000);
});
