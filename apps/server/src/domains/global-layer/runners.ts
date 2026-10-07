import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Род пары — как прогнать сторону на репозитории случая и привести ответ к
 * общему виду «сита → отмеченное». Исполняется в ОТДЕЛЬНОМ процессе
 * (`run-side.ts`): модуль стороны грузится заново на каждую сверку, и после
 * правки файла панель меряет файл на диске, а не то, что держит в памяти.
 */

/** Ответ стороны на случае: сита → отмеченные файлы или имена. */
export type SideFindings = Record<string, string[]>;

export type SideRunner = (input: { module: string; cwd: string }) => Promise<SideFindings>;

/** Механика сит панели (`SieveMechanics`) → id ситы каталога. */
const PANEL_SIEVES: Readonly<Record<string, string>> = {
  secrets: 'secrets',
  debugLeftovers: 'debug-leftovers',
  artifacts: 'committed-artifacts',
  lockfiles: 'lockfile-sync',
  envVars: 'env-config',
  untestedCode: 'tests-alongside',
  destructive: 'migration-safety',
};

/** Блок `push-sieves` → id ситы каталога: у потребителей имя в хуке короче. */
const GLOBAL_BLOCKS: Readonly<Record<string, string>> = { consumers: 'consumers-repo-wide' };

/** Подсказки хука — строкой: перечень после первой скобки или после «in». */
function advisoryItems(text: string): { sieve: string; items: string[] } | undefined {
  const sieve = /^([\w-]+):/.exec(text)?.[1];
  if (!sieve) return undefined;
  if (sieve === 'tests-alongside') {
    const list = /\(([^)]*)\)/.exec(text)?.[1] ?? '';
    return { sieve, items: list.split(', ').filter((item) => item && item !== '…') };
  }
  if (sieve === 'migration-safety') {
    const list = / in (.+?) — /.exec(text)?.[1] ?? '';
    return { sieve, items: list.split(', ').filter(Boolean) };
  }
  return undefined;
}

function sortedFindings(found: SideFindings): SideFindings {
  return Object.fromEntries(
    Object.entries(found).map(([sieve, items]) => [sieve, [...new Set(items)].sort()]),
  );
}

async function panelSieves({ module, cwd }: { module: string; cwd: string }) {
  const { readSieveFacts } = (await import(pathToFileURL(module).href)) as {
    readSieveFacts: (input: { cwd: string }) => Promise<{
      mechanics: Record<string, unknown>;
      unchecked?: string[];
    }>;
  };
  const facts = await readSieveFacts({ cwd });
  if (facts.unchecked?.some((reason) => reason.startsWith('no-'))) {
    throw new Error(`panel: ${facts.unchecked.join(', ')}`);
  }
  const found: SideFindings = {};
  for (const [key, value] of Object.entries(facts.mechanics)) {
    if (key === 'consumers' && Array.isArray(value)) {
      found['consumers-repo-wide'] = (value as { token: string }[]).map((hit) => hit.token);
      continue;
    }
    const sieve = PANEL_SIEVES[key];
    if (sieve && Array.isArray(value)) found[sieve] = value as string[];
  }
  return sortedFindings(found);
}

/** git для хука — его собственная форма: синхронно, `{code, stdout}`. */
function syncGit(cwd: string, args: string[]): { code: number; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: result.status ?? -1, stdout: result.stdout ?? '' };
}

async function globalSieves({ module, cwd }: { module: string; cwd: string }) {
  const { scanBranch } = (await import(pathToFileURL(module).href)) as {
    scanBranch: (
      git: typeof syncGit,
      input: { cwd: string; base: string; ref: string },
    ) => { blocks: { id: string; items: string[] }[]; advisories: string[] };
  };
  const base = syncGit(cwd, ['merge-base', 'origin/main', 'HEAD']).stdout.trim();
  if (!base) throw new Error('global: no merge-base with origin/main');
  const out = scanBranch(syncGit, { cwd, base, ref: 'HEAD' });
  const found: SideFindings = {};
  for (const block of out.blocks) found[GLOBAL_BLOCKS[block.id] ?? block.id] = block.items;
  for (const advisory of out.advisories) {
    const parsed = advisoryItems(advisory);
    if (parsed) found[parsed.sieve] = parsed.items;
  }
  return sortedFindings(found);
}

export const RUNNERS: Readonly<Record<string, { panel: SideRunner; global: SideRunner }>> = {
  sieves: { panel: panelSieves, global: globalSieves },
};

export { advisoryItems };
