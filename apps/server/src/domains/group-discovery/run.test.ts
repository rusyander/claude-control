import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blockLang } from '@agentdeck/contracts/brand';
import type { DiscoveredGroup } from '@agentdeck/contracts/group-sources';
import { readGroupSources, updateGroupSources } from '../../lib/app-store/group-sources.ts';
import { readJsonLoose } from '../groups/answer-block.ts';
import type { GroupAsk } from '../groups/model.ts';
import { chunkInventory, projectLayout, readInventory } from './inventory.ts';
import {
  DISCOVERY_FILE,
  discoveryErrorCode,
  discoveryView,
  readDiscoveryCache,
  resetDiscoveryRuns,
  settleCacheKeys,
  startDiscovery,
  type DiscoveryCache,
} from './run.ts';
import type { DiscoverySpec } from './sources.ts';
import { CLI_TIMEOUT_ERROR } from '../assistant-runner/cli.ts';

/**
 * Прогон обнаружения без модели: ответ подаёт тест. Проверяется то, что
 * сломалось на живом кэше владельца: ответ не той формы, опись без предметов,
 * длинная опись и старые ключи кэша.
 */

const GROUPS = { groups: [{ name: 'Review loop', members: [{ kind: 'skill', id: 'a' }] }] };

describe('чтение ответа модели: терпимо к форме', () => {
  const read = (text: string) => readJsonLoose(text, 'group-discover', 'groups');

  it('наш блок', () => {
    expect(read(`\`\`\`${blockLang('group-discover')}\n${JSON.stringify(GROUPS)}\n\`\`\``)).toEqual(
      GROUPS,
    );
  });

  it('блок ```json вместо нашего', () => {
    expect(read(`Вот наборы:\n\`\`\`json\n${JSON.stringify(GROUPS)}\n\`\`\`\n`)).toEqual(GROUPS);
  });

  it('вступление и голый JSON без блока — объект целиком', () => {
    const whole = { ...GROUPS, note: 'one' };
    expect(read(`I found one bundle. ${JSON.stringify(whole)} Done.`)).toEqual(whole);
  });

  it('пример формы в тексте не заслоняет ответ в блоке', () => {
    const fence = '```';
    const text = `Format is {"groups":[]}.\n${fence}json\n${JSON.stringify(GROUPS)}\n${fence}\n`;
    expect(read(text)).toEqual(GROUPS);
  });

  it('оборванный ответ: целые элементы спасены, недописанный отброшен', () => {
    const cut =
      '```json\n{"groups":[{"name":"A","members":[]},{"name":"B","members":[]},{"name":"C","mem';
    expect(read(cut)).toEqual({
      groups: [
        { name: 'A', members: [] },
        { name: 'B', members: [] },
      ],
    });
  });

  it('проза без JSON — ничего', () => {
    expect(read('Наборов здесь нет.')).toBeUndefined();
  });
});

describe('прогон обнаружения', () => {
  let root: string;
  let appData: string;
  let asked: string[];

  const skill = (dir: string, id: string, description: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${description}\n---\n\nbody\n`,
      'utf8',
    );
  };
  const spec = (source: string, projectRoot: string): DiscoverySpec => ({
    source,
    kind: 'project',
    root: projectRoot,
    providerId: 'claude',
    layout: projectLayout(projectRoot),
  });
  const askWith =
    (reply: (data: string) => string): GroupAsk =>
    async (messages) => {
      asked.push(messages[0]!.content);
      return reply(messages[0]!.content);
    };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-discovery-run-'));
    appData = join(root, 'appdata');
    mkdirSync(appData, { recursive: true });
    asked = [];
    resetDiscoveryRuns();
  });

  afterEach(() => {
    resetDiscoveryRuns();
    rmSync(root, { recursive: true, force: true });
  });

  // Ревью 28.09 (F-05): команда хука и адрес MCP уходили модели и в кэш
  // поиска дословно — вместе с `--token x` и `?api_key=`.
  it('токены в командах хуков и адресах MCP — маской в промпте и в кэше', async () => {
    const token = ['sk-ant-', 'api03-', 'Qw8eRt6yUi4oPa2sDf0gHj'].join('');
    const key = ['QQ7kLmN0pQrS7t', 'UvWxYz12345'].join('');
    const shop = join(root, 'secrets');
    mkdirSync(join(shop, '.claude'), { recursive: true });
    writeFileSync(
      join(shop, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: `notify --token ${token}` }] }],
        },
      }),
    );
    writeFileSync(
      join(shop, '.mcp.json'),
      JSON.stringify({
        mcpServers: { remote: { url: `https://h.example.com/mcp?api_key=${key}` } },
      }),
    );
    await startDiscovery(
      appData,
      [spec('X:/secrets', shop)],
      askWith(() => JSON.stringify({ groups: [] })),
      'prompt',
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('notify --token');
    for (const secret of [token, key]) {
      expect(asked[0]).not.toContain(secret);
      expect(JSON.stringify(readDiscoveryCache(appData))).not.toContain(secret);
    }
  });

  // Ревью 28.09 (F-187): у повторного имени без латиницы суффикс терял запасной
  // `group` — ключ выходил `<источник>#-2`.
  it('тёзки без латиницы в имени: ключи `#group` и `#group-2`', async () => {
    const shop = join(root, 'stars');
    skill(join(shop, '.claude', 'skills'), 'a', 'one');
    skill(join(shop, '.claude', 'skills'), 'b', 'two');
    const both = [
      { kind: 'skill', id: 'a' },
      { kind: 'skill', id: 'b' },
    ];
    await startDiscovery(
      appData,
      [spec('X:/stars', shop)],
      askWith(() =>
        JSON.stringify({
          groups: [
            { name: '★★', members: both },
            { name: '★★', members: both },
          ],
        }),
      ),
      'prompt',
    );
    const keys = readDiscoveryCache(appData).sources['X:/stars']?.groups.map((g) => g.key);
    expect(keys).toEqual(['X:/stars#group', 'X:/stars#group-2']);
  });

  // Ревью 28.09 (F-188): запись кэша упала — прогон кончился, а необработанные
  // источники навсегда оставались «идёт» в журнале.
  it('сбой записи кэша: ни один источник не остаётся «идёт»', async () => {
    mkdirSync(join(appData, DISCOVERY_FILE), { recursive: true });
    const specs = ['p1', 'p2', 'p3'].map((name) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return spec(`X:/${name}`, dir);
    });
    await startDiscovery(
      appData,
      specs,
      askWith(() => ''),
      'prompt',
    ).catch(() => undefined);
    const states = discoveryView(appData, specs).sources.map((item) => item.state);
    expect(states).not.toContain('running');
  });

  it('пустая опись модель не зовёт', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty, { recursive: true });
    await startDiscovery(
      appData,
      [spec('X:/empty', empty)],
      askWith(() => ''),
      'prompt',
    );
    expect(asked).toHaveLength(0);
    expect(readDiscoveryCache(appData).sources['X:/empty']?.groups).toEqual([]);
  });

  it('один предмет — набора не бывает, модель не зовётся', async () => {
    const one = join(root, 'one');
    skill(join(one, '.claude', 'skills'), 'a', 'only');
    await startDiscovery(
      appData,
      [spec('X:/one', one)],
      askWith(() => ''),
      'prompt',
    );
    expect(asked).toHaveLength(0);
    expect(readDiscoveryCache(appData).sources['X:/one']).toMatchObject({ groups: [] });
  });

  it('имя, «Когда» и «почему» — на двух языках; находки старого вида спрашиваются заново один раз', async () => {
    const shop = join(root, 'shop');
    skill(join(shop, '.claude', 'skills'), 'a', 'release');
    skill(join(shop, '.claude', 'skills'), 'b', 'notes');
    const pair = (ru: string, en: string) => ({ ru, en });
    const reply = (): string =>
      `\`\`\`json\n${JSON.stringify({
        groups: [
          {
            name: pair('Выпуск релиза', 'Release shipping'),
            when: pair('Когда выпускаем релиз', 'When shipping a release'),
            why: pair('Скиллы выпускают релиз вместе.', 'The skills ship a release together.'),
            members: [
              { kind: 'skill', id: 'a' },
              { kind: 'skill', id: 'b' },
            ],
          },
        ],
      })}\n\`\`\``;
    // Кэш прошлого вида: та же опись, находка без второго языка.
    await startDiscovery(
      appData,
      [spec('X:/shop', shop)],
      askWith(
        () =>
          `\`\`\`json\n${JSON.stringify({
            groups: [
              {
                name: 'Release shipping',
                members: [
                  { kind: 'skill', id: 'a' },
                  { kind: 'skill', id: 'b' },
                ],
              },
            ],
          })}\n\`\`\``,
      ),
      'prompt',
    );
    const cache = readDiscoveryCache(appData);
    delete (cache.sources['X:/shop'] as { textVersion?: number }).textVersion;
    writeFileSync(join(appData, DISCOVERY_FILE), JSON.stringify(cache), 'utf8');
    resetDiscoveryRuns();
    asked = [];

    await startDiscovery(appData, [spec('X:/shop', shop)], askWith(reply), 'prompt');
    expect(asked).toHaveLength(1);
    const found = readDiscoveryCache(appData).sources['X:/shop']!.groups[0]!;
    expect(found.name).toBe('Release shipping');
    expect(found.localized).toEqual({
      name: pair('Выпуск релиза', 'Release shipping'),
      when: pair('Когда выпускаем релиз', 'When shipping a release'),
      why: pair('Скиллы выпускают релиз вместе.', 'The skills ship a release together.'),
    });

    // Дальше опись та же — модель больше не зовётся.
    resetDiscoveryRuns();
    asked = [];
    await startDiscovery(appData, [spec('X:/shop', shop)], askWith(reply), 'prompt');
    expect(asked).toHaveLength(0);
  });

  it('длинная опись идёт частями, находки частей складываются', async () => {
    const big = join(root, 'big');
    const dir = join(big, '.claude', 'skills');
    for (let i = 0; i < 200; i += 1) {
      skill(dir, `s${String(i).padStart(3, '0')}`, `skill number ${i} `.repeat(10));
    }
    const items = readInventory(projectLayout(big));
    expect(chunkInventory(items).length).toBeGreaterThan(1);

    const reply = (data: string): string => {
      const id = /^- skill (\S+):/m.exec(data)?.[1];
      return `\`\`\`json\n${JSON.stringify({
        groups: [{ name: `Set ${id}`, members: [{ kind: 'skill', id }] }],
      })}\n\`\`\``;
    };
    await startDiscovery(appData, [spec('X:/big', big)], askWith(reply), 'prompt');
    const found = readDiscoveryCache(appData).sources['X:/big']!;
    expect(asked.length).toBe(chunkInventory(items).length);
    expect(asked.every((data) => data.length < 30_000)).toBe(true);
    expect(found.groups).toHaveLength(asked.length);
    expect(new Set(found.groups.map((group) => group.key)).size).toBe(asked.length);
  });

  it('непрочитанный ответ уходит в лог отрывком, а в карточку — только «unreadable»', async () => {
    const two = join(root, 'two');
    skill(join(two, '.claude', 'skills'), 'a', 'first');
    skill(join(two, '.claude', 'skills'), 'b', 'second');
    const logged: { source: string; excerpt: string }[] = [];
    await startDiscovery(
      appData,
      [spec('X:/two', two)],
      askWith(() => 'Наборов здесь нет, всё разрозненно.'),
      'prompt',
      undefined,
      (source, excerpt) => logged.push({ source, excerpt }),
    );
    expect(logged).toEqual([{ source: 'X:/two', excerpt: 'Наборов здесь нет, всё разрозненно.' }]);
    const view = discoveryView(appData, [spec('X:/two', two)]);
    expect(view.sources[0]).toMatchObject({
      state: 'failed',
      error: 'unreadable',
      errorCode: 'unreadable',
    });
  });

  it('журнал не показывает снятых источников, сбой назван кодом, а не текстом CLI', async () => {
    const one = join(root, 'one');
    const gone = join(root, 'gone');
    for (const dir of [one, gone]) {
      skill(join(dir, '.claude', 'skills'), 'a', 'first');
      skill(join(dir, '.claude', 'skills'), 'b', 'second');
    }
    const specs = [spec('X:/one', one), spec('X:/gone', gone)];
    await startDiscovery(
      appData,
      specs,
      async () => {
        throw new Error(CLI_TIMEOUT_ERROR);
      },
      'prompt',
    );
    // Тот же сервер (ход прогона в памяти) и перезапущенный (только кэш).
    for (const restart of [false, true]) {
      if (restart) resetDiscoveryRuns();
      const view = discoveryView(appData, [spec('X:/one', one)]);
      expect(view.sources.map((item) => item.source)).toEqual(['X:/one']);
      expect(view.sources[0]).toMatchObject({ state: 'failed', errorCode: 'timeout' });
    }
    expect(discoveryErrorCode('spawn ENOENT')).toBe('failed');
  });
});

describe('ключи кэша обнаружения', () => {
  /**
   * Тот же каталог старым написанием. Регистр путей не различает только
   * Windows: на Linux и macOS `c:/work/p` и `C:/work/p` — два разных каталога,
   * и склеивать их там было бы ошибкой. Слэши и хвостовой слэш ключ сводит
   * везде — ими старое написание и задаётся вне Windows.
   */
  const win = process.platform === 'win32';
  const OLD = win ? 'c:/work/p' : 'C:/work/p/';
  const OLD_BACKSLASH = win ? 'c:\\work\\p' : 'C:\\work\\p\\';
  const found = (source: string, name: string): DiscoveredGroup =>
    ({ key: `${source}#${name}`, name, foundIn: source }) as DiscoveredGroup;
  const entry = (source: string, name: string) => ({
    inventoryHash: 'h',
    at: '2026-09-26T00:00:00.000Z',
    groups: [found(source, name)],
  });

  it('запись под другим написанием пути переезжает к живому ключу вместе с находками', () => {
    const cache: DiscoveryCache = { version: 1, sources: { [OLD]: entry(OLD, 'x') } };
    const renamed = settleCacheKeys(cache, [{ source: 'C:/work/p' }]);
    expect(Object.keys(cache.sources)).toEqual(['C:/work/p']);
    expect(cache.sources['C:/work/p']!.groups[0]).toMatchObject({
      key: 'C:/work/p#x',
      foundIn: 'C:/work/p',
    });
    expect(renamed?.get(`${OLD}#x`)).toBe('C:/work/p#x');
  });

  it('дубль под старым написанием выбрасывается, живая запись не перезаписывается', () => {
    const cache: DiscoveryCache = {
      version: 1,
      sources: {
        'C:/work/p': entry('C:/work/p', 'fresh'),
        [OLD_BACKSLASH]: entry(OLD_BACKSLASH, 'stale'),
      },
    };
    settleCacheKeys(cache, [{ source: 'C:/work/p' }]);
    expect(Object.keys(cache.sources)).toEqual(['C:/work/p']);
    expect(cache.sources['C:/work/p']!.groups[0]!.name).toBe('fresh');
  });

  // Ревью 28.09 (F-184): ключи выброшенного дубля не попадали в `renamed` —
  // импорт под старым ключом сиротел, находка снова «новая», повторный импорт
  // заводил вторую группу.
  it('выброшенный дубль тоже отдаёт свои ключи импорта живому написанию', () => {
    const cache: DiscoveryCache = {
      version: 1,
      sources: { 'C:/work/p': entry('C:/work/p', 'review'), [OLD]: entry(OLD, 'review') },
    };
    const renamed = settleCacheKeys(cache, [{ source: 'C:/work/p' }]);
    expect(renamed?.get(`${OLD}#review`)).toBe('C:/work/p#review');
  });

  it('импорт находки переезжает на новый ключ в group-sources.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-discovery-keys-'));
    try {
      const cache: DiscoveryCache = {
        version: 1,
        sources: { [OLD]: entry(OLD, 'x') },
      };
      writeFileSync(join(root, DISCOVERY_FILE), JSON.stringify(cache), 'utf8');
      updateGroupSources(root, (state) => {
        state.imported[`${OLD}#x`] = 'group-1';
      });
      const live = [{ source: 'C:/work/p' } as DiscoverySpec];
      discoveryView(root, live);
      expect(readGroupSources(root).imported).toEqual({ 'C:/work/p#x': 'group-1' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
