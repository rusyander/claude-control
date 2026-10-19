import { describe, it, expect } from 'vitest';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
import {
  chatRunProfile,
  foreignGroupMcp,
  compactWindowOf,
  FORCE_PUSH_ASK,
  GROUP_SKILLS,
  groupMcpProfile,
  groupRunProfile,
  mcpRole,
  needsDesign,
  skillSettings,
  statusRunProfile,
  type ProfileMcpEntry,
} from './group-profile.ts';

/**
 * Лёгкий профиль запуска группы (1.2). Набор серверов — как у владельца на
 * 17.10 (личные из `~/.claude.json` и проектный `.mcp.json`), без секретов:
 * роль решается по имени, адресу и команде, а не по списку имён в коде.
 */

const ENTRIES: ProfileMcpEntry[] = [
  {
    id: 'agentdeck-atlassian',
    config: { command: 'node', args: ['C:\\repo\\tools\\mcp\\atlassian.mjs'] },
  },
  {
    id: 'atlassian-work',
    config: { command: 'docker', args: ['run', '--rm', 'mcp-atlassian'] },
  },
  { id: 'figma', config: { type: 'http', url: 'https://mcp.figma.com/mcp' } },
  { id: 'figma-local', config: { type: 'sse', url: 'http://127.0.0.1:3845/sse' } },
  { id: 'gitlab-work', config: { command: 'npx', args: ['-y', '@zereight/mcp-gitlab'] } },
  { id: 'inbox', config: { command: 'node', args: ['C:/mcp-servers/telegram-inbox/server.mjs'] } },
  { id: 'sentry', config: { type: 'http', url: 'https://mcp.sentry.dev/mcp' } },
];

const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);

describe('mcpRole', () => {
  it('роль — по имени, адресу или команде', () => {
    expect(ENTRIES.map(mcpRole)).toEqual([
      'tracker',
      'tracker',
      'design',
      'design',
      'forge',
      'messenger',
      'other',
    ]);
  });
});

describe('needsDesign', () => {
  it('ссылка на макет или слово о вёрстке — да; задача без них — нет', () => {
    expect(needsDesign('PROJ-1 https://www.figma.com/design/abc?node-id=1-2')).toBe(true);
    expect(needsDesign('Сверстать карточку по макету')).toBe(true);
    expect(needsDesign('PROJ-2 ручка экспорта в CSV, тесты')).toBe(false);
  });
});

describe('groupMcpProfile', () => {
  it('задача без макета: трекер, код и незнакомый сервер едут; мессенджер, макеты и дубль трекера — нет', () => {
    const profile = groupMcpProfile({ entries: ENTRIES, tasksText: 'PROJ-2 ручка', extra: [] });
    expect(ids(profile.kept)).toEqual(['atlassian-work', 'gitlab-work', 'sentry']);
    expect(profile.dropped).toEqual([
      { id: 'agentdeck-atlassian', reason: 'duplicate-tracker' },
      { id: 'figma', reason: 'no-design-link' },
      { id: 'figma-local', reason: 'no-design-link' },
      { id: 'inbox', reason: 'messenger' },
    ]);
  });

  it('задача с макетом получает серверы макетов', () => {
    const profile = groupMcpProfile({
      entries: ENTRIES,
      tasksText: 'https://www.figma.com/design/abc',
      extra: [],
    });
    expect(ids(profile.kept)).toContain('figma');
    expect(ids(profile.kept)).toContain('figma-local');
  });

  it('переходник панели — единственный трекер — остаётся трекером группы', () => {
    const profile = groupMcpProfile({
      entries: ENTRIES.filter((entry) => entry.id !== 'atlassian-work'),
      tasksText: '',
      extra: [],
    });
    expect(ids(profile.kept)).toContain('agentdeck-atlassian');
  });

  it('попрошенный группой сервер едет, даже если правило его снимало', () => {
    const profile = groupMcpProfile({ entries: ENTRIES, tasksText: '', extra: ['inbox'] });
    expect(ids(profile.kept)).toContain('inbox');
    expect(ids(profile.dropped)).not.toContain('inbox');
  });

  /** Ревью A1-F15: «Inbox» при сервере `inbox` не подключал ничего, а группе писали «подключён». */
  it('имя из просьбы — без учёта регистра', () => {
    const profile = groupMcpProfile({ entries: ENTRIES, tasksText: '', extra: ['Inbox'] });
    expect(ids(profile.kept)).toContain('inbox');
    const named = [
      ...ENTRIES,
      { id: 'Slack', config: { type: 'http', url: 'https://mcp.slack.com/mcp' } },
    ];
    const slack = groupMcpProfile({ entries: named, tasksText: '', extra: ['slack'] });
    expect(ids(slack.kept)).toContain('Slack');
  });
});

describe('foreignGroupMcp (6.1)', () => {
  it('снятые серверы — имена для выключателя и строка без подключений claude.ai', () => {
    const mcp = foreignGroupMcp({ entries: ENTRIES, tasksText: 'PROJ-2 ручка', extra: [] });
    expect(mcp.off).toEqual(['agentdeck-atlassian', 'figma', 'figma-local', 'inbox']);
    expect(mcp.note).toContain(
      'Switched off to save the context of every call: agentdeck-atlassian, figma, figma-local, inbox.',
    );
    expect(mcp.note).toContain(`<${SPLIT_MCP_TAG}>`);
    expect(mcp.note).not.toContain('claude.ai');
  });

  it('попрошенный сервер не выключается', () => {
    const mcp = foreignGroupMcp({ entries: ENTRIES, tasksText: '', extra: ['inbox'] });
    expect(mcp.off).not.toContain('inbox');
  });

  it('снимать нечего — ни имён, ни строки', () => {
    const only = ENTRIES.filter((entry) => ['atlassian-work', 'sentry'].includes(entry.id));
    expect(foreignGroupMcp({ entries: only, tasksText: '', extra: [] })).toEqual({ off: [] });
  });
});

/** Потолок Bash группы (3.1) — в каждых настройках флага её прогона. */
const CEILING = { env: { BASH_MAX_TIMEOUT_MS: '1800000' } };
/** Трекер и хранилище кода из `ENTRIES` — правилом `ask` (журнал 19.10). */
const OUTWARD = {
  permissions: { ask: ['mcp__atlassian-work', 'mcp__gitlab-work', ...FORCE_PUSH_ASK] },
};

describe('groupRunProfile', () => {
  it('флаг строгого набора, подключения claude.ai сняты, оставленные — своим файлом', () => {
    const run = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    expect(run.args).toEqual(['--strict-mcp-config']);
    expect(run.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(run.mcp.ids).toEqual(['atlassian-work', 'gitlab-work', 'sentry']);
    expect(run.mcp.config).toEqual({
      mcpServers: {
        'atlassian-work': ENTRIES[1]!.config,
        'gitlab-work': ENTRIES[4]!.config,
        sentry: ENTRIES[6]!.config,
      },
    });
  });

  it('хранилище кода и трекер — правилом ask на весь сервер: авторежим CLI не решит их запись сам', () => {
    // Журнал 19.10: в авторежиме классификатор CLI сам разрешил ответ в тред MR и
    // правку описания — до брокера панели вызов не дошёл. Правило `ask` сильнее
    // режима и ведёт вызов к брокеру, где решает строка группы.
    const run = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    expect(run.settings.permissions).toEqual(OUTWARD.permissions);
    // Имя сервера с недопустимыми для инструмента знаками — так, как его пишет CLI.
    const odd = groupRunProfile({
      entries: [{ id: 'gitlab.work', config: { command: 'npx', args: ['mcp-gitlab'] } }],
      tasksText: '',
      extra: [],
    });
    expect(odd.settings.permissions).toEqual({ ask: ['mcp__gitlab_work', ...FORCE_PUSH_ASK] });
    // Без хранилища кода и трекера остаётся правило принудительного пуша (L7.12).
    const none = groupRunProfile({ entries: [ENTRIES[6]!], tasksText: '', extra: [] });
    expect(none.settings.permissions).toEqual({ ask: [...FORCE_PUSH_ASK] });
  });

  it('принудительный пуш оболочкой — правилом ask: --force*, -f, +refspec, через git -C (L7.12)', () => {
    // Журнал 19.10 02:17:02: группа в авторежиме переписала ветку MR на ревью
    // `git push --force-with-lease` без карточки. Формы проверены настоящим CLI
    // в tools/qa/check-group-forge-ask.mjs; обычный `git push` правилом не задет.
    const settings = groupRunProfile({ entries: [], tasksText: '', extra: [] }).settings as {
      permissions?: { ask?: string[] };
    };
    const ask = settings.permissions?.ask;
    expect(ask).toEqual(
      expect.arrayContaining([
        'Bash(git push *--force*)',
        'Bash(git push -f*)',
        'Bash(git push * -f*)',
        'Bash(git push * +*)',
        'Bash(git -C * push *--force*)',
        'Bash(git -C * push * +*)',
      ]),
    );
    expect(ask?.some((rule) => rule === 'Bash(git push:*)' || rule === 'Bash(git push *)')).toBe(
      false,
    );
  });

  it('строка группе называет оставленные и снятые серверы и блок просьбы', () => {
    const { note } = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    expect(note).toContain('in this run: atlassian-work, gitlab-work, sentry.');
    expect(note).toContain('agentdeck-atlassian, figma, figma-local, inbox, claude.ai');
    expect(note).toContain(`<${SPLIT_MCP_TAG}>`);
    expect(note).toContain(`</${SPLIT_MCP_TAG}>`);
  });

  it('просьба claude.ai возвращает подключения claude.ai', () => {
    const run = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: ['claude.ai'] });
    expect(run.env).toEqual({});
    expect(run.note).not.toContain('claude.ai (all');
  });

  /**
   * Гейт проекта под нагрузкой шёл дольше десяти минут: CLI уводил его в фон, и
   * модель опрашивала конец циклами `sleep` (22 прогона из 26, 16.10). Едет файлом
   * `--settings`: переменную окружения перебил бы settings.json человека (B-F02).
   */
  it('потолок таймаута Bash группы — полчаса, полем env настроек флага, не окружением', () => {
    const run = groupRunProfile({ entries: [], tasksText: '', extra: [] });
    expect(run.settings.env).toEqual({ BASH_MAX_TIMEOUT_MS: '1800000' });
    expect(run.env.BASH_MAX_TIMEOUT_MS).toBeUndefined();
  });

  it('больший потолок человека профиль не занижает; меньший и мусор — поднимает до получаса', () => {
    const ceiling = (bashCeilings: (string | undefined)[]) =>
      groupRunProfile({ entries: [], tasksText: '', extra: [], bashCeilings }).settings.env;
    expect(ceiling(['600000', undefined, '3600000'])).toEqual({ BASH_MAX_TIMEOUT_MS: '3600000' });
    expect(ceiling(['600000', 'abc', '-5', ''])).toEqual({ BASH_MAX_TIMEOUT_MS: '1800000' });
  });

  /**
   * 2.1 плана экономии: окно автосжатия группы — рычаг A/B, по умолчанию выключен.
   * Рабочий чат группы — 500–1000 вызовов за 1–3 хода (замер 15–16.10), сжатие
   * делает сам CLI у ~267 тыс.; окно меньше сдвигает его раньше.
   */
  it('окно автосжатия — переменной CLI; без окна переменной нет', () => {
    const run = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      compactWindow: 160_000,
    });
    expect(run.env).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000',
    });
    expect(groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] }).env).not.toHaveProperty(
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    );
  });
});

/**
 * 2.3 плана экономии: хук свёртки ответов трекера едет группе в её же файле
 * `--settings` (как перечень навыков 1.3), матчер — только запись в трекер.
 */
describe('хук ответов трекера', () => {
  const COMMAND = 'node "/app/tools/tracker-brief-hook.mjs"';

  it('с командой хука — PostToolUse на смену статуса, назначение и комментарии', () => {
    const run = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      trackerHook: COMMAND,
    });
    expect(run.settings).toEqual({
      ...CEILING,
      ...OUTWARD,
      hooks: {
        PostToolUse: [
          {
            matcher:
              'mcp__.*__jira_(transition_issue|assign_issue|update_issue|add_comment|edit_comment)',
            hooks: [{ type: 'command', command: COMMAND, timeout: 10 }],
          },
        ],
      },
    });
  });

  it('рядом с перечнем навыков, без команды — хуков нет', () => {
    const skills = { user: ['a11y-audit'], group: [], plugins: [] };
    const both = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      skills,
      trackerHook: COMMAND,
    });
    expect(Object.keys(both.settings).sort()).toEqual([
      'env',
      'hooks',
      'permissions',
      'skillOverrides',
    ]);
    const none = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [], skills });
    expect(none.settings).not.toHaveProperty('hooks');
  });
});

/**
 * 3.2 плана экономии: очередь тяжёлых шагов — хук ждёт места перед тяжёлой
 * командой Bash и отдаёт его после; каталог очереди — переменной прогона.
 */
describe('очередь тяжёлых шагов', () => {
  const QUEUE = { hook: 'node "/app/tools/heavy-queue-hook.mjs"', dir: '/data/heavy-queue' };

  it('хук на Bash до команды (ждёт до 30 мин), после неё и после провала; каталог — переменной', () => {
    const run = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [], heavyQueue: QUEUE });
    const hook = [{ type: 'command', command: QUEUE.hook }];
    expect(run.settings).toEqual({
      ...CEILING,
      ...OUTWARD,
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ ...hook[0], timeout: 1800 }] }],
        PostToolUse: [{ matcher: 'Bash', hooks: [{ ...hook[0], timeout: 10 }] }],
        PostToolUseFailure: [{ matcher: 'Bash', hooks: [{ ...hook[0], timeout: 10 }] }],
      },
    });
    expect(run.env.AGENTDECK_HEAVY_QUEUE_DIR).toBe(QUEUE.dir);
  });

  it('рядом с хуком трекера: оба в PostToolUse; без очереди — ни хука, ни переменной', () => {
    const both = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      heavyQueue: QUEUE,
      trackerHook: 'node "/app/tools/tracker-brief-hook.mjs"',
    });
    const post = (both.settings.hooks as { PostToolUse: { matcher: string }[] }).PostToolUse;
    expect(post.map((entry) => entry.matcher)).toEqual([
      'mcp__.*__jira_(transition_issue|assign_issue|update_issue|add_comment|edit_comment)',
      'Bash',
    ]);
    const none = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    expect(none.env).not.toHaveProperty('AGENTDECK_HEAVY_QUEUE_DIR');
    expect(none.settings).not.toHaveProperty('hooks');
  });
});

/**
 * 5.2 плана экономии: поиск, доска и спринт трекера — заголовками. Хук едет и
 * группе, и обычному чату с инициативой разделения; обычному чату — только он.
 */
describe('хук списка задач без описаний', () => {
  const BOARD = 'node "/app/tools/board-fields-hook.mjs"';
  const MATCHER = 'mcp__.*__jira_(search|get_board_issues|get_sprint_issues)';

  it('обычный чат: только PreToolUse на списки, ни флагов, ни серверов, ни строки', () => {
    expect(chatRunProfile({ boardHook: BOARD })).toEqual({
      args: [],
      env: {},
      note: '',
      settings: {
        hooks: {
          PreToolUse: [
            { matcher: MATCHER, hooks: [{ type: 'command', command: BOARD, timeout: 10 }] },
          ],
        },
      },
    });
  });

  it('группа: рядом с очередью тяжёлых шагов — оба в PreToolUse; без команды — хука нет', () => {
    const both = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      boardHook: BOARD,
      heavyQueue: { hook: 'node "/app/tools/heavy-queue-hook.mjs"', dir: '/q' },
    });
    const pre = (both.settings.hooks as { PreToolUse: { matcher: string }[] }).PreToolUse;
    expect(pre.map((entry) => entry.matcher)).toEqual([MATCHER, 'Bash']);
    const none = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    expect(JSON.stringify(none.settings)).not.toContain('get_board_issues');
  });
});

describe('compactWindowOf', () => {
  it('число или «160k» в границах CLI (100k–1M); остальное — выключено', () => {
    expect(compactWindowOf('160000')).toBe(160_000);
    expect(compactWindowOf('160k')).toBe(160_000);
    expect(compactWindowOf(' 1M ')).toBe(1_000_000);
    expect(compactWindowOf('100k')).toBe(100_000);
    expect(compactWindowOf('99999')).toBeUndefined();
    expect(compactWindowOf('2M')).toBeUndefined();
    expect(compactWindowOf('auto')).toBeUndefined();
    expect(compactWindowOf('')).toBeUndefined();
    expect(compactWindowOf(undefined)).toBeUndefined();
  });
});

/**
 * Навыки группы (1.3): описание — обязательным и навыкам групп панели прогона,
 * остальным личным и встроенным без дела — только имя; навык проекта в перечень
 * не попадает вовсе. Плагин макетов без макета и плагин-мессенджер выключены.
 */
describe('skillSettings', () => {
  const SKILLS = {
    user: ['deep-review', 'skill-map', 'a11y-audit', 'drawio-architect', 'figma-parity'],
    group: ['figma-parity'],
    plugins: [
      'figma@claude-plugins-official',
      'typescript-lsp@claude-plugins-official',
      'discord@x',
    ],
  };

  it('обязательные и навыки группы — с описанием, остальные — по имени', () => {
    const { skillOverrides } = skillSettings(SKILLS, false) as {
      skillOverrides: Record<string, string>;
    };
    expect(skillOverrides['a11y-audit']).toBe('name-only');
    expect(skillOverrides['drawio-architect']).toBe('name-only');
    expect(skillOverrides.dataviz).toBe('name-only');
    expect(skillOverrides).not.toHaveProperty('deep-review');
    expect(skillOverrides).not.toHaveProperty('skill-map');
    expect(skillOverrides).not.toHaveProperty('figma-parity');
    expect(skillOverrides).not.toHaveProperty('code-review');
    expect(Object.values(skillOverrides).every((value) => value === 'name-only')).toBe(true);
  });

  it('без макета выключены плагин макетов и мессенджер, с макетом — только мессенджер', () => {
    expect(skillSettings(SKILLS, false).enabledPlugins).toEqual({
      'figma@claude-plugins-official': false,
      'discord@x': false,
    });
    expect(skillSettings(SKILLS, true).enabledPlugins).toEqual({ 'discord@x': false });
    expect(skillSettings({ ...SKILLS, plugins: [] }, false)).not.toHaveProperty('enabledPlugins');
  });

  it('профиль без сведений о навыках настроек навыков не несёт — только потолок Bash', () => {
    expect(groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] }).settings).toEqual({
      ...CEILING,
      ...OUTWARD,
    });
    const run = groupRunProfile({
      entries: ENTRIES,
      tasksText: 'макет',
      extra: [],
      skills: SKILLS,
    });
    expect(run.settings.enabledPlugins).toEqual({ 'discord@x': false });
  });
});

/**
 * Защита от отката (этап 7): набор группы едет в каждом её вызове. Новый навык с
 * описанием, новая роль сервера «по умолчанию едет» или разросшаяся строка о
 * снятых — сначала замер, что окупается, потом новый потолок.
 */
describe('потолок профиля группы', () => {
  const SKILLS = { user: ['a11y-audit', 'drawio-architect'], group: [], plugins: [] };
  const run = groupRunProfile({
    entries: ENTRIES,
    tasksText: 'PROJ-2 ручка',
    extra: [],
    skills: SKILLS,
  });

  it('с описанием — не больше 12 навыков, встроенные без дела — по имени', () => {
    expect(GROUP_SKILLS.length).toBeLessThanOrEqual(12);
    const overrides = run.settings.skillOverrides as Record<string, string>;
    for (const name of ['a11y-audit', 'drawio-architect', 'dataviz', 'claude-api', 'init']) {
      expect(overrides[name], name).toBe('name-only');
    }
  });

  it('из семи серверов владельца задаче без макета едут три; строка о снятых — не длиннее 450 знаков', () => {
    expect(run.mcp.ids).toHaveLength(3);
    expect(run.note.length).toBeLessThanOrEqual(450);
  });
});

describe('statusRunProfile (5.1)', () => {
  const profile = statusRunProfile({
    user: ['my-skill', 'deep-review'],
    group: ['kit-skill'],
    plugins: ['figma@market', 'notes@market'],
  });

  it('ни одного MCP-сервера и подключений claude.ai', () => {
    expect(profile.args).toEqual(['--strict-mcp-config']);
    expect(profile.env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' });
    expect(profile.mcp.ids).toEqual([]);
  });

  it('навыкам — только имя (и обязательным группы), плагины выключены, правки запрещены', () => {
    const settings = profile.settings as {
      skillOverrides: Record<string, string>;
      enabledPlugins: Record<string, boolean>;
      permissions: { deny: string[] };
    };
    for (const name of ['my-skill', 'deep-review', 'kit-skill', 'ticket-delivery', 'dataviz']) {
      expect(settings.skillOverrides[name]).toBe('name-only');
    }
    expect(settings.enabledPlugins).toEqual({ 'figma@market': false, 'notes@market': false });
    expect(settings.permissions.deny).toEqual([
      'Edit',
      'MultiEdit',
      'Write',
      'NotebookEdit',
      'Bash',
      'PowerShell',
    ]);
  });

  it('без плагинов поля плагинов нет — личные настройки не трогаются', () => {
    const bare = statusRunProfile({ user: [], group: [], plugins: [] });
    expect(bare.settings).not.toHaveProperty('enabledPlugins');
  });
});
