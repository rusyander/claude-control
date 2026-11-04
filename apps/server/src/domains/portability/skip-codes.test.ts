import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEnvironment, EnvSkip } from '@agentdeck/contracts/portable-env';
import { isServerMessageCode, resolveServerParams } from '@agentdeck/contracts/server-messages';
import { serverMessagesEn } from '../../../../web/src/shared/config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../../../web/src/shared/config/i18n/server-messages/ru.ts';
import { CATALOG_PROVIDERS } from '../../providers/catalog/catalog.ts';
import { claudeProvider } from '../../providers/claude.ts';
import { importEnvironment } from './import/index.ts';

/**
 * Причины пропусков в паспорте переноса под английским интерфейсом. `detail`
 * пропуска и состояния раздела — русская фраза сервера; без кода перевода
 * en-экран паспорта показывал её по-русски. Паспорта собираются ЗДЕСЬ тем же
 * импортом, что и у панели, по живым файлам во временном доме с латинскими
 * именами: кириллица в английском показе может прийти только из фразы сервера.
 * И обратное направление: русский показ по коду дословно равен строке сервера —
 * иначе словарь и сервер разошлись, и ru-экран показывал бы не ту фразу.
 */

const CYRILLIC = /[А-Яа-яЁё]/;
const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CODEX_HOME',
  'QWEN_HOME',
  'KIMI_CODE_HOME',
  'XDG_CONFIG_HOME',
  'APPDATA',
  'CONTINUE_GLOBAL_DIR',
  'GEMINI_CLI_HOME',
  'CLAUDE_CONFIG_DIR',
];
const saved: Record<string, string | undefined> = {};
let home: string;

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Дом Claude, в котором каждый раздел даёт свой пропуск. */
function writeClaudeHome(root: string, registry: object, options: object): void {
  put(join(root, 'agents', 'bare.md'), 'no front matter here');
  put(join(root, 'agents', '.md'), '---\ndescription: x\n---\nbody');
  put(join(root, 'agents', 'huge.md'), 'x'.repeat(1_000_001));
  mkdirSync(join(root, 'skills', 'synced', 'nofile'), { recursive: true });
  mkdirSync(join(root, 'adir.md'), { recursive: true });
  for (let depth = 0; depth < 7; depth += 1) {
    put(join(root, `deep${depth}.md`), `level ${depth}\n@deep${depth + 1}.md\n`);
  }
  put(join(root, 'AGENTS.md'), 'Agents.');
  put(
    join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        pigeon: { type: 'carrier-pigeon', url: 'http://127.0.0.1:1' },
        inproc: { type: 'sdk', name: 'inproc' },
      },
    }),
  );
  put(join(root, 'agents', 'nameless.md'), '---\nname: ""\ndescription: x\n---\nbody');
  mkdirSync(join(root, 'agents', 'folder.md'), { recursive: true });
  mkdirSync(join(root, 'skills', 'noskill'), { recursive: true });
  put(join(root, 'CLAUDE.md'), 'Root.\n@CLAUDE.md\n@adir.md\n@deep0.md\n');
  put(
    join(root, 'settings.json'),
    JSON.stringify({
      pluginConfigs: { 'agents-md@builtin': { options } },
      hooks: {
        BogusEvent: [{ hooks: [{ type: 'command', command: 'echo bogus' }] }],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `node ${join(root, 'hooks', 'gone.mjs')}` }],
          },
        ],
      },
      enabledPlugins: { 'off@market': false, 'on@market': true },
    }),
  );
  put(join(root, 'plugins', 'installed_plugins.json'), JSON.stringify(registry));
}

interface Shown {
  where: string;
  detail: string;
  detailCode?: string;
  detailParams?: EnvSkip['detailParams'];
}

const rows: Shown[] = [];

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`no param ${name} in «${template}»`);
    return String(params[name]);
  });
}

/** Показ так же, как `serverFieldText(skip, 'detail')`: код с подстановками, иначе строка сервера. */
function shown(row: Shown, dictionary: Record<string, string>): string {
  const code = row.detailCode;
  if (!isServerMessageCode(code)) return row.detail;
  const render = (inner: string, params?: Record<string, string | number>) =>
    dictionary[inner] === undefined ? undefined : interpolate(dictionary[inner], params ?? {});
  const params = resolveServerParams(row.detailParams, render);
  if (!params) throw new Error(`${row.where}: nested code unknown to the dictionary`);
  return interpolate(dictionary[code]!, params);
}

function collect(label: string, deps: Parameters<typeof importEnvironment>[0]): AgentEnvironment {
  const env = importEnvironment(deps);
  for (const skip of env.skipped) rows.push({ where: `${label} skip ${skip.kind}`, ...skip });
  for (const [kind, state] of Object.entries(env.sectionStates ?? {})) {
    if (state?.detail) rows.push({ where: `${label} section ${kind}`, ...state });
  }
  return env;
}

/** Паспорт дома Claude с битым settings.json — проверяется отдельным тестом ниже. */
let brokenClaude: AgentEnvironment | undefined;
let brokenGemini: AgentEnvironment | undefined;
let opencodeGlobal: AgentEnvironment | undefined;
let brokenGoose: AgentEnvironment | undefined;
let cursorDirMcp: AgentEnvironment | undefined;
const YAML_SECRET = 'sk-yaml-marker-7f3a';

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cc-skip-codes-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, 'AppData');

  const claude = claudeProvider;
  const old = join(home, 'claude-old');
  writeClaudeHome(old, { version: 1, plugins: {} }, { instructionFiles: 'weird-mode' });
  const current = join(home, 'claude-current');
  writeClaudeHome(
    current,
    {
      version: 2,
      plugins: {
        'noinstall@market': [{}],
        'gone@market': [{ installPath: join(home, 'nowhere') }],
        'off@market': [{ installPath: join(home, 'plugin-off') }],
        'on@market': [{ installPath: join(home, 'plugin-on') }],
      },
    },
    { projectInstructions: 'claude-md' },
  );
  mkdirSync(join(home, 'plugin-on', 'skills', 'nofile'), { recursive: true });
  put(join(home, 'plugin-on', 'agents', 'bare.md'), 'no front matter here');
  const managed = join(home, 'claude-managed');
  writeClaudeHome(managed, { version: 2, plugins: {} }, { instructionFiles: 'managed-only' });
  collect('claude managed', { provider: claude, scope: 'global', override: managed });
  const either = join(home, 'claude-either');
  writeClaudeHome(
    either,
    { version: 2, plugins: {} },
    { instructionFiles: 'claude-md-or-agents-md' },
  );
  collect('claude either', { provider: claude, scope: 'global', override: either });
  mkdirSync(join(home, 'plugin-off', 'skills', 'x'), { recursive: true });
  put(join(home, 'plugin-off', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\nbody');
  collect('claude old', { provider: claude, scope: 'global', override: old });
  collect('claude current', { provider: claude, scope: 'global', override: current });
  const minimal = join(home, 'claude-minimal');
  put(join(minimal, 'CLAUDE.md'), 'Root.');
  mkdirSync(join(minimal, 'plugins', 'cache'), { recursive: true });
  collect('claude minimal', { provider: claude, scope: 'global', override: minimal });
  collect('claude empty', { provider: claude, scope: 'global', override: join(home, 'empty') });
  // Ни подмены, ни CLAUDE_CONFIG_DIR, ни ~/.claude — каталог не найден вовсе.
  collect('claude none', { provider: claude, scope: 'global' });
  // Реестр плагинов без номера версии.
  const noVersion = join(home, 'claude-no-version');
  writeClaudeHome(noVersion, { plugins: {} }, {});
  collect('claude no-version', { provider: claude, scope: 'global', override: noVersion });
  // Битый settings.json: остальные разделы обязаны остаться в паспорте.
  const broken = join(home, 'claude-broken');
  put(join(broken, 'CLAUDE.md'), 'Root.');
  put(join(broken, 'agents', 'helper.md'), '---\nname: helper\ndescription: x\n---\nbody');
  put(join(broken, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody');
  put(join(broken, 'commands', 'hello.md'), 'say hello');
  put(join(broken, 'settings.json'), '{ not json');
  brokenClaude = collect('claude broken', { provider: claude, scope: 'global', override: broken });
  collect('claude no-project', {
    provider: claude,
    scope: 'project',
    override: current,
    projectRoot: join(home, 'no-such-project'),
  });
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  collect('claude project', {
    provider: claude,
    scope: 'project',
    override: current,
    projectRoot: project,
  });

  // Codex: разделы, которые панель называет, но не переносит.
  put(
    join(home, '.codex', 'config.toml'),
    [
      'approval_policy = "sometimes"',
      'sandbox_mode = "workspace-write"',
      '[agents.reviewer]',
      'description = "x"',
      '[[skills.config]]',
      'path = "x"',
      '',
    ].join('\n'),
  );
  mkdirSync(join(home, '.codex', 'prompts'), { recursive: true });
  put(join(home, '.codex', 'prompts', 'p.md'), 'prompt');

  // Continue: файл-блок MCP, который не разбирается.
  put(join(home, '.continue', 'mcpServers', 'broken.yaml'), ': : not yaml [');
  put(
    join(home, '.continue', 'mcpServers', 'a-first.yaml'),
    'name: block\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: twin\n    command: npx\n',
  );
  put(
    join(home, '.continue', 'mcpServers', 'b-second.yaml'),
    'name: block\nversion: 0.0.1\nschema: v1\nmcpServers:\n  - name: twin\n    command: npx\n',
  );

  // Qwen: disableAllHooks выключает раздел.
  put(
    join(home, '.qwen', 'settings.json'),
    JSON.stringify({
      disableAllHooks: true,
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo q' }] }] },
    }),
  );

  // Kimi: режим прав вне набора — фраза читателя, код восстанавливается разбором.
  put(join(home, '.kimi-code', 'config.toml'), 'default_permission_mode = "stale-mode"\n');

  // Gemini: файл настроек, который не разбирается; файл инструкций рядом цел;
  // команда без ключа prompt.
  put(join(home, '.gemini', 'settings.json'), '{ not json');
  put(join(home, '.gemini', 'GEMINI.md'), 'Be brief.');
  put(join(home, '.gemini', 'commands', 'bare.toml'), 'description = "no prompt"\n');

  // OpenCode: ключ прав без документированной формы и команда, объявленная в конфиге.
  put(
    join(home, '.config', 'opencode', 'opencode.json'),
    JSON.stringify({
      permission: { bogus: 42 },
      command: { hello: { template: 'say hello' } },
    }),
  );

  // Continue: правило проекта с расширением, которое CLI не читает.
  put(join(project, '.continue', 'rules', 'note.txt'), 'not a rule');

  // Qwen: каталог скилла без SKILL.md.
  mkdirSync(join(home, '.qwen', 'skills', 'nofile'), { recursive: true });

  // Aider: список read со ссылкой на несуществующий файл.
  put(join(home, '.aider.conf.yml'), 'read:\n  - missing-conventions.md\n');

  // Goose: config.yaml не разбирается, а рядом ключ API — разборщик YAML
  // цитирует строку файла, и причина обязана обойтись без этой цитаты.
  put(
    process.platform === 'win32'
      ? join(home, 'AppData', 'Block', 'goose', 'config', 'config.yaml')
      : join(home, '.config', 'goose', 'config.yaml'),
    `OPENAI_API_KEY: ${YAML_SECRET}\nextensions: [unclosed\n`,
  );

  // Cursor: на месте mcp.json — каталог; отказ ОС несёт только путь и код.
  mkdirSync(join(home, '.cursor', 'mcp.json'), { recursive: true });

  // Провайдер, проектный уровень которого не задокументирован (статус planned).
  const gemini = CATALOG_PROVIDERS.find((provider) => provider.id === 'gemini')!;
  collect('gemini planned project', {
    provider: { ...gemini, capabilities: { ...gemini.capabilities, projects: 'planned' } },
    scope: 'project',
    projectRoot: project,
  });

  for (const provider of CATALOG_PROVIDERS) {
    if (provider.id === 'claude') continue;
    const env = collect(`${provider.id} global`, { provider, scope: 'global' });
    if (provider.id === 'gemini') brokenGemini = env;
    if (provider.id === 'opencode') opencodeGlobal = env;
    if (provider.id === 'goose') brokenGoose = env;
    if (provider.id === 'cursor') cursorDirMcp = env;
    collect(`${provider.id} project`, { provider, scope: 'project', projectRoot: project });
  }

  if (process.env.SKIP_CODES_DUMP) {
    writeFileSync(
      process.env.SKIP_CODES_DUMP,
      rows.map((row) => `${row.where} | ${row.detailCode ?? '-'} | ${row.detail}`).join('\n'),
    );
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

/** Причина пропуска вида в паспорте — en и ru показ. */
function reasons(env: AgentEnvironment | undefined, kind: string) {
  return (env?.skipped ?? [])
    .filter((skip) => skip.kind === kind)
    .map((skip) => {
      const row = { where: kind, ...skip };
      return {
        code: skip.detailCode,
        en: shown(row, serverMessagesEn as Record<string, string>),
        ru: shown(row, serverMessagesRu as Record<string, string>),
        server: skip.detail,
      };
    });
}

describe('нечитаемый источник не роняет паспорт', () => {
  it('Claude: битый settings.json — остальные разделы на месте, разделы файла пропущены с причиной', () => {
    const kinds = new Set(brokenClaude?.items.map((item) => item.kind));
    for (const kind of ['instructions', 'subagent', 'skill', 'command']) {
      expect(kinds, kind).toContain(kind);
    }
    const hooks = reasons(brokenClaude, 'hook');
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.code).toBe('portability-skip-section-unreadable');
    expect(hooks[0]!.en).toMatch(/settings\.json: section not read — the file is not valid JSON$/);
    expect(hooks[0]!.ru).toBe(hooks[0]!.server);
    expect(hooks[0]!.ru).toMatch(
      /settings\.json: раздел не прочитан — файл не разбирается как JSON$/,
    );
    for (const kind of ['permission', 'envVar']) {
      expect(
        reasons(brokenClaude, kind).map((reason) => reason.code),
        kind,
      ).toContain('portability-skip-section-unreadable');
    }
    expect(reasons(brokenClaude, 'instructions').map((reason) => reason.code)).toContain(
      'instruction-files-settings-unread',
    );
  });

  it('Gemini: битый settings.json — GEMINI.md на месте, MCP пропущен с причиной', () => {
    expect(brokenGemini?.items.map((item) => item.kind)).toContain('instructions');
    const mcp = reasons(brokenGemini, 'mcpServer');
    expect(mcp.map((reason) => reason.code)).toEqual(['portability-skip-section-unreadable']);
    expect(mcp[0]!.en).toMatch(/settings\.json: section not read — /);
  });

  it('Goose: битый config.yaml — причина без цитаты файла (рядом ключ API)', () => {
    const shownAll = JSON.stringify(brokenGoose);
    expect(shownAll).not.toContain(YAML_SECRET);
    for (const kind of ['mcpServer', 'permission']) {
      const [reason, ...rest] = reasons(brokenGoose, kind);
      expect(rest, kind).toEqual([]);
      expect(reason?.code, kind).toBe('portability-skip-section-unreadable');
      expect(reason?.en, kind).toMatch(
        /config\.yaml: section not read — the file content cannot be parsed$/,
      );
      expect(reason?.ru, kind).toBe(reason?.server);
    }
  });

  it('Cursor: на месте mcp.json каталог — отказ ОС назван путём и кодом', () => {
    const [reason, ...rest] = reasons(cursorDirMcp, 'mcpServer');
    expect(rest).toEqual([]);
    expect(reason?.code).toBe('portability-skip-section-unreadable');
    expect(reason?.en).toMatch(/mcp\.json: section not read — E[A-Z]+: /);
  });
});

describe('команда, объявленная ключом конфига', () => {
  it('OpenCode: тело команды из opencode.json не едет — назван пропуск, а не весь конфиг вместо подсказки', () => {
    const commands = (opencodeGlobal?.items ?? []).filter((item) => item.kind === 'command');
    expect(commands).toEqual([]);
    expect(reasons(opencodeGlobal, 'command').map((reason) => reason.en)).toEqual([
      '/hello: the command body is not in a file',
    ]);
  });
});

describe('паспорт переноса: причины пропусков под английским интерфейсом', () => {
  it('собраны пропуски каждой ветки фразы', () => {
    const codes = new Set<string | undefined>();
    for (const row of rows) {
      codes.add(row.detailCode);
      for (const value of Object.values(row.detailParams ?? {})) {
        if (typeof value === 'object') codes.add(value.messageCode);
      }
    }
    const missing = EXPECTED_CODES.filter((code) => !codes.has(code));
    expect(missing).toEqual([]);
  });

  it('под en ни одна причина не показывается по-русски', () => {
    const russian = rows
      .map((row) => ({
        where: row.where,
        text: shown(row, serverMessagesEn as Record<string, string>),
      }))
      .filter((row) => CYRILLIC.test(row.text));
    expect(russian).toEqual([]);
  });

  it('под ru показ по коду дословно равен строке сервера', () => {
    const drift = rows
      .filter((row) => row.detailCode !== undefined)
      .map((row) => ({
        where: row.where,
        server: row.detail,
        shown: shown(row, serverMessagesRu as Record<string, string>),
      }))
      .filter((row) => row.server !== row.shown);
    expect(drift).toEqual([]);
  });
});

/** Ветки, до которых дотягиваются файлы этого дома; пустой список проверку бы обезглавил. */
const EXPECTED_CODES: string[] = [
  'commands-plugin-dir-missing',
  'location-not-found',
  'plugin-registry-no-version',
  'portability-cause-not-json',
  'portability-skip-section-unreadable',
  'portability-skip-project-undocumented',
  'portability-skip-mcp-transport',
  'portability-skip-command-body-config',
  'instruction-files-settings-unread',
  'commands-plugin-registry-version',
  'instruction-files-claude-md',
  'instruction-files-claude-or-agents',
  'instruction-files-managed-only',
  'instruction-files-value-unknown',
  'kimi-mode-stale',
  'location-dir-missing',
  'mcp-block-duplicate',
  'mcp-block-unparsed',
  'portability-import-cycle',
  'portability-import-depth',
  'portability-import-unread',
  'portability-section-hooks-off',
  'portability-skip-codex-agents',
  'portability-skip-codex-approval',
  'portability-skip-codex-prompts',
  'portability-skip-codex-sandbox',
  'portability-skip-codex-skills',
  'portability-skip-file-absent',
  'portability-skip-file-missing',
  'portability-skip-hook-event',
  'portability-skip-hook-script-missing',
  'portability-skip-import-problem',
  'portability-skip-mcp-block',
  'portability-skip-mcp-sdk',
  'portability-skip-no-records',
  'portability-skip-no-section',
  'portability-skip-no-section-project',
  'portability-skip-no-skill-file',
  'portability-skip-permission-preserved',
  'portability-skip-plugin-dir-missing',
  'portability-skip-plugin-disabled',
  'portability-skip-plugin-no-install',
  'portability-skip-plugin-registry-missing',
  'portability-skip-plugin-registry-version',
  'portability-skip-plugins-home-only',
  'portability-skip-project-instructions-key',
  'portability-skip-project-missing',
  'portability-skip-rule-extension',
  'portability-skip-secrets-home-only',
  'portability-skip-subagent-problem',
  'portability-subagent-empty-name',
  'portability-subagent-no-frontmatter',
  'portability-subagent-not-file',
  'portability-subagent-too-big',
];
