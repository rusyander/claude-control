import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envItemKinds } from '@agentdeck/contracts/portable-env';
import type {
  EnvItem,
  EnvItemKind,
  HookItem,
  InstructionsItem,
  McpServerItem,
  PermissionItem,
  SecretItem,
  SkillItem,
  SubagentItem,
} from '@agentdeck/contracts/portable-env';
import { agentEnvironmentSchema } from '@agentdeck/contracts/portable-env-schema';
import { claudeProvider } from '../../providers/claude.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog.ts';
import { importClaudeEnvironment } from './import/claude.ts';
import { hasImporter, importEnvironment, importerProviderIds } from './import/index.ts';
import {
  DEFAULT_INSTRUCTION_FILES_MODE,
  readInstructionFilesChoice,
  resolveInstructionSources,
} from '../../lib/instruction-files.ts';
import { UnknownImportProviderError } from './types.ts';

/**
 * Импортёры среды (П0.2): десять CLI → канон.
 *
 * Проверяется ровно то, на чём партия стоит, и каждый раз НА ЖИВЫХ ФАЙЛАХ —
 * эталонный дом разворачивается во временном каталоге, а импортёр читает его тем
 * же кодом, каким читает дом человека. Рукотворные структуры, поданные прямо в
 * нормализатор, доказали бы таблицу, а не систему.
 *
 * Значение секрета в эталоне НАСТОЯЩЕЕ и уникальное: проверка ищет его во всём
 * теле паспорта. Проверка, которая не может покраснеть, — украшение, поэтому
 * маркер подобран так, что случайно совпасть ему не с чем.
 */

/** Значение-маркер: если оно доедет до канона — проверка обязана покраснеть. */
const SECRET_VALUE = 'sk-ant-МАРКЕР-9f3a2b7c-НЕ-ДОЛЖЕН-УТЕЧЬ';

/** Короткий секрет: на нём видно, посчитана маска от значения или от маски. */
const SHORT_SECRET = 'abc12345';

let home: string;
/** Домашний каталог чужих CLI: у codex/gemini свой дом, а не `override`. */
let foreignHome: string;
const savedEnv = { ...process.env };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'portability-import-'));
  writeHome(home);

  // Каталоги чужих CLI считаются от домашнего каталога и задокументированных
  // переменных ПРИ ВЫЗОВЕ — подменяем их до первого обращения.
  foreignHome = mkdtempSync(join(tmpdir(), 'portability-foreign-'));
  process.env.HOME = foreignHome;
  process.env.USERPROFILE = foreignHome;
  process.env.CODEX_HOME = join(foreignHome, '.codex');
});

afterAll(() => {
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME']) {
    // Присвоение `undefined` записало бы строку «undefined» — переменную надо
    // именно убрать, иначе следующий файл тестов читал бы несуществующий дом.
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(foreignHome, { recursive: true, force: true });
});

/** Эталонный дом Claude: по одному живому представителю каждого раздела. */
function writeHome(root: string): void {
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(root, 'skills', 'synced', 'from-account'), { recursive: true });
  // Скилл `demo` есть и свой, и синхронизированный с аккаунтом: одно имя, две
  // разные записи одного дома.
  mkdirSync(join(root, 'skills', 'synced', 'demo'), { recursive: true });
  // CLI читает ОБА файла инструкций: `CLAUDE.md` в корне и `.claude/CLAUDE.md`.
  // Имена файлов совпадают, и по `basename` они давали одну запись канона.
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, 'commands'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });

  writeFileSync(
    join(root, 'settings.json'),
    JSON.stringify({
      // Короткое значение НАРОЧНО: список панели маскирует такое целиком
      // (`••••••••`), и маска, посчитанная от него второй раз, ничем не
      // отличалась бы от маски настоящего ключа — проверке нечего было бы
      // ловить.
      env: { EDITOR: 'code', ANTHROPIC_API_KEY: SECRET_VALUE, GH_TOKEN: SHORT_SECRET },
      permissions: {
        // Два правила ниже различаются только теми знаками, которые приведение
        // имени выбрасывает. Живой дом 19.09.2026 дал на них ОДИН `id`, а по
        // нему идёт идемпотентный upsert — у цели одно затёрло бы другое.
        allow: ['Bash(git push:*)', 'Bash(echo "exit=$?")', 'Bash(echo "exit $?")'],
        deny: ['Read(./private)'],
      },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `node "${join(root, 'hooks', 'guard.mjs')}"` }],
          },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'node C:/нет-такого/скрипта.mjs' }] }],
        // Хук, запирающий разрешение: он обязан доехать событием ДО вызова.
        PermissionRequest: [
          {
            hooks: [
              { type: 'command', command: `node "${join(root, 'hooks', 'guard.mjs')}" --perm` },
            ],
          },
        ],
        // Событие, которого в каноне нет: подменять его ближайшим нельзя.
        SubagentStart: [
          {
            hooks: [
              { type: 'command', command: `node "${join(root, 'hooks', 'guard.mjs')}" --sub` },
            ],
          },
        ],
      },
    }),
  );

  // Преамбула с импортом, два действующих правила и одно выключенное в служебном
  // разделе. Импортируемый файл ссылается обратно — это цикл, и он обязан быть
  // назван, а не проглочен.
  writeFileSync(
    join(root, 'CLAUDE.md'),
    [
      'Общая преамбула.',
      '',
      // Форма импорта — та, что задокументирована: путь относительно файла.
      '@imported.md',
      '',
      '## ПРАВИЛО: Отвечать по-русски',
      '',
      'Ответы на русском.',
      '',
      '## ПРАВИЛО: Не коммитить без спроса',
      '',
      'Коммит только по просьбе.',
      '',
      '## Отключённые правила (AgentDeck)',
      '',
      '### ПРАВИЛО: Старое правило',
      '',
      'Тело выключенного правила.',
      '',
    ].join('\n'),
  );
  // Импортируемый файл ссылается обратно на CLAUDE.md — это цикл.
  writeFileSync(join(root, 'imported.md'), ['Текст импорта.', '', '@CLAUDE.md', ''].join('\n'));
  writeFileSync(join(root, 'AGENTS.md'), 'Инструкции для других CLI.\n');

  writeFileSync(
    join(root, 'agents', 'reviewer.md'),
    [
      '---',
      'name: reviewer',
      'description: Ревьюер изменений',
      'tools: Read, Grep',
      'model: inherit',
      'omitClaudeMd: true',
      '---',
      '',
      'Смотри диффы.',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'skills', 'demo', 'SKILL.md'),
    ['---', 'name: demo', 'description: Показательный скилл', '---', '', 'Тело скилла.', ''].join(
      '\n',
    ),
  );
  writeFileSync(
    join(root, 'skills', 'synced', 'from-account', 'SKILL.md'),
    [
      '---',
      'name: from-account',
      'description: Приехал из аккаунта',
      '---',
      '',
      'Тело синхронизированного скилла.',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(root, 'skills', 'synced', 'demo', 'SKILL.md'),
    [
      '---',
      'name: demo',
      'description: Тот же demo, но из аккаунта',
      '---',
      '',
      'Тело скилла из аккаунта.',
      '',
    ].join('\n'),
  );

  writeFileSync(join(root, '.claude', 'CLAUDE.md'), 'Инструкции из вложенного .claude.\n');

  writeFileSync(
    join(root, 'commands', 'review.md'),
    ['---', 'description: Ревью изменений', '---', '', 'Посмотри $ARGUMENTS.', ''].join('\n'),
  );

  // Скрипт хука читает поле нагрузки — статический разбор обязан это увидеть.
  writeFileSync(
    join(root, 'hooks', 'guard.mjs'),
    [
      'const payload = JSON.parse(input);',
      'if (payload.tool_input.command) process.exit(0);',
      '',
    ].join('\n'),
  );

  // Вложения скилла: скилл — это КАТАЛОГ, и справка внутри него обязана попасть
  // в опись (П2.6). Без неё скилл доезжает одним `SKILL.md` и у цели ссылается
  // на файлы, которых там нет.
  mkdirSync(join(root, 'skills', 'demo', 'references'), { recursive: true });
  writeFileSync(join(root, 'skills', 'demo', 'references', 'styles.md'), 'Справка скилла.\n');

  writeFileSync(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        files: { command: 'npx', args: ['-y', 'mcp-files'], env: { FILES_TOKEN: SECRET_VALUE } },
        inside: { type: 'sdk' },
      },
      // Выключенный сервер лежит в служебном ключе панели. Он едет ЗАПИСЬЮ с
      // `enabled: false`: пропуском он был бы неотличим от «сервера нет», и у
      // цели человек не досчитался бы его молча (П2.6).
      mcpServersDisabled: {
        docs: { command: 'npx', args: ['-y', 'mcp-docs'] },
      },
    }),
  );

  writeFileSync(join(root, '.mcp-secrets.env'), `GITLAB_TOKEN=${SECRET_VALUE}\n`);
}

/**
 * Импорт эталонного дома. `settings` дописывает опции в настоящий файл настроек
 * — туда, где их читает CLI: `pluginConfigs["agents-md@builtin"].options`, а не в
 * корень файла. Режимы проверяются на диске, а не подменой в памяти: импортёр
 * читает файл, и проверять что-то другое значило бы проверять не его.
 */
function importHome(settings?: Record<string, unknown>) {
  if (settings) {
    const current = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      join(home, 'settings.json'),
      JSON.stringify({
        ...current,
        pluginConfigs: { 'agents-md@builtin': { options: settings } },
      }),
    );
  }
  return importClaudeEnvironment({ provider: claudeProvider, scope: 'global', override: home });
}

function itemsOf<T extends EnvItem>(items: readonly EnvItem[], kind: T['kind']): T[] {
  return items.filter((item): item is T => item.kind === kind);
}

describe('реестр импортёров', () => {
  it('заведён у всех десяти провайдеров каталога', () => {
    const catalog = ['claude', ...CATALOG_PROVIDERS.map((provider) => provider.id)].sort();
    expect(importerProviderIds()).toEqual(catalog);
    expect(catalog).toHaveLength(10);
  });

  it('одиннадцатый CLI без импортёра — названная ошибка, а не пустой паспорт', () => {
    expect(hasImporter('выдуманный')).toBe(false);
    expect(() =>
      importEnvironment({
        provider: { ...claudeProvider, id: 'выдуманный' },
        scope: 'global',
        override: home,
      }),
    ).toThrow(UnknownImportProviderError);
  });

  it('паспорт проходит схему канона', () => {
    const passport = importEnvironment({
      provider: claudeProvider,
      scope: 'global',
      override: home,
    });
    expect(agentEnvironmentSchema.safeParse(passport).success).toBe(true);
    expect(passport.root).toBe(home);
  });
});

describe('инструкции Claude по ключу instructionFiles', () => {
  it('умолчание: CLAUDE.md берётся, лежащий рядом AGENTS.md — нет, и сказано почему', () => {
    const result = importHome({ instructionFiles: undefined });
    const files = itemsOf<InstructionsItem>(result.items, 'instructions').map(
      (item) => item.fileName,
    );

    expect(files.some((name) => name.startsWith('CLAUDE.md'))).toBe(true);
    expect(files).not.toContain('AGENTS.md');
    expect(result.skipped.some((skip) => skip.detail.includes('AGENTS.md'))).toBe(true);
  });

  it('claude-md-and-agents-md: в канон едут ОБА файла разными записями', () => {
    const result = importHome({ instructionFiles: 'claude-md-and-agents-md' });
    const files = itemsOf<InstructionsItem>(result.items, 'instructions');

    expect(files.some((item) => item.fileName === 'AGENTS.md')).toBe(true);
    expect(files.some((item) => item.fileName.startsWith('CLAUDE.md'))).toBe(true);
    // Каждый читаемый файл представлен своим путём: запись обязана нести СВОЙ
    // файл, а не общее имя раздела. Записей больше, чем файлов, — `CLAUDE.md`
    // делится на преамбулу и правила.
    expect(new Set(files.map((item) => item.source.file)).size).toBe(3);
    expect(new Set(files.map((item) => item.id)).size).toBe(files.length);
  });

  it('два файла инструкций с одним именем — две записи, а не одна', () => {
    // CLI читает и `CLAUDE.md`, и `.claude/CLAUDE.md`. Имя записи строилось
    // `basename`ом, и оба файла давали `instructions:claude.md`: по этому ключу
    // идёт идемпотентный upsert (инвариант 10) — у цели один текст затёр бы
    // другой, и человек не узнал бы, какой именно.
    const result = importHome({ instructionFiles: 'claude-md' });
    const files = itemsOf<InstructionsItem>(result.items, 'instructions').filter((item) =>
      item.fileName.endsWith('CLAUDE.md'),
    );

    expect(files.length).toBe(2);
    expect(new Set(files.map((item) => item.id)).size).toBe(2);
    expect(files.map((item) => item.fileName)).toContain('.claude/CLAUDE.md');
  });

  it('managed-only: ни одной записи инструкций, и причина названа', () => {
    const result = importHome({ instructionFiles: 'managed-only' });

    expect(itemsOf(result.items, 'instructions')).toHaveLength(0);
    expect(result.skipped.some((skip) => skip.detail.includes('managed-only'))).toBe(true);
  });

  it('устаревший projectInstructions читается и помечается устаревшим', () => {
    const result = importHome({ instructionFiles: undefined, projectInstructions: 'claude-md' });
    const files = itemsOf<InstructionsItem>(result.items, 'instructions');

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((item) => item.legacy)).toBe(true);
    expect(result.skipped.some((skip) => skip.detail.includes('projectInstructions'))).toBe(true);
  });

  it('испорченный settings.json не роняет ВЫБОР режима: умолчание плюс названный пропуск', () => {
    // Проверка на уровне самой функции, а не импорта целиком, и это названо
    // вслух: у Claude тот же `settings.json` читают ещё права и переменные, и
    // на испорченном файле паспорт целиком отказывает раньше (маршрут отвечает
    // 400 `portability-source-not-readable` — это проверено в тесте маршрута).
    // Здесь закреплён контракт самой функции: выдумывать режим по нечитаемому
    // файлу нельзя, но и бросать из неё — тоже, иначе фраза «падать на этом
    // нельзя» в её же описании держится на честном слове.
    const broken = mkdtempSync(join(tmpdir(), 'cc-broken-settings-'));
    try {
      writeFileSync(join(broken, 'settings.json'), '{ "instructionFiles": "claude-md", }');
      writeFileSync(join(broken, 'CLAUDE.md'), '# Правила\n\nтекст\n');

      const choice = readInstructionFilesChoice(join(broken, 'settings.json'));
      expect(choice).toEqual({
        mode: DEFAULT_INSTRUCTION_FILES_MODE,
        source: 'default',
        unreadable: true,
      });

      // И нечитаемость доезжает до человека пропуском, а не молчанием: режим
      // взят по умолчанию, а файл, который CLI на самом деле читает, мог быть
      // другим.
      const resolved = resolveInstructionSources(broken, choice);
      expect(resolved.sources.map((item) => item.fileName)).toContain('CLAUDE.md');
      expect(resolved.skips.some((skip) => skip.detail.includes('не разобран'))).toBe(true);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('незнакомое значение ключа не толкуется: умолчание плюс названная причина', () => {
    const result = importHome({
      instructionFiles: 'кривое-значение',
      projectInstructions: undefined,
    });

    expect(itemsOf(result.items, 'instructions').length).toBeGreaterThan(0);
    expect(result.skipped.some((skip) => skip.detail.includes('кривое-значение'))).toBe(true);
  });
});

describe('правила CLAUDE.md', () => {
  it('едут отдельными записями со своим состоянием вкл/выкл', () => {
    const result = importHome({ instructionFiles: undefined, projectInstructions: undefined });
    const rules = itemsOf<InstructionsItem>(result.items, 'instructions').filter((item) =>
      item.fileName.includes('#'),
    );

    expect(rules.map((item) => item.fileName)).toEqual([
      'CLAUDE.md#otvechat-po-russki',
      'CLAUDE.md#ne-kommitit-bez-sprosa',
      'CLAUDE.md#staroe-pravilo',
    ]);
    const disabled = rules.find((item) => item.fileName.endsWith('staroe-pravilo'));
    expect(disabled?.enabled).toBe(false);
    expect(rules.filter((item) => item.enabled)).toHaveLength(2);
  });

  it('текст файла не едет дважды: преамбула и правила не пересекаются', () => {
    const result = importHome();
    const instructions = itemsOf<InstructionsItem>(result.items, 'instructions').filter((item) =>
      item.source.file?.endsWith('CLAUDE.md'),
    );
    const preamble = instructions.find((item) => !item.fileName.includes('#'));

    expect(preamble?.text).toContain('Общая преамбула');
    expect(preamble?.text).not.toContain('Ответы на русском');
  });

  it('цикл @-импортов назван файлом, а остальной текст развёрнут', () => {
    const result = importHome();
    const preamble = itemsOf<InstructionsItem>(result.items, 'instructions').find(
      (item) => !item.fileName.includes('#') && item.source.file?.endsWith('CLAUDE.md'),
    );

    expect(preamble?.text).toContain('Текст импорта');
    expect(preamble?.includes).toContain(join(home, 'imported.md'));
    const cycle = result.skipped.find((skip) => skip.detail.includes('цикл импортов'));
    expect(cycle?.detail).toContain('CLAUDE.md');
  });
});

describe('субагенты, скиллы, команды', () => {
  it('omitClaudeMd субагента доезжает отдельным полем', () => {
    const subagents = itemsOf<SubagentItem>(importHome().items, 'subagent');

    expect(subagents).toHaveLength(1);
    expect(subagents[0]?.name).toBe('reviewer');
    expect(subagents[0]?.omitInstructions).toBe(true);
    expect(subagents[0]?.tools).toEqual(['Read', 'Grep']);
  });

  it('скилл из аккаунта едет с происхождением account, а не пустым телом', () => {
    const skills = itemsOf<SkillItem>(importHome().items, 'skill');
    const synced = skills.find((item) => item.name === 'from-account');

    expect(synced?.source.origin).toBe('account');
    expect(synced?.body.trim()).not.toBe('');
    expect(skills.find((item) => item.name === 'demo')?.source.origin).toBe('file');
  });

  it('скилл везёт опись своего поддерева, а не один SKILL.md', () => {
    const demo = itemsOf<SkillItem>(importHome().items, 'skill').find(
      (item) => item.name === 'demo' && item.source.origin === 'file',
    );

    expect(demo?.attachments.map((file) => file.path)).toEqual(['references/styles.md']);
    expect(demo?.attachmentsSkipped).toEqual([]);
    // В намерении названо число файлов: человек видит объём переноса до него.
    expect(demo?.intent).toContain('вложений 1');
  });

  it('команда, берущая аргументы, объявляет это требованием', () => {
    const commands = importHome().items.filter((item) => item.kind === 'command');

    expect(commands).toHaveLength(1);
    expect(commands[0]?.needs).toEqual({
      resolution: 'facts',
      facts: ['prompt'],
      evidence: 'declared',
    });
  });
});

describe('хуки', () => {
  it('needs выводится из текста скрипта и помечается гипотезой', () => {
    const hooks = itemsOf<HookItem>(importHome().items, 'hook');
    const guard = hooks.find((item) => item.command.includes('guard.mjs'));

    expect(guard?.needs).toMatchObject({ resolution: 'facts', evidence: 'static' });
    expect(guard?.needs).toHaveProperty('facts', expect.arrayContaining(['tool_input']));
  });

  it('хук разрешения запирает вызов ДО него, а не наблюдает после', () => {
    const hooks = itemsOf<HookItem>(importHome().items, 'hook');
    const permission = hooks.find((item) => item.command.includes('--perm'));

    // Разведение по приставке `Pre` относило `PermissionRequest` к `post_tool`:
    // запрет переносился наблюдателем, то есть молча снимался (инвариант 6).
    expect(permission?.trigger).toEqual({ on: 'tool', event: 'pre_tool', match: null });
  });

  it('событие, которого канон не знает, названо пропуском, а не подменено ближайшим', () => {
    const result = importHome();
    const hooks = itemsOf<HookItem>(result.items, 'hook');

    // `SubagentStart` ехал как `subagent_stop` — хук на ЗАПУСК субагента
    // переносился на его завершение. Ближайшее по смыслу — не то же самое.
    expect(hooks.some((item) => item.command.includes('--sub'))).toBe(false);
    expect(result.skipped.some((skip) => skip.detail.includes('SubagentStart'))).toBe(true);
  });

  it('скрипт, которого нет на диске, назван пропуском', () => {
    const result = importHome();

    expect(result.skipped.some((skip) => skip.detail.includes('не найден на диске'))).toBe(true);
  });

  it('нечитаемый скрипт даёт худший уровень, а не пустой список', () => {
    const hooks = itemsOf<HookItem>(importHome().items, 'hook');
    const broken = hooks.find((item) => item.command.includes('нет-такого'));

    expect(broken?.needs.resolution).toBe('undetermined');
  });
});

describe('MCP, права, секреты', () => {
  it('запись type: sdk не превращается в команду и названа причиной CLI', () => {
    const result = importHome();
    const inside = itemsOf<McpServerItem>(result.items, 'mcpServer').find(
      (item) => item.name === 'inside',
    );

    expect(inside?.transport).toBe('sdk');
    expect(result.skipped.some((skip) => skip.detail.includes('процесса SDK'))).toBe(true);
  });

  it('выключенный сервер едет записью с enabled: false, а не пропуском', () => {
    const servers = itemsOf<McpServerItem>(importHome().items, 'mcpServer');
    const docs = servers.find((item) => item.name === 'docs');

    // Пропуск читался бы как «сервера нет»: человек не досчитался бы его у цели
    // и не узнал бы, почему. Запись говорит и то, что он есть, и то, что молчит.
    expect(docs).toBeDefined();
    expect(docs?.enabled).toBe(false);
    expect(docs?.command).toBe('npx');
    expect(servers.find((item) => item.name === 'files')?.enabled).toBe(true);
  });

  it('права едут правилом, решением и порядком', () => {
    const permissions = itemsOf<PermissionItem>(importHome().items, 'permission');

    expect(permissions.map((item) => item.rule)).toEqual(
      expect.arrayContaining(['Bash(git push:*)', 'Read(./private)']),
    );
    expect(permissions.find((item) => item.rule === 'Read(./private)')?.decision).toBe('deny');
  });

  it('требования права считаются по скобкам, а режим подтверждений не требует ничего', () => {
    const permissions = itemsOf<PermissionItem>(importHome().items, 'permission');
    const withArguments = permissions.find((item) => item.rule === 'Bash(git push:*)');

    expect(withArguments?.needs).toEqual({
      resolution: 'facts',
      facts: ['tool_input', 'tool_name'],
      evidence: 'declared',
    });
  });

  it('идентичность записи различает правила, различие которых теряет приведение имени', () => {
    const permissions = itemsOf<PermissionItem>(importHome().items, 'permission');
    const pair = permissions.filter((item) => item.rule.startsWith('Bash(echo'));

    expect(pair).toHaveLength(2);
    expect(pair[0]?.id).not.toBe(pair[1]?.id);
  });

  it('ни один id не повторяется во всём паспорте', () => {
    // Повтор `id` — это не косметика: по нему идёт идемпотентный upsert
    // (инвариант 10), и две записи под одним ключом у цели сливаются в одну.
    const ids = importHome().items.map((item) => item.id);

    expect(ids.length).toBe(new Set(ids).size);
  });

  it('значения секретов не попадают в паспорт нигде', () => {
    const passport = importEnvironment({
      provider: claudeProvider,
      scope: 'global',
      override: home,
    });

    expect(JSON.stringify(passport)).not.toContain(SECRET_VALUE);
    const secrets = itemsOf<SecretItem>(passport.items, 'secret');
    expect(secrets.map((item) => item.name)).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'GITLAB_TOKEN']),
    );
    // Имя ключа окружения MCP-сервера ехать обязано, значение — нет.
    const files = itemsOf<McpServerItem>(passport.items, 'mcpServer').find(
      (item) => item.name === 'files',
    );
    expect(files?.envKeys).toEqual(['FILES_TOKEN']);
  });

  it('маска секрета считается от НАСТОЯЩЕГО значения, а не от уже замаскированного', () => {
    const secret = itemsOf<SecretItem>(importHome().items, 'secret').find(
      (item) => item.name === 'ANTHROPIC_API_KEY',
    );

    // Список панели отдаёт значения секретов замаскированными; паспорту нужны
    // сырые, иначе маска считается от строки с точками и запись показывает
    // человеку хвост, которого у ключа нет.
    expect(secret?.mask).toBe(`${SECRET_VALUE.slice(0, 2)}…${SECRET_VALUE.slice(-4)}`);

    const short = itemsOf<SecretItem>(importHome().items, 'secret').find(
      (item) => item.name === 'GH_TOKEN',
    );
    // Маска от короткого значения РАСКРЫВАЛА его: восемь знаков `abc12345`
    // давали `ab…2345` — шесть из восьми, а `hunter` дал бы себя целиком. Края
    // показываются только там, где середина длиннее краёв, поэтому короткое
    // значение уходит одним многоточием — и по-прежнему не через маску панели
    // (иначе в нём были бы точки `•`).
    expect(short?.mask).not.toContain('•');
    expect(short?.mask).toBe('…');
    expect(short?.mask).not.toContain(SHORT_SECRET.slice(-4));
  });
});

/**
 * Карта соответствий codex и gemini — НЕ наша выдумка: её выписал односторонний
 * импортёр самого Claude Code (`.agent/cli-import-map.agent.md`, рецепт
 * перепроверки там же). Расхождение с ней — дефект нашего импортёра, поэтому эти
 * проверки читают живые файлы чужого дома, а не подают структуры в нормализатор.
 */
describe('карта соответствий первоисточника', () => {
  /** Значения approval_policy, которые первоисточник видит у Codex. */
  const CODEX_APPROVALS = [
    'suggest',
    'auto-edit',
    'full-auto',
    'on-request',
    'on-failure',
    'never',
  ];

  function importCodex(configToml: string) {
    const codexHome = join(foreignHome, '.codex');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'AGENTS.md'), 'Инструкции Codex.\n');
    writeFileSync(join(codexHome, 'config.toml'), configToml);
    const codex = CATALOG_PROVIDERS.find((provider) => provider.id === 'codex');
    if (!codex) throw new Error('провайдера codex нет в каталоге');
    return importEnvironment({ provider: codex, scope: 'global' });
  }

  it('умолчание CLI помечено происхождением «умолчание», а не файлом', () => {
    // Файл есть, ключа в нём нет: режим ДЕЙСТВУЕТ, но человек его не писал.
    const passport = importCodex('# пусто\n');
    const mode = itemsOf<PermissionItem>(passport.items, 'permission').find((item) =>
      item.rule.startsWith('mode:'),
    );

    expect(mode?.source.file).toBeNull();
    // `origin: 'file'` у записи, которой ни в одном файле нет, — то же враньё,
    // что и выдуманный путь: перенос (П2) решает по `origin` и записал бы чужое
    // умолчание в цель как настройку человека.
    expect(mode?.source.origin).toBe('default');
    expect(mode?.intent).toContain('умолчание CLI');

    // А записанное значение происхождения не теряет.
    const written = itemsOf<PermissionItem>(
      importCodex('approval_policy = "never"\n').items,
      'permission',
    ).find((item) => item.rule === 'mode:never');
    expect(written?.source.origin).toBe('file');
    expect(written?.source.file).not.toBeNull();
  });

  it.each(CODEX_APPROVALS)(
    'approval_policy = %s либо едет, либо назван — но не подменяется',
    (policy) => {
      const passport = importCodex(`approval_policy = "${policy}"\n`);
      const mode = itemsOf<PermissionItem>(passport.items, 'permission').find(
        (item) => item.rule === `mode:${policy}`,
      );
      const named = passport.skipped.some((skip) => skip.detail.includes(policy));

      // Одно из двух — решение канона или названный пропуск. Третьего («тихо
      // показать умолчание вместо значения из файла») быть не должно.
      expect(Boolean(mode?.decision) || named).toBe(true);
      // И ни при каких значениях в паспорте не появляется РЕЖИМ, которого в файле
      // нет: подменённое умолчание — это описанная среда, которой не существует.
      const modes = itemsOf<PermissionItem>(passport.items, 'permission').filter((item) =>
        item.rule.startsWith('mode:'),
      );
      expect(modes.every((item) => item.rule === `mode:${policy}`)).toBe(true);
    },
  );

  it('sandbox_mode переносить отказался первоисточник — отказываемся и мы, той же причиной', () => {
    const passport = importCodex(
      ['approval_policy = "on-request"', 'sandbox_mode = "workspace-write"', ''].join('\n'),
    );

    expect(
      passport.skipped.some(
        (skip) => skip.kind === 'permission' && skip.detail.includes('sandbox_mode'),
      ),
    ).toBe(true);
    // И ни одной записи «на всякий случай» вместо отказа.
    expect(
      itemsOf<PermissionItem>(passport.items, 'permission').some((item) =>
        item.rule.includes('sandbox'),
      ),
    ).toBe(false);
  });

  it('разделы, которые первоисточник читает, а панель ещё нет, названы пропуском', () => {
    const passport = importCodex(
      [
        'approval_policy = "on-request"',
        '',
        '[agents.reviewer]',
        'instructions = "смотри диффы"',
        '',
        '[[skills.config]]',
        'path = "./skills/demo"',
        '',
      ].join('\n'),
    );

    expect(passport.skipped.some((skip) => skip.kind === 'subagent')).toBe(true);
    expect(passport.skipped.some((skip) => skip.kind === 'skill')).toBe(true);
  });

  it('gemini: режим подтверждений и оба списка инструментов едут по карте', () => {
    const geminiHome = join(foreignHome, '.gemini');
    mkdirSync(geminiHome, { recursive: true });
    writeFileSync(join(geminiHome, 'GEMINI.md'), 'Инструкции Gemini.\n');
    writeFileSync(
      join(geminiHome, 'settings.json'),
      JSON.stringify({
        general: { defaultApprovalMode: 'default' },
        coreTools: ['ReadFile'],
        excludeTools: ['ShellTool'],
      }),
    );
    const gemini = CATALOG_PROVIDERS.find((provider) => provider.id === 'gemini');
    if (!gemini) throw new Error('провайдера gemini нет в каталоге');

    const permissions = itemsOf<PermissionItem>(
      importEnvironment({ provider: gemini, scope: 'global' }).items,
      'permission',
    );

    const mode = permissions.find((item) => item.rule === 'mode:default');
    expect(mode?.decision).toBe('ask');
    // Режим — право обо ВСЁМ CLI: аргументов вызова он не разбирает. Из-за
    // двоеточия в собственной записи `mode:<значение>` он объявлял `tool_input`
    // меткой «объявлено» — догадку под сильнейшим свидетельством, а по `needs`
    // матрица ВЫЧИСЛЯЕТ уровень верности переноса.
    expect(mode?.needs).toEqual({ resolution: 'none', why: expect.any(String) });
    expect(permissions.find((item) => item.rule === 'ReadFile')?.decision).toBe('allow');
    expect(permissions.find((item) => item.rule === 'ShellTool')?.decision).toBe('deny');
  });
});

describe('дом, которого нет', () => {
  it('не бросает: каждый раздел назван непрочитанным', () => {
    const result = importClaudeEnvironment({
      provider: claudeProvider,
      scope: 'global',
      override: join(home, 'нет-такого-каталога'),
    });

    expect(result.items).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped.every((skip) => skip.reason === 'not_readable')).toBe(true);

    // «Каждый» — это весь словарь канона, кроме конструкций самой панели.
    // Проверка `every(reason === 'not_readable')` проходила и на подмножестве:
    // список видов был выписан руками и потерял `secret` — про секреты
    // нечитаемый дом не говорил ничего, а человек читает молчание как «нет».
    const panelOnly: EnvItemKind[] = ['panelGroup', 'conversation'];
    const expected = envItemKinds.filter((kind) => !panelOnly.includes(kind));
    expect([...new Set(result.skipped.map((skip) => skip.kind))].sort()).toEqual(
      [...expected].sort(),
    );
  });
});
