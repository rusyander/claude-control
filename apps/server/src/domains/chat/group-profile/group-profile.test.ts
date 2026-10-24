import { describe, it, expect } from 'vitest';
import { SPLIT_MCP_TAG } from '@agentdeck/contracts/split-tickets';
import { POWERSHELL_ONLY_ASK, withPowerShellTwins } from '../auto-approve/powershell-twins.ts';
import { MAIN_SYNC_ASK } from '../main-sync/main-sync.ts';
import {
  chatRunProfile,
  foreignGroupMcp,
  compactWindowOf,
  DELIVERY_BASH_DENY,
  groupCompactWindow,
  GROUP_DANGER_ASK,
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

  it('пути и имена из кода о макете не говорят; слово в прозе — говорит', () => {
    // Задача группы 0 живого прогона 20.10.
    expect(needsDesign('Не трогать app/layouts/MainLayout/useAppSocket, shared/api')).toBe(false);
    expect(needsDesign('вынести designTokens.ts и useLayoutEffect')).toBe(false);
    expect(needsDesign('Fix the card layout on mobile')).toBe(true);
    expect(needsDesign('сверить с mockup из тикета')).toBe(true);
  });

  // F-02: точка в конце фразы — пунктуация, не часть пути; фильтр путей съедал слово.
  it('слово в конце фразы с точкой — проза; точка или слэш внутри — путь', () => {
    expect(needsDesign('Fix the layout.')).toBe(true);
    expect(needsDesign('Match the mockup.')).toBe(true);
    expect(needsDesign('Implement the new design. Then ship')).toBe(true);
    expect(needsDesign('See the layout, please')).toBe(true);
    expect(needsDesign('Rename src/layout.ts')).toBe(false);
    expect(needsDesign('Bump design.tokens version')).toBe(false);
    expect(needsDesign('Update layouts\\Main')).toBe(false);
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
/** Запрет слияния MR — во всех звеньях группы (F-13): слияние запрещено всегда. */
const MERGE_RULES = ['atlassian-work', 'gitlab-work'].flatMap((server) => [
  `mcp__${server}__merge_merge_request`,
  `mcp__${server}__merge_pull_request`,
]);

/** Правила оболочки группы — для Bash и для инструмента PowerShell (I-04). */
const shellAsk = (extra: string[] = []): string[] => [
  ...withPowerShellTwins([...GROUP_DANGER_ASK, ...MAIN_SYNC_ASK, ...extra]),
  ...POWERSHELL_ONLY_ASK,
];

const OUTWARD = {
  permissions: {
    ask: ['mcp__atlassian-work', 'mcp__gitlab-work', ...shellAsk()],
    deny: MERGE_RULES,
  },
};

describe('groupRunProfile', () => {
  it('флаг строгого набора, подключения claude.ai сняты, оставленные — своим файлом', () => {
    const run = groupRunProfile({ entries: ENTRIES, tasksText: '', extra: [] });
    // X1: личные секции — из системного промпта в сообщение, копии делят его кэш.
    expect(run.args).toEqual(['--strict-mcp-config', '--exclude-dynamic-system-prompt-sections']);
    // Метка хука блока «Тесты»: автокейсы группа прогоняет перед «доставлено» (пункт A 19.10).
    expect(run.env).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      AGENTDECK_TESTS_RUNS_AT_DELIVERY: '1',
    });
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
    expect(odd.settings.permissions).toEqual({
      ask: ['mcp__gitlab_work', ...shellAsk()],
      deny: ['mcp__gitlab_work__merge_merge_request', 'mcp__gitlab_work__merge_pull_request'],
    });
    // Без хранилища кода и трекера остаются правила опасных команд оболочки и догона main.
    const none = groupRunProfile({ entries: [ENTRIES[6]!], tasksText: '', extra: [] });
    expect(none.settings.permissions).toEqual({ ask: shellAsk() });
  });

  it('инструмент PowerShell — к брокеру теми же правилами, что Bash, и своими (I-04)', () => {
    // В авторежиме `git push origin HEAD:main` и `Remove-Item -Recurse` из PowerShell
    // шли мимо брокера: правило `Bash(…)` этот инструмент не задевает.
    const { permissions } = groupRunProfile({ entries: [], tasksText: '', extra: [] }).settings;
    const ask = (permissions as { ask: string[] }).ask;
    for (const rule of [
      'PowerShell(git *)',
      'PowerShell(*git.exe *)',
      'PowerShell(Remove-Item *)',
      'PowerShell(rm *)',
      'PowerShell(gh *)',
      'PowerShell(Invoke-Expression *)',
      'PowerShell(Start-Process *)',
      'PowerShell(Invoke-RestMethod *merge*)',
    ]) {
      expect(ask).toContain(rule);
    }
    expect(ask.filter((rule) => rule.startsWith('Bash(')).length).toBe(
      ask.filter((rule) => rule.startsWith('PowerShell(') && !POWERSHELL_ONLY_ASK.includes(rule))
        .length,
    );
  });

  it('имена псевдонимов и функций снимка — правилом ask к брокеру (24.10, a/d)', () => {
    // `grb origin/main` при `alias grb='git rebase'` и функция `gsync` не задеты ни
    // одним правилом выше: в авторежиме CLI их разрешал классификатор, мимо брокера.
    const run = groupRunProfile({
      entries: [ENTRIES[6]!],
      tasksText: '',
      extra: [],
      shellNames: ['grb', 'gsync', 'grb', 'bad*name', 'two words', 'x(y)'],
    });
    expect(run.settings.permissions).toEqual({
      ask: shellAsk(['Bash(grb)', 'Bash(grb *)', 'Bash(gsync)', 'Bash(gsync *)']),
    });
  });

  it('пуш, слияние, удаление и снос базы оболочкой — правилом ask к брокеру (политика 19.10)', () => {
    // Авторежим CLI решает сам всё, что не задето правилом `ask`: с одним
    // принудительным пушем в списке `git push origin main`, `git merge`,
    // `git branch -D` и `rm -rf src` проходили без карточки. Формы проверены
    // настоящим CLI в tools/qa/check-group-forge-ask.mjs.
    const settings = groupRunProfile({ entries: [], tasksText: '', extra: [] }).settings as {
      permissions?: { ask?: string[] };
    };
    const ask = settings.permissions?.ask;
    expect(ask).toEqual(
      expect.arrayContaining([
        // Весь git (F-28): затирание со снимком и удаление данных git брокер
        // должен увидеть, иначе авторежим CLI пропустил бы `reset --hard` без снимка.
        'Bash(git *)',
        'Bash(* git *)',
        'Bash(*/git *)',
        'Bash(*git.exe *)',
        'Bash(rm *)',
        'Bash(Remove-Item *)',
        'Bash(psql*)',
        'Bash(gh *)',
        'Bash(glab *)',
      ]),
    );
    // Рутина вне git правилом не задета: её решает авторежим, как раньше.
    expect(ask?.some((rule) => /^Bash\((pnpm|npm|node)/.test(rule))).toBe(false);
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
    expect(run.env).toEqual({ AGENTDECK_TESTS_RUNS_AT_DELIVERY: '1' });
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
      AGENTDECK_TESTS_RUNS_AT_DELIVERY: '1',
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

  it('с макетом плагин макетов выключен в доставке и пуше, в работе, ревью и правках — нет', () => {
    const off = { 'figma@claude-plugins-official': false, 'discord@x': false };
    expect(skillSettings(SKILLS, true, 'deliver').enabledPlugins).toEqual(off);
    expect(skillSettings(SKILLS, true, 'push').enabledPlugins).toEqual(off);
    for (const stage of ['plan', 'work', 'review', 'fix'] as const) {
      expect(skillSettings(SKILLS, true, stage).enabledPlugins).toEqual({ 'discord@x': false });
    }
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
    for (const name of ['my-skill', 'deep-review', 'kit-skill', 'ticket-delivery-2', 'dataviz']) {
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

describe('groupRunProfile — рычаги экономии групп', () => {
  const ON = {
    bashOutputChars: 8000,
    readOutputTokens: 10000,
    cacheTtl: '1h',
    detachIde: true,
    workHabits: true,
  } as const;

  it('включённые рычаги едут в запуск: env процесса, env настроек, ключ Bash, строка привычек', () => {
    const run = groupRunProfile({ entries: [], tasksText: '', extra: [], economy: ON });
    // IDE — env процесса: CLI читает его раньше настроек, а связь с редактором
    // приходит от процесса панели, запущенной из терминала VS Code.
    expect(run.env).toMatchObject({ CLAUDE_CODE_AUTO_CONNECT_IDE: 'false' });
    // Привычки работы гасят и напоминание о молчании: в стадии отчёта посреди
    // работы никто не читает, а ход на него оплачивается.
    expect(run.env).toMatchObject({ CLAUDE_CODE_SILENT_TURN_REMINDER: '0' });
    // Часовой кэш группе задаёт `cacheTtl`; общий тумблер CLI лишь переписал бы
    // выбор человека для всего прогона.
    expect(run.env).not.toHaveProperty('ENABLE_PROMPT_CACHING_1H');
    expect(run.settings.env).toEqual({
      BASH_MAX_TIMEOUT_MS: '1800000',
      CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: '10000',
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    });
    // Ключ настроек, а не BASH_MAX_OUTPUT_LENGTH: в 2.1.286 переменная лишь окно дочитывания.
    expect(run.settings).toMatchObject({ bashOutputMaxChars: 8000 });
    expect(run.settings).not.toHaveProperty('env.BASH_MAX_OUTPUT_LENGTH');
    // F-10: подагентов строка не советует — их запуск по согласию человека
    // (директива L9), а промпт без меток хука отклоняется и оплачивается дважды.
    expect(run.note).toContain('one `a; b; c`');
    expect(run.note).not.toMatch(/\bAgent\b|Explore|subagent|\bsonnet\b/i);
    expect(run.note).toContain('do not `cd`');
  });

  it('ноль, пусто и выключено — ничего: решает CLI и настройки человека', () => {
    const run = groupRunProfile({
      entries: [],
      tasksText: '',
      extra: [],
      economy: {
        bashOutputChars: 0,
        readOutputTokens: 0,
        cacheTtl: '',
        detachIde: false,
        workHabits: false,
      },
    });
    expect(run.env).not.toHaveProperty('CLAUDE_CODE_AUTO_CONNECT_IDE');
    expect(run.env).not.toHaveProperty('CLAUDE_CODE_SILENT_TURN_REMINDER');
    expect(run.settings.env).toEqual(CEILING.env);
    expect(run.settings).not.toHaveProperty('bashOutputMaxChars');
    expect(run.note).not.toContain('Explore');
    // Без блока экономии вовсе (старый вызов) — то же самое.
    const bare = groupRunProfile({ entries: [], tasksText: '', extra: [] });
    expect(bare.settings.env).toEqual(CEILING.env);
    expect(bare.note).toBe(run.note);
  });

  it('окно сжатия — env процесса: переменная панели сильнее настройки, ноль — окно человека', () => {
    expect(groupCompactWindow(undefined, 160_000)).toBe(160_000);
    expect(groupCompactWindow('250k', 160_000)).toBe(250_000);
    expect(groupCompactWindow(undefined, 0)).toBeUndefined();
    // Вне границ CLI (100k–1M) — выключено, а не зажато молча.
    expect(groupCompactWindow(undefined, 50_000)).toBeUndefined();
    expect(groupCompactWindow('junk', 120_000)).toBe(120_000);
    const run = groupRunProfile({ entries: [], tasksText: '', extra: [], compactWindow: 160_000 });
    expect(run.env).toMatchObject({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '160000' });
  });
});

/**
 * Директива L3: звено не делает работу следующих — за ним ревью на потолке, и
 * свой проход ревью оплачивался бы второй раз; за ним доставка, и пуш или MR
 * раньше неё ломают её дельту.
 */
describe('groupRunProfile — слияние MR закрыто в каждом звене (F-13)', () => {
  it('работа, правки, ревью, доставка и звено без стадии: запрет на слияние у серверов наружу', () => {
    for (const stage of ['work', 'fix', 'review', 'deliver', undefined] as const) {
      const { settings } = groupRunProfile({
        entries: ENTRIES,
        tasksText: '',
        extra: [],
        ...(stage ? { stage } : {}),
      });
      const deny = (settings.permissions as { deny?: string[] }).deny ?? [];
      expect(deny, `звено ${stage ?? '—'}`).toEqual(expect.arrayContaining(MERGE_RULES));
    }
  });
});

describe('groupRunProfile — работа следующих звеньев запрещена (L3)', () => {
  // Запрет слияния есть всегда (F-13) — здесь проверяются запреты «на будущее».
  const deny = (ahead: { review?: boolean; deliver?: boolean } | undefined): string[] => {
    const { settings } = groupRunProfile({
      entries: ENTRIES,
      tasksText: '',
      extra: [],
      stage: 'work',
      ...(ahead ? { ahead } : {}),
    });
    const rules = (settings.permissions as { deny?: string[] }).deny ?? [];
    return rules.filter((rule) => !MERGE_RULES.includes(rule));
  };

  it('за звеном ревью — навыки ревью выключены из перечня и под запретом, строка называет, кто прочитает', () => {
    // F-09: ревью-полоса через Agent — тот же второй проход, что и навык ревью.
    expect(deny({ review: true })).toEqual([
      'Skill(deep-review)',
      'Skill(style-conformance-review)',
      'Agent',
    ]);
    const run = groupRunProfile({
      entries: [],
      tasksText: '',
      extra: [],
      skills: { user: ['deep-review', 'prepare-mr'], group: [], plugins: [] },
      stage: 'work',
      ahead: { review: true },
    });
    // `deny` на Skill(…) в 2.1.286 не снимает описание — снимает `off`.
    expect(run.settings).toMatchObject({
      skillOverrides: { 'deep-review': 'off', 'style-conformance-review': 'off' },
    });
    expect(run.note).toContain('a review stage on the ceiling model reads this work');
  });

  // Владелец 23.10: полный гейт группы один, в доставке. Хук набора `gate-at-end`
  // узнаёт звено и «за ним доставка» по этим переменным.
  it('звено и «за ним доставка» — переменными прогона для хука гейта', () => {
    const env = (stage: 'work' | 'deliver', ahead?: { deliver?: boolean }) =>
      groupRunProfile({ entries: [], tasksText: '', extra: [], stage, ...(ahead ? { ahead } : {}) })
        .env;
    expect(env('work', { deliver: true })).toMatchObject({
      AGENTDECK_GROUP_STAGE: 'work',
      AGENTDECK_GROUP_DELIVER_AHEAD: '1',
    });
    expect(env('deliver')).toMatchObject({ AGENTDECK_GROUP_STAGE: 'deliver' });
    expect(env('deliver')).not.toHaveProperty('AGENTDECK_GROUP_DELIVER_AHEAD');
    expect(groupRunProfile({ entries: [], tasksText: '', extra: [] }).env).not.toHaveProperty(
      'AGENTDECK_GROUP_STAGE',
    );
  });

  it('за звеном доставка — пуш, MR через CLI форджа и через MCP наружу; коммит и прочая запись открыты', () => {
    const rules = deny({ deliver: true });
    expect(rules).toEqual([
      ...withPowerShellTwins(DELIVERY_BASH_DENY),
      'mcp__atlassian-work__create_merge_request',
      'mcp__atlassian-work__create_pull_request',
      'mcp__gitlab-work__create_merge_request',
      'mcp__gitlab-work__create_pull_request',
    ]);
    // Пуш из инструмента PowerShell закрыт так же (I-04).
    expect(rules).toEqual(
      expect.arrayContaining(['PowerShell(git push*)', 'PowerShell(gh pr create*)']),
    );
    expect(rules.some((rule) => rule.includes('commit'))).toBe(false);
    // Запись в трекер звену работы остаётся: снято только открытие MR.
    expect(rules.some((rule) => /create_issue|update_/.test(rule))).toBe(false);
  });

  it('пуш с глобальным ключом git перед подкомандой — тоже под запретом и тоже к брокеру (журнал 23.10)', () => {
    // Звено ревью отправило ветку `git -c gc.auto=0 push` мимо запрета. Сверка —
    // по правилу CLI: `*` — любая строка, пустая тоже, правило — вся команда.
    const matches = (rule: string, command: string) => {
      const body = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (body === undefined) return false;
      const pattern = body
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[\\s\\S]*');
      return new RegExp(`^${pattern}$`).test(command);
    };
    const rules = deny({ deliver: true });
    const denied = (command: string) => rules.some((rule) => matches(rule, command));
    const asked = (command: string) => GROUP_DANGER_ASK.some((rule) => matches(rule, command));
    for (const command of [
      'git -c gc.auto=0 push origin HEAD',
      'git -c gc.auto=0 -c core.pager=cat push',
      'git push origin HEAD:feat/users',
      'git -C . push',
      // F-28: глобальные ключи без значения и другое имя git.
      'git -P push origin main',
      'git --no-pager push origin feat/x',
      'git --git-dir=.git push',
      'git --no-optional-locks push',
      'command git push origin main',
      'command git --no-pager push',
      '/usr/bin/git push origin main',
      'C:/Program Files/Git/cmd/git.exe push',
      'git.exe -P push',
    ]) {
      expect(denied(command), command).toBe(true);
      expect(asked(command), command).toBe(true);
    }
    for (const command of [
      'git -c core.hooksPath=/dev/null merge main',
      'git --no-pager branch -D feat/x',
      'git -P tag -d v1',
      'env GIT_DIR=x git reset --hard',
      'command git clean -fdx',
      '/usr/bin/git update-ref -d refs/heads/x',
      'git reflog expire --expire=now --all',
    ]) {
      expect(asked(command), command).toBe(true);
    }
    // Коммит и чтение с теми же ключами открыты: запрет — только публикация.
    expect(denied('git -c gc.auto=0 commit -m wip')).toBe(false);
    expect(denied('git -c color.ui=never log --oneline -3')).toBe(false);
    expect(denied('git --no-pager log --oneline -3')).toBe(false);
    expect(denied('command git status')).toBe(false);

    // RF-BGCD-07, формы, замеренные настоящим CLI (`cli-forms.mjs`): шли к
    // классификатору авторежима мимо и запрета, и брокера — теперь под запретом.
    for (const command of [
      'Git push origin HEAD:p15',
      'GIT push origin main',
      'GIT.EXE push origin HEAD:p14',
      "bash -c 'git push origin HEAD:p13'",
      'sh -c "git push origin HEAD:p16"',
      'eval git push origin HEAD:p17',
      'git send-pack origin HEAD:p08',
      'git -C . send-pack origin main',
    ]) {
      expect(denied(command), command).toBe(true);
      expect(asked(command), command).toBe(true);
    }
    // Мимо шаблона запрета, но к брокеру — там их судит `publishesBeforeDelivery`.
    for (const command of [
      "bash -c 'Git push origin main'",
      'zsh -c "git --no-pager push"',
      'cmd /c git push origin main',
      'pwsh -c "git push origin main"',
      'powershell -Command "git push"',
    ]) {
      expect(asked(command), command).toBe(true);
    }
    // Обычная работа вложенной оболочкой — не запрет (её брокер пропускает сам).
    expect(denied("bash -c 'npm test'")).toBe(false);
    expect(denied("bash -c 'git commit -m wip'")).toBe(false);
  });

  it('ничего не следует — запретов и строки нет', () => {
    expect(deny(undefined)).toEqual([]);
    expect(deny({ review: false, deliver: false })).toEqual([]);
    const run = groupRunProfile({ entries: [], tasksText: '', extra: [] });
    expect(run.note).not.toContain('Later stages');
  });
});
