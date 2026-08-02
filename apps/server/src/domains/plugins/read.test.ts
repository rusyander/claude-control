import { describe, it, expect, beforeEach, vi } from 'vitest';

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
