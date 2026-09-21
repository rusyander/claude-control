import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEnvironment,
  CommandItem,
  EnvItem,
  HookItem,
  PluginItem,
  SkillItem,
  SubagentItem,
} from '@agentdeck/contracts/portable-env';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { importEnvironment } from './import/index.ts';
import { emitEnvironment } from './emit/index.ts';

/**
 * Плагины (П2.6): СОДЕРЖИМОЕ едет записями, сама единица — только туда, где её
 * механизм задокументирован.
 *
 * Обе половины проверяются на живых файлах: реестр плагинов Claude
 * разворачивается во временном доме и читается настоящим импортёром, а единица
 * плагина OpenCode уезжает в ВТОРОЙ дом — то есть ровно так, как уезжала бы на
 * другую машину. Рукотворный паспорт, поданный прямо в эмиттер, доказал бы
 * таблицу, а не систему.
 */

/** Идентификатор плагина в реестре: `<плагин>@<магазин>`. */
const PLUGIN_ID = 'review@market';
const SLEEPING_ID = 'sleeping@market';

let home: string;
let claudeEnv: AgentEnvironment;
const savedEnv = { ...process.env };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'portability-plugins-'));
  writeClaudeHome(home);
  claudeEnv = importEnvironment({ provider: claudeProvider, scope: 'global', override: home });
});

afterAll(() => {
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
});

/** Записать файл, создав каталоги по пути. */
function put(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Дом Claude: два плагина в реестре (включённый и выключенный) и СВОЙ скилл с
 * тем же именем, что у скилла плагина. Совпадение имён здесь главное: по `id`
 * идёт идемпотентный upsert, и общий ключ означал бы, что одна запись молча
 * затёрла другую у цели.
 */
function writeClaudeHome(root: string): void {
  const installed = join(root, 'plugins', 'repos', 'review');
  const sleeping = join(root, 'plugins', 'repos', 'sleeping');

  put(
    join(root, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      // Версия реестра — та, которую читает сам CLI: реестр другой версии он не
      // загружает вовсе, и его плагины у человека не действуют.
      version: 2,
      plugins: {
        [PLUGIN_ID]: [{ scope: 'user', installPath: installed, version: '1.4.0' }],
        [SLEEPING_ID]: [{ scope: 'user', installPath: sleeping, version: '0.1.0' }],
      },
    }),
  );
  put(
    join(root, 'settings.json'),
    JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true, [SLEEPING_ID]: false } }),
  );

  // Свой скилл с тем же именем, что у скилла плагина.
  put(
    join(root, 'skills', 'code-review', 'SKILL.md'),
    ['---', 'name: code-review', 'description: Мой собственный разбор', '---', '', 'Моё.', ''].join(
      '\n',
    ),
  );

  put(
    join(installed, 'skills', 'code-review', 'SKILL.md'),
    [
      '---',
      'name: code-review',
      'description: Разбор из плагина',
      '---',
      '',
      'Плагинное.',
      '',
    ].join('\n'),
  );
  put(
    join(installed, 'commands', 'check.md'),
    ['---', 'description: Проверка из плагина', '---', '', 'Проверь.', ''].join('\n'),
  );
  put(
    join(installed, 'agents', 'looker.md'),
    ['---', 'name: looker', 'description: Смотритель', '---', '', 'Смотри.', ''].join('\n'),
  );
  // Хук плагина зовёт СВОЙ каталог переменной: у цели её никто не подставляет.
  put(
    join(installed, 'hooks', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs' }],
          },
        ],
      },
    }),
  );
  put(join(installed, 'hooks', 'guard.mjs'), 'process.exit(0);\n');

  // Выключенный плагин: содержимое у него есть, и оно обязано НЕ поехать.
  put(
    join(sleeping, 'skills', 'sleeping-skill', 'SKILL.md'),
    ['---', 'name: sleeping-skill', 'description: Спящий', '---', '', 'Спит.', ''].join('\n'),
  );
}

function itemsOf<T extends EnvItem>(items: readonly EnvItem[], kind: T['kind']): T[] {
  return items.filter((item): item is T => item.kind === kind);
}

describe('плагины Claude едут содержимым', () => {
  it('включённый плагин раскладывается на записи с пометкой происхождения', () => {
    // Сама единица плагина тоже помечена своим плагином — это её собственное
    // происхождение; содержимым считается всё остальное.
    const fromPlugin = claudeEnv.items.filter(
      (item) => item.source.plugin === PLUGIN_ID && item.kind !== 'plugin',
    );

    expect(fromPlugin.map((item) => item.kind).sort()).toEqual([
      'command',
      'hook',
      'skill',
      'subagent',
    ]);
    // Пометка — не украшение: без неё скилл плагина неотличим от собственного, и
    // человек не узнал бы, что перенёс чужой набор.
    const skill = itemsOf<SkillItem>(fromPlugin, 'skill')[0];
    const command = itemsOf<CommandItem>(fromPlugin, 'command')[0];
    const subagent = itemsOf<SubagentItem>(fromPlugin, 'subagent')[0];
    expect(skill?.description).toBe('Разбор из плагина');
    expect(command?.name).toBe('check');
    expect(subagent?.name).toBe('looker');
  });

  it('скилл плагина и свой скилл того же имени — РАЗНЫЕ записи', () => {
    const skills = itemsOf<SkillItem>(claudeEnv.items, 'skill').filter(
      (item) => item.name === 'code-review',
    );

    expect(skills).toHaveLength(2);
    expect(new Set(skills.map((item) => item.id)).size).toBe(2);
    // Ключ записи из плагина назван плагином: `plugin/<id>/<имя>`.
    const plugged = skills.find((item) => item.source.plugin === PLUGIN_ID);
    expect(plugged?.id).toContain('plugin');
    expect(skills.find((item) => item.source.plugin === null)?.description).toBe(
      'Мой собственный разбор',
    );
  });

  it('хук плагина везёт АБСОЛЮТНЫЙ путь, а не переменную своего каталога', () => {
    const hook = itemsOf<HookItem>(claudeEnv.items, 'hook').find(
      (item) => item.source.plugin === PLUGIN_ID,
    );

    // `${CLAUDE_PLUGIN_ROOT}` подставляет сам Claude. У чужого CLI её не
    // подставляет никто: хук был бы зарегистрирован, а исполнять нечего.
    expect(hook?.command).not.toContain('CLAUDE_PLUGIN_ROOT');
    const script = join(home, 'plugins', 'repos', 'review', 'hooks', 'guard.mjs')
      .split('\\')
      .join('/');
    // Написание ОДНО на всю команду: смешанное `C:\дом\плагин/hooks/x.mjs`
    // распознаватель пути скрипта не увидел бы вовсе (он требует `/`), а
    // оболочка семейства sh съела бы обратные косые как экранирование.
    expect(hook?.command).toContain(script);
    expect(hook?.scriptPath).toBe(script);
  });

  it('выключенный плагин НЕ раскладывается, и сказано, почему', () => {
    const sleeping = itemsOf<PluginItem>(claudeEnv.items, 'plugin').find(
      (item) => item.name === SLEEPING_ID,
    );

    expect(sleeping?.enabled).toBe(false);
    // Ни одной записи выключенного плагина в паспорте нет: у команды и
    // субагента состояния вкл/выкл в каноне нет вовсе, и приехав к цели, они
    // работали бы — а у источника молчат.
    expect(
      claudeEnv.items.some((item) => item.source.plugin === SLEEPING_ID && item.kind !== 'plugin'),
    ).toBe(false);
    expect(
      claudeEnv.skipped.some(
        (skip) => skip.reason === 'disabled' && skip.detail.includes(SLEEPING_ID),
      ),
    ).toBe(true);
  });

  it('плагин как единица везде назван непереносимым — едет его содержимое', () => {
    const unit = itemsOf<PluginItem>(claudeEnv.items, 'plugin').find(
      (item) => item.name === PLUGIN_ID,
    );
    expect(unit?.form).toBe('installed');

    for (const target of [claudeProvider, ...CATALOG_PROVIDERS]) {
      const plan = emitEnvironment(claudeEnv, {
        target,
        scope: 'global',
        override: target.id === 'claude' ? join(home, '.claude-target') : undefined,
      });
      const row = plan.entries.find((entry) => entry.itemId === unit?.id);
      expect(row?.outcome, target.id).toBe('not_transferable');
      expect(row?.verdict.reason, target.id).toBe('unit_not_installable');
    }
  });

  it('реестр чужой версии не даёт ни одной записи, и пропуск называет версию', () => {
    // Дом тот же по раскладке, отличается ОДНИМ числом: иначе пустой паспорт
    // объяснялся бы чем угодно, а не версией реестра.
    const alien = mkdtempSync(join(tmpdir(), 'portability-plugins-v1-'));
    try {
      const installed = join(alien, 'plugins', 'repos', 'review');
      put(
        join(alien, 'plugins', 'installed_plugins.json'),
        JSON.stringify({
          version: 1,
          plugins: { [PLUGIN_ID]: [{ scope: 'user', installPath: installed }] },
        }),
      );
      put(join(alien, 'settings.json'), JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: true } }));
      put(
        join(installed, 'skills', 'code-review', 'SKILL.md'),
        ['---', 'name: code-review', 'description: Разбор из плагина', '---', '', 'Из.', ''].join(
          '\n',
        ),
      );

      const env = importEnvironment({ provider: claudeProvider, scope: 'global', override: alien });

      // Ни единицы, ни содержимого: CLI такой реестр не загружает — у источника
      // эти записи молчат, а у цели заработали бы (инвариант 3).
      expect(env.items.some((item) => item.source.plugin === PLUGIN_ID)).toBe(false);
      expect(itemsOf<PluginItem>(env.items, 'plugin')).toHaveLength(0);
      const skip = env.skipped.find(
        (entry) => entry.kind === 'plugin' && entry.reason === 'unsupported_format',
      );
      expect(skip?.detail).toContain('версии 1');
      expect(skip?.detail).toContain('только версию 2');
    } finally {
      rmSync(alien, { recursive: true, force: true });
    }
  });
});

describe('плагин OpenCode как единица', () => {
  /** Дома источника и цели: перенос идёт МЕЖДУ ними, а не внутри одного. */
  let source: string;
  let target: string;
  let env: AgentEnvironment;

  beforeAll(() => {
    source = join(home, 'opencode-source');
    target = join(home, 'opencode-target');
    put(
      join(source, 'opencode', 'plugins', 'notify.ts'),
      'export const notify = () => console.log("привет");\n',
    );
    put(
      join(source, 'opencode', 'opencode.json'),
      JSON.stringify({ theme: 'мой', plugin: ['@team/opencode-plugin'] }),
    );
    // Чужой ключ и чужой плагин У ЦЕЛИ: перенос обязан оставить оба.
    put(
      join(target, 'opencode', 'opencode.json'),
      JSON.stringify({ model: 'мой', plugin: ['@ним/уже-стоял'] }),
    );

    process.env.XDG_CONFIG_HOME = source;
    delete process.env.OPENCODE_CONFIG;
    const opencode = CATALOG_PROVIDERS.find((provider) => provider.id === 'opencode');
    if (!opencode) throw new Error('провайдера opencode нет в каталоге');
    env = importEnvironment({ provider: opencode, scope: 'global' });
    process.env.XDG_CONFIG_HOME = target;
  });

  /** План для цели плюс применение всех его правок. */
  function emitToTarget() {
    const opencode = CATALOG_PROVIDERS.find((provider) => provider.id === 'opencode');
    if (!opencode) throw new Error('провайдера opencode нет в каталоге');
    const plan = emitEnvironment(env, { target: opencode, scope: 'global' });
    for (const write of plan.writes) write.apply();
    return plan;
  }

  it('файл плагина доезжает содержимым, а имя пакета — строкой списка', () => {
    const plan = emitToTarget();
    const rows = plan.entries.filter((entry) => entry.kind === 'plugin');
    expect(rows.map((row) => row.outcome)).toEqual(['written', 'written']);

    const file = readFileSync(join(target, 'opencode', 'plugins', 'notify.ts'), 'utf8');
    expect(file).toContain('привет');

    const config = JSON.parse(
      readFileSync(join(target, 'opencode', 'opencode.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(config.plugin).toEqual(['@ним/уже-стоял', '@team/opencode-plugin']);
    // Чужой ключ файла цели остаётся по значению.
    expect(config.model).toBe('мой');
  });

  it('повторное применение того же плана не создаёт вторую запись (инвариант 10)', () => {
    emitToTarget();
    const configPath = join(target, 'opencode', 'opencode.json');
    const first = readFileSync(configPath, 'utf8');

    emitToTarget();
    expect(readFileSync(configPath, 'utf8')).toBe(first);
    const config = JSON.parse(first) as { plugin: string[] };
    expect(config.plugin.filter((name) => name === '@team/opencode-plugin')).toHaveLength(1);
  });

  it('чужой файл плагина с тем же именем не затирается, а возвращается выбором', () => {
    put(
      join(target, 'opencode', 'plugins', 'notify.ts'),
      'export const notify = () => console.log("ДРУГОЕ");\n',
    );
    const opencode = CATALOG_PROVIDERS.find((provider) => provider.id === 'opencode');
    if (!opencode) throw new Error('провайдера opencode нет в каталоге');
    const plan = emitEnvironment(env, { target: opencode, scope: 'global' });

    const row = plan.entries.find(
      (entry) => entry.kind === 'plugin' && entry.file?.endsWith('notify.ts'),
    );
    expect(row?.outcome).toBe('collision_needs_choice');
    // Ни одной правки по этому пути план не несёт: выбор между двумя версиями
    // чужого кода человеческий.
    expect(plan.writes.some((write) => write.filePath.endsWith('notify.ts'))).toBe(false);
    expect(readFileSync(join(target, 'opencode', 'plugins', 'notify.ts'), 'utf8')).toContain(
      'ДРУГОЕ',
    );
  });
});
