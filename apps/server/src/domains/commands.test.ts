import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudePaths } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { readClaudeCommands, readProviderCommands } from './commands.ts';
import type { ConfigProvider } from '../providers/types.ts';

/**
 * Слэш-команды собираются из четырёх независимых мест, и врать список не имеет
 * права ни в одном: выключенный скилл обязан остаться видимым (иначе непонятно,
 * куда делась команда), подкаталог обязан давать пространство имён (иначе имя в
 * панели не совпадёт с тем, что набирают), а команда плагина — нести префикс
 * плагина. Всё во временном каталоге, настоящий ~/.claude не трогаем.
 */
describe('команды Claude', () => {
  let root: string;
  let paths: ClaudePaths;
  let store: AppStore;

  const put = (relative: string, content: string): void => {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-commands-'));
    mkdirSync(join(root, 'skills'), { recursive: true });
    paths = {
      root,
      settings: join(root, 'settings.json'),
      settingsLocal: join(root, 'settings.local.json'),
      claudeMd: join(root, 'CLAUDE.md'),
      secretsEnv: join(root, '.mcp-secrets.env'),
      skills: join(root, 'skills'),
      hooks: join(root, 'hooks'),
      mcpConfig: join(root, 'claude.json'),
      appData: join(root, 'claude-control'),
    };
    store = new AppStore(paths.appData);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('скилл становится командой, а его описание берётся из шапки', () => {
    put(
      'skills/deep-review/SKILL.md',
      '---\nname: deep-review\ndescription: Глубокий разбор\n---\nтело',
    );

    const { commands } = readClaudeCommands(paths, store);

    expect(commands).toEqual([
      expect.objectContaining({
        invocation: '/deep-review',
        source: 'skill',
        description: 'Глубокий разбор',
        target: 'skill',
        targetId: 'deep-review',
        isEnabled: true,
      }),
    ]);
  });

  /**
   * Выключенный скилл из палитры пропадает — и человек приходит в панель именно
   * с вопросом «куда делась команда». Спрятать его здесь значило бы не ответить.
   */
  it('выключенный скилл остаётся в списке с пометкой, а не исчезает', () => {
    put(
      'skills-disabled/prototype/SKILL.md',
      '---\nname: prototype\ndescription: Быстрый прототип\n---\nтело',
    );

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({ invocation: '/prototype', isEnabled: false });
    expect(commands[0]?.path).toContain('skills-disabled');
  });

  it('подкаталог команд даёт пространство имён: git/commit.md → /git:commit', () => {
    put(
      'commands/git/commit.md',
      '---\ndescription: Собрать коммит\nargument-hint: [scope]\n---\n',
    );

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({
      invocation: '/git:commit',
      name: 'git:commit',
      source: 'command',
      description: 'Собрать коммит',
      argumentHint: '[scope]',
    });
  });

  it('файл команды без шапки описывается первой значимой строкой, а не пустотой', () => {
    put('commands/deploy.md', '\n# Заголовок\n\nВыкатить сборку на стенд.\n');

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]?.description).toBe('Выкатить сборку на стенд.');
  });

  it('команда плагина вызывается с префиксом плагина и знает своего владельца', () => {
    const installPath = join(root, 'plugins', 'cache', 'commit-commands');
    mkdirSync(join(installPath, 'commands'), { recursive: true });
    writeFileSync(
      join(installPath, 'commands', 'commit.md'),
      '---\ndescription: Сделать коммит\n---\n',
    );
    put(
      'plugins/installed_plugins.json',
      JSON.stringify({ version: 2, plugins: { 'commit-commands@official': [{ installPath }] } }),
    );
    put('settings.json', JSON.stringify({ enabledPlugins: { 'commit-commands@official': true } }));

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({
      invocation: '/commit-commands:commit',
      source: 'plugin',
      owner: 'commit-commands@official',
      targetId: 'commit-commands@official',
      target: 'plugin',
      isEnabled: true,
    });
  });

  /** Выключен плагин — команды нет в палитре; список обязан это показать. */
  it('команды выключенного плагина помечаются выключенными', () => {
    const installPath = join(root, 'plugins', 'cache', 'semgrep');
    mkdirSync(join(installPath, 'commands'), { recursive: true });
    writeFileSync(join(installPath, 'commands', 'scan.md'), '---\ndescription: Скан\n---\n');
    put(
      'plugins/installed_plugins.json',
      JSON.stringify({ version: 2, plugins: { 'semgrep@market': [{ installPath }] } }),
    );
    put('settings.json', JSON.stringify({ enabledPlugins: { 'semgrep@market': false } }));

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({ invocation: '/semgrep:scan', isEnabled: false });
  });

  /**
   * Нет записи в enabledPlugins — `claude plugin list` отвечает `enabled: false`,
   * и раздел «Плагины» показывает ровно это. Страница команд не должна спорить.
   */
  it('плагин без записи в enabledPlugins считается выключенным, как в CLI', () => {
    const installPath = join(root, 'plugins', 'cache', 'dormant');
    mkdirSync(join(installPath, 'commands'), { recursive: true });
    writeFileSync(join(installPath, 'commands', 'sleep.md'), '---\ndescription: Сон\n---\n');
    put(
      'plugins/installed_plugins.json',
      JSON.stringify({ version: 2, plugins: { 'dormant@market': [{ installPath }] } }),
    );
    put('settings.json', JSON.stringify({ enabledPlugins: {} }));

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({ invocation: '/dormant:sleep', isEnabled: false });
  });

  /**
   * CLI 2.1.177 читает реестр только версии 2: без номера, с 1 или 3 он отдаёт
   * пустой список. Показать команды из такого реестра = показать то, чего в
   * палитре нет; вместо этого — пометка с причиной.
   */
  it('реестр другой версии CLI не читает — команд нет, причина названа', () => {
    const installPath = join(root, 'plugins', 'cache', 'old');
    mkdirSync(join(installPath, 'commands'), { recursive: true });
    writeFileSync(join(installPath, 'commands', 'go.md'), '---\ndescription: Старое\n---\n');
    put('settings.json', JSON.stringify({ enabledPlugins: { 'old@market': true } }));

    for (const version of [undefined, 1, 3]) {
      put(
        'plugins/installed_plugins.json',
        JSON.stringify({ version, plugins: { 'old@market': [{ installPath }] } }),
      );

      const { commands, notes } = readClaudeCommands(paths, store);

      expect(commands).toEqual([]);
      expect(notes).toEqual([expect.stringContaining('читает только версию 2')]);
    }
  });

  it('скилл плагина — тоже команда с префиксом плагина', () => {
    const installPath = join(root, 'plugins', 'cache', 'frontend-design');
    mkdirSync(join(installPath, 'skills', 'palette'), { recursive: true });
    writeFileSync(
      join(installPath, 'skills', 'palette', 'SKILL.md'),
      '---\nname: palette\ndescription: Палитра\n---\n',
    );
    put(
      'plugins/installed_plugins.json',
      JSON.stringify({ version: 2, plugins: { 'frontend-design@official': [{ installPath }] } }),
    );

    const { commands } = readClaudeCommands(paths, store);

    expect(commands[0]).toMatchObject({ invocation: '/frontend-design:palette', source: 'plugin' });
  });

  it('битый реестр плагинов не роняет список, а просто ничего не добавляет', () => {
    put('plugins/installed_plugins.json', '{ это не json');
    put('skills/a11y-audit/SKILL.md', '---\nname: a11y-audit\ndescription: Доступность\n---\n');

    const { commands } = readClaudeCommands(paths, store);

    expect(commands.map((command) => command.invocation)).toEqual(['/a11y-audit']);
  });

  it('пустой каталог — пустой список, а не выдуманные команды', () => {
    expect(readClaudeCommands(paths, store).commands).toEqual([]);
  });
});

describe('команды других CLI', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-provider-commands-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const provider = (overrides: Partial<ConfigProvider>): ConfigProvider =>
    ({ id: 'test', name: 'Test CLI', ...overrides }) as ConfigProvider;

  it('gemini: описание берётся из toml, подкаталог даёт /git:fix', () => {
    mkdirSync(join(dir, 'commands', 'git'), { recursive: true });
    writeFileSync(
      join(dir, 'commands', 'git', 'fix.toml'),
      'description = "Починить по описанию"\nprompt = "..."\n',
    );

    const { commands } = readProviderCommands(
      provider({
        commandsConfig: {
          format: 'toml-prompt',
          dir: () => join(dir, 'commands'),
          namespaceSeparator: ':',
        },
      }),
    );

    expect(commands[0]).toMatchObject({
      invocation: '/git:fix',
      description: 'Починить по описанию',
      owner: 'Test CLI',
    });
  });

  /** `description` в формате необязателен — тогда о команде говорит её промпт. */
  it('gemini: без description показываем начало промпта, а не пустую строку', () => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'grep.toml'), 'prompt = "Найти совпадения в коде"\n');

    const { commands } = readProviderCommands(
      provider({
        commandsConfig: { format: 'toml-prompt', dir: () => join(dir, 'commands') },
      }),
    );

    expect(commands[0]?.description).toBe('Найти совпадения в коде');
  });

  it('opencode: читаются и файлы каталога, и команды из конфига', () => {
    mkdirSync(join(dir, 'commands'), { recursive: true });
    writeFileSync(join(dir, 'commands', 'test.md'), '---\ndescription: Прогнать тесты\n---\n');
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({ command: { deploy: { description: 'Выкатить', template: '…' } } }),
    );

    const { commands } = readProviderCommands(
      provider({
        commandsConfig: {
          format: 'md-frontmatter',
          dir: () => join(dir, 'commands'),
          configPath: () => join(dir, 'opencode.json'),
        },
      }),
    );

    expect(commands.map((command) => command.invocation)).toEqual(['/deploy', '/test']);
    expect(commands[0]?.description).toBe('Выкатить');
  });

  it('нет каталога — список пуст, но причина названа', () => {
    const { commands, notes } = readProviderCommands(
      provider({ commandsConfig: { format: 'md-frontmatter', dir: () => join(dir, 'нет') } }),
    );

    expect(commands).toEqual([]);
    expect(notes[0]).toContain('Каталог команд не найден');
  });

  /** Возможность не заявлена — раздел ничего не читает (fail-closed). */
  it('провайдер без объявленного формата команд не читает ничего', () => {
    expect(readProviderCommands(provider({}))).toEqual({ commands: [], notes: [] });
  });
});
