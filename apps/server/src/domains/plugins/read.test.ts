import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Кэш установленных плагинов. Список отдаёт CLI — запуск процесса, который в
 * поиске стоил секунды на каждый набранный символ. Здесь проверяется, что
 * повторное чтение вскользь обходится без запуска, что срок жизни кэша
 * соблюдается, и что операция самой панели немедленно его обнуляет.
 *
 * CLI подменён: тесту важно, сколько раз читалка к нему пошла, а не что он ответит.
 */
const runClaude = vi.hoisted(() => vi.fn());
vi.mock('./cli.ts', () => ({ runClaude }));

const { readInstalledPluginsCached, forgetInstalledPlugins, readPlugins } =
  await import('./read.ts');
const { enablePlugin } = await import('./actions.ts');

const listing = JSON.stringify([{ id: 'demo@market', name: 'demo', enabled: true }]);

describe('readInstalledPluginsCached', () => {
  beforeEach(() => {
    runClaude.mockReset();
    runClaude.mockResolvedValue({ stdout: listing, stderr: '' });
    forgetInstalledPlugins();
  });

  it('первый вызов идёт в CLI, повторный отвечает из кэша', async () => {
    const first = await readInstalledPluginsCached('claude', 1_000);
    const second = await readInstalledPluginsCached('claude', 1_500);

    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(first[0]?.id).toBe('demo@market');
  });

  it('после истечения срока жизни спрашивает CLI заново', async () => {
    await readInstalledPluginsCached('claude', 1_000);
    await readInstalledPluginsCached('claude', 40_000);

    expect(runClaude).toHaveBeenCalledTimes(2);
  });

  it('смена команды CLI не отдаёт чужой кэш', async () => {
    await readInstalledPluginsCached('claude', 1_000);
    await readInstalledPluginsCached('claude.cmd', 1_100);

    expect(runClaude).toHaveBeenCalledTimes(2);
  });

  it('операция над плагином обнуляет кэш', async () => {
    await readInstalledPluginsCached('claude', 1_000);
    await enablePlugin('demo@market', 'claude');
    await readInstalledPluginsCached('claude', 1_100);

    // Три вызова: список, сама операция, список заново.
    expect(runClaude).toHaveBeenCalledTimes(3);
  });

  it('раздел плагинов кэш не использует — каждый его запрос идёт в CLI', async () => {
    await readPlugins('/nowhere', 'claude');
    await readPlugins('/nowhere', 'claude');

    expect(runClaude).toHaveBeenCalledTimes(2);
  });

  it('недоступный CLI не роняет чтение и не запоминает пустоту навсегда', async () => {
    runClaude.mockRejectedValueOnce(new Error('claude not found'));
    expect(await readInstalledPluginsCached('claude', 1_000)).toEqual([]);

    forgetInstalledPlugins();
    expect(await readInstalledPluginsCached('claude', 1_100)).toHaveLength(1);
  });
});

/**
 * Чего `plugin list` не говорит: описание (лежит в манифесте по пути установки),
 * пропавший каталог (CLI перечисляет плагин как ни в чём не бывало) и причина,
 * по которой списка нет вовсе. Маркетплейс из папки подписывался словом
 * «directory» — видом источника вместо адреса.
 */
describe('readPlugins: чего CLI не говорит', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-plugins-'));
    runClaude.mockReset();
    forgetInstalledPlugins();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('описание — из манифеста установленного плагина; пропавший каталог помечен', async () => {
    const present = join(root, 'cache', 'm', 'a', '1.0.0');
    mkdirSync(join(present, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(present, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'a', description: 'Из манифеста' }),
    );
    runClaude.mockResolvedValue({
      stdout: JSON.stringify([
        { id: 'a@m', enabled: true, installPath: present },
        { id: 'b@m', enabled: true, installPath: join(root, 'cache', 'm', 'b', 'gone') },
      ]),
      stderr: '',
    });

    const { installed, notes } = await readPlugins(root, 'claude');

    expect(installed[0]).toMatchObject({ id: 'a@m', description: 'Из манифеста' });
    expect(installed[0]?.installPathMissing).toBeUndefined();
    expect(installed[1]).toMatchObject({ id: 'b@m', installPathMissing: true });
    expect(notes).toEqual([]);
  });

  it('отказ CLI — пустой список и причина, а не молчаливый ноль', async () => {
    runClaude.mockRejectedValue(
      Object.assign(new Error('Command failed'), { stderr: "'claude' is not recognized\n" }),
    );

    const { installed, notes } = await readPlugins(root, 'claude');

    expect(installed).toEqual([]);
    expect(notes).toEqual([expect.stringContaining("'claude' is not recognized")]);
  });

  it('источник маркетплейса: путь у папки, owner/repo у GitHub, URL у git', async () => {
    runClaude.mockResolvedValue({ stdout: '[]', stderr: '' });
    mkdirSync(join(root, 'plugins'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        dir: { source: { source: 'directory', path: 'C:\\market' }, installLocation: 'C:\\market' },
        gh: { source: { source: 'github', repo: 'owner/repo' } },
        url: { source: { source: 'git', url: 'https://example.com/m.git' } },
      }),
    );

    const { marketplaces } = await readPlugins(root, 'claude');

    expect(marketplaces.map((m) => [m.name, m.source])).toEqual([
      ['dir', 'C:\\market'],
      ['gh', 'owner/repo'],
      ['url', 'https://example.com/m.git'],
    ]);
  });
});
