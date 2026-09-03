import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeProvider } from './claude.ts';
import { CAPABILITIES, type CapabilityMap } from './types.ts';
import {
  DEFAULT_PROVIDER_ID,
  describeProviders,
  getActiveProvider,
  getActiveProviderId,
  getProvider,
  isKnownProviderId,
  listProviders,
  type SettingsSource,
} from './registry.ts';
import { activeCliCommand, defaultCliCommand, providerCliCommand } from './cli.ts';

/** Фейковое хранилище настроек: отдаёт заданный id провайдера. */
function fakeStore(provider: string): SettingsSource {
  return { getSettings: () => ({ provider }) };
}

/** Ожидаемая команда CLI под текущую ОС — тот же критерий, что и в провайдере. */
const expectedClaudeCommand = process.platform === 'win32' ? 'claude.cmd' : 'claude';

/** Провайдеры, которые обязаны быть в реестре на этой фазе. */
const EXPECTED_IDS = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'continue',
  'goose',
  'kimi',
  'cursor',
  'opencode',
  'aider',
];

/** Все ли ключи карты имеют один статус. */
function allStatus(map: CapabilityMap, status: string): boolean {
  return CAPABILITIES.every((capability) => map[capability] === status);
}

describe('реестр провайдеров', () => {
  it('содержит 10 провайдеров, claude первым', () => {
    const ids = listProviders().map((provider) => provider.id);
    expect(ids).toEqual(EXPECTED_IDS);
    expect(ids[0]).toBe('claude');
  });

  it('claude: статус verified и ВСЕ возможности ready', () => {
    const claude = getProvider('claude');
    expect(claude.name).toBe('Claude Code');
    expect(claude.status).toBe('verified');
    expect(allStatus(claude.capabilities, 'ready')).toBe(true);
  });

  it('все прочие провайдеры — experimental', () => {
    for (const id of EXPECTED_IDS.filter((value) => value !== 'claude')) {
      expect(getProvider(id).status).toBe('experimental');
    }
  });

  // COMMON-1: скрипты — файлы самой панели (произвольный код пользователя в её
  // каталоге hooks/), а не адаптер к чужому конфигу. Ни одного обращения к CLI
  // или формату провайдера в разделе нет, поэтому он обязан быть ready у всех:
  // заглушка «в разработке» тут была упущением, а не осознанным fail-closed.
  it('scripts = ready у ВСЕХ провайдеров (раздел панели, от CLI не зависит)', () => {
    for (const id of EXPECTED_IDS) {
      expect(getProvider(id).capabilities.scripts, id).toBe('ready');
    }
  });

  it('codex/gemini: одинаковый набор ready-разделов (GEMINI-2/3 закрыли env и права)', () => {
    for (const id of ['codex', 'gemini'] as const) {
      const { capabilities } = getProvider(id);
      expect(capabilities.globalInstructions).toBe('ready');
      expect(capabilities.mcp).toBe('ready');
      // Ф6b: мультимодельный ассистент — чат ready (one-shot CLI + API).
      expect(capabilities.chat).toBe('ready');
    }
    // Codex: env (shell_environment_policy.set) и права (approval_policy/sandbox_mode) реализованы → ready.
    expect(
      CAPABILITIES.filter((cap) => getProvider('codex').capabilities[cap] === 'ready').sort(),
    ).toEqual(['chat', 'env', 'globalInstructions', 'mcp', 'permissions', 'projects', 'scripts']);
    // Gemini: GEMINI-3 закрыл env (файл .env), GEMINI-2 — права
    // (general.defaultApprovalMode + coreTools/excludeTools в settings.json),
    // команды — каталог commands/**/*.toml (только чтение).
    expect(
      CAPABILITIES.filter((cap) => getProvider('gemini').capabilities[cap] === 'ready').sort(),
    ).toEqual([
      'chat',
      'commands',
      'env',
      'globalInstructions',
      'mcp',
      'permissions',
      'projects',
      'scripts',
    ]);
  });

  it('mcpConfig задан у codex/gemini/cursor/opencode; у claude и aider — нет', () => {
    expect(getProvider('codex').mcpConfig).toMatchObject({ format: 'toml' });
    expect(getProvider('codex').mcpConfig?.path()).toBe(join(homedir(), '.codex', 'config.toml'));
    expect(getProvider('gemini').mcpConfig).toMatchObject({ format: 'json' });
    expect(getProvider('gemini').mcpConfig?.path()).toBe(
      join(homedir(), '.gemini', 'settings.json'),
    );
    // Gemini не задаёт ключ адреса → по умолчанию httpUrl (прежнее поведение).
    expect(getProvider('gemini').mcpConfig?.jsonHttpUrlKey).toBeUndefined();
    // Ф8: Cursor — глобальный ~/.cursor/mcp.json той же формы mcpServers, адрес в url.
    expect(getProvider('cursor').mcpConfig).toMatchObject({
      format: 'json',
      jsonHttpUrlKey: 'url',
    });
    expect(getProvider('cursor').mcpConfig?.path()).toBe(join(homedir(), '.cursor', 'mcp.json'));
    // Ф8: OpenCode — ключ `mcp` в ~/.config/opencode/opencode.json, отдельный формат.
    expect(getProvider('opencode').mcpConfig).toMatchObject({ format: 'opencode-json' });
    expect(getProvider('opencode').mcpConfig?.path()).toBe(
      join(homedir(), '.config', 'opencode', 'opencode.json'),
    );
    // Claude обслуживается своими роутами (~/.claude.json), mcpConfig ему не нужен.
    expect(claudeProvider.mcpConfig).toBeUndefined();
    // Aider: глобального MCP-файла нет → fail-closed.
    expect(getProvider('aider').mcpConfig).toBeUndefined();
  });

  // COMMON-2 + AIDER-4: проектный уровень. Задан ТОЛЬКО там, где проектные пути
  // задокументированы; у claude свой богатый проектный раздел (свои роуты).
  it('projectConfig задан у codex/gemini/cursor/opencode/aider; у claude — нет', () => {
    expect(getProvider('codex').projectConfig).toEqual({
      instructions: 'AGENTS.md',
      mcp: { format: 'toml', relativePath: '.codex/config.toml' },
    });
    expect(getProvider('gemini').projectConfig).toEqual({
      instructions: 'GEMINI.md',
      mcp: { format: 'json', relativePath: '.gemini/settings.json' },
      // GEMINI-3 / GEMINI-2: проектные .env и settings.json задокументированы.
      env: { format: 'dotenv', relativePath: '.gemini/.env' },
      permissions: { format: 'gemini-json', relativePath: '.gemini/settings.json' },
    });
    expect(getProvider('opencode').projectConfig).toEqual({
      instructions: 'AGENTS.md',
      mcp: { format: 'opencode-json', relativePath: 'opencode.json' },
      // OPENCODE-1: права проекта — ключ `permission` того же opencode.json.
      permissions: { format: 'opencode-json', relativePath: 'opencode.json' },
      // OPENCODE-3: хуки проекта — ключ `experimental.hook` того же файла.
      hooks: { format: 'opencode-json', relativePath: 'opencode.json' },
      // OPENCODE-4: плагины проекта — каталог `.opencode/plugins` + ключ `plugin`.
      plugins: {
        format: 'opencode-plugins',
        relativeDir: '.opencode/plugins',
        relativePath: 'opencode.json',
      },
      // OPENCODE-5: скиллы проекта — каталог `.opencode/skills`.
      skills: { format: 'skill-md-dir', relativeDir: '.opencode/skills' },
    });
    // AIDER-4: конфиг ищется в домашнем каталоге, в КОРНЕ GIT-РЕПОЗИТОРИЯ и в
    // текущем каталоге → `<проект>/.aider.conf.yml` задокументирован. Инструкции
    // у Aider — список ссылок `read`, поэтому не `instructions`, а `instructionsList`.
    expect(getProvider('aider').projectConfig).toEqual({
      instructionsList: { format: 'aider-yaml', relativePath: '.aider.conf.yml' },
      env: { format: 'aider-yaml', relativePath: '.aider.conf.yml' },
    });
    expect(claudeProvider.projectConfig).toBeUndefined();
    // Все проектные пути — относительные и без выхода за пределы проекта.
    for (const id of [
      'codex',
      'gemini',
      'qwen',
      'continue',
      'goose',
      'kimi',
      'cursor',
      'opencode',
      'aider',
    ]) {
      const config = getProvider(id).projectConfig;
      expect(getProvider(id).capabilities.projects, id).toBe('ready');
      for (const relative of [
        config?.instructions,
        config?.instructionsList?.relativePath,
        config?.instructionsRules?.relativeDir,
        config?.mcp?.relativePath,
        config?.env?.relativePath,
        config?.permissions?.relativePath,
        config?.hooks?.relativePath,
        config?.plugins?.relativeDir,
        config?.plugins?.relativePath,
      ]) {
        if (relative === undefined) continue;
        expect(relative.startsWith('/'), id).toBe(false);
        expect(relative.includes('..'), id).toBe(false);
      }
    }
  });

  // Qwen Code — форк Gemini CLI. Тест фиксирует ровно то, что подтверждено
  // документацией: совпадающую структуру каталога и РАЗОШЕДШИЙСЯ формат прав.
  it('qwen: пути и возможности форка Gemini, права — свой формат qwen-json', () => {
    const provider = getProvider('qwen');
    expect(provider.name).toBe('Qwen Code');
    expect(provider.status).toBe('experimental');
    expect(provider.cli.command).toBe('qwen');

    const home = join(homedir(), '.qwen');
    expect(provider.instructionsFile?.()).toBe(join(home, 'QWEN.md'));
    expect(provider.mcpConfig).toMatchObject({ format: 'json' });
    expect(provider.mcpConfig?.path()).toBe(join(home, 'settings.json'));
    // Адрес удалённого сервера — как у Gemini, ключ по умолчанию (httpUrl).
    expect(provider.mcpConfig?.jsonHttpUrlKey).toBeUndefined();
    expect(provider.envConfig).toMatchObject({ format: 'dotenv' });
    expect(provider.envConfig?.path()).toBe(join(home, '.env'));
    // Права НЕ gemini-json: у форка другие ключи (tools.approvalMode + permissions.*).
    expect(provider.permissionsConfig).toMatchObject({ format: 'qwen-json' });
    expect(provider.permissionsConfig?.path()).toBe(join(home, 'settings.json'));

    // Хуки (QWEN-1) — ключ `hooks` В ТОМ ЖЕ settings.json, что права и MCP.
    expect(provider.hooksConfig).toMatchObject({ format: 'qwen-json' });
    expect(provider.hooksConfig?.path()).toBe(join(home, 'settings.json'));
    // Ключ живой: снятия с записи, как у OpenCode, здесь нет.
    expect(provider.hooksConfig?.writeDisabledReason).toBeUndefined();
    // Скиллы (QWEN-2) — каталог папок со SKILL.md.
    expect(provider.skillsConfig).toMatchObject({ format: 'skill-md-dir' });
    expect(provider.skillsConfig?.dir()).toBe(join(home, 'skills'));
    // Плагинов у Qwen документация не описывает → раздела нет.
    expect(provider.pluginsConfig).toBeUndefined();

    expect(provider.projectConfig).toEqual({
      instructions: 'QWEN.md',
      mcp: { format: 'json', relativePath: '.qwen/settings.json' },
      env: { format: 'dotenv', relativePath: '.qwen/.env' },
      permissions: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
      hooks: { format: 'qwen-json', relativePath: '.qwen/settings.json' },
      skills: { format: 'skill-md-dir', relativeDir: '.qwen/skills' },
    });
    expect(provider.configLocations?.()).toEqual([home]);

    expect(CAPABILITIES.filter((cap) => provider.capabilities[cap] === 'ready').sort()).toEqual([
      'chat',
      // Команды — тот же формат, что у gemini: ~/.qwen/commands/**/*.toml.
      'commands',
      'env',
      'globalInstructions',
      'hooks',
      'mcp',
      'permissions',
      'projects',
      'scripts',
      'skills',
    ]);
  });

  // Continue — единственный, у кого MCP и права лежат в РАЗНЫХ файлах одного
  // каталога, а глобальных инструкций нет вовсе. Тест фиксирует и это отличие,
  // и форматы, которых больше ни у кого нет (`continue-yaml`, `continue-md`).
  it('continue: MCP и права в разных файлах, глобальных инструкций нет', () => {
    const provider = getProvider('continue');
    expect(provider.name).toBe('Continue');
    expect(provider.status).toBe('experimental');
    expect(provider.cli.command).toBe('cn');

    const home = join(homedir(), '.continue');
    // Глобальных инструкций нет ни в одной из трёх моделей — fail-closed.
    expect(provider.instructionsFile).toBeUndefined();
    expect(provider.instructionsList).toBeUndefined();
    expect(provider.instructionsRules).toBeUndefined();
    expect(provider.capabilities.globalInstructions).toBe('unsupported');

    expect(provider.mcpConfig).toMatchObject({ format: 'continue-yaml' });
    expect(provider.mcpConfig?.path()).toBe(join(home, 'config.yaml'));
    // Continue грузит ещё и отдельные файлы-блоки: раздел показывает их вместе
    // с `config.yaml`, иначе сервер из блока выглядит отсутствующим.
    expect(provider.mcpConfig?.blockDir?.()).toBe(join(home, 'mcpServers'));
    // Права — ОТДЕЛЬНЫЙ файл, а не секция config.yaml.
    expect(provider.permissionsConfig).toMatchObject({ format: 'continue-yaml' });
    expect(provider.permissionsConfig?.path()).toBe(join(home, 'permissions.yaml'));
    expect(provider.envConfig?.path()).toBe(join(home, '.env'));

    expect(provider.projectConfig).toEqual({
      // Правила проекта — каталог `.md`-файлов (у Cursor тот же раздел, но `.mdc`).
      instructionsRules: { format: 'continue-md', relativeDir: '.continue/rules' },
      mcp: {
        format: 'json',
        relativePath: '.continue/mcpServers/mcp.json',
        relativeBlockDir: '.continue/mcpServers',
      },
      env: { format: 'dotenv', relativePath: '.continue/.env' },
    });
    expect(provider.configLocations?.()).toEqual([home]);

    expect(CAPABILITIES.filter((cap) => provider.capabilities[cap] === 'ready').sort()).toEqual([
      'chat',
      'env',
      'mcp',
      'permissions',
      'projects',
      'scripts',
    ]);
  });

  // Goose — единственный, у кого ОДИН файл держит и MCP, и права, а путь под
  // Windows отличается не только разделителями (`%APPDATA%\Block\goose\config`).
  // Переменных окружения панель ему не ведёт: секреты Goose держит в связке
  // ключей ОС и `secrets.yaml`, вести их панелью нельзя.
  it('goose: один config.yaml на MCP и права, env — unsupported', () => {
    const provider = getProvider('goose');
    expect(provider.name).toBe('Goose');
    expect(provider.status).toBe('experimental');
    expect(provider.cli.command).toBe('goose');

    // Путь считается по ОС: тест проверяет ту ветку, на которой идёт прогон.
    const home =
      process.platform === 'win32'
        ? join(
            process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
            'Block',
            'goose',
            'config',
          )
        : join(homedir(), '.config', 'goose');

    expect(provider.instructionsFile?.()).toBe(join(home, '.goosehints'));
    expect(provider.instructionsList).toBeUndefined();
    expect(provider.instructionsRules).toBeUndefined();

    // ОДИН файл в двух разделах — у остальных провайдеров так не бывает.
    expect(provider.mcpConfig).toMatchObject({ format: 'goose-yaml' });
    expect(provider.permissionsConfig).toMatchObject({ format: 'goose-yaml' });
    expect(provider.mcpConfig?.path()).toBe(join(home, 'config.yaml'));
    expect(provider.permissionsConfig?.path()).toBe(provider.mcpConfig?.path());
    // Пофайловые разрешения — соседний файл и ТОЛЬКО ПОКАЗ: его формата в
    // документации Goose нет, поэтому панель его читает, но не пишет.
    expect(provider.permissionsConfig?.readOnlyToolPermissionsPath?.()).toBe(
      join(home, 'permission.yaml'),
    );

    // Своего .env у Goose нет — раздел закрыт, а не «пустой».
    expect(provider.envConfig).toBeUndefined();
    expect(provider.capabilities.env).toBe('unsupported');

    // В проекте — только подсказки: своего проектного config.yaml Goose не читает.
    expect(provider.projectConfig).toEqual({ instructions: '.goosehints' });
    expect(provider.configLocations?.()).toEqual([home]);

    expect(CAPABILITIES.filter((cap) => provider.capabilities[cap] === 'ready').sort()).toEqual([
      'chat',
      'globalInstructions',
      'mcp',
      'permissions',
      'projects',
      'scripts',
    ]);
  });

  // Kimi Code — единственный, кто держит MCP и права в РАЗНЫХ файлах одного
  // каталога `$KIMI_CODE_HOME` (mcp.json и config.toml), и вторая после Codex
  // TOML-модель прав. Проектного config.toml у него нет: CLI читает ровно один
  // пользовательский файл, изоляция под проект — подменой KIMI_CODE_HOME.
  it('kimi: mcp.json и config.toml в одном каталоге, env — unsupported', () => {
    const provider = getProvider('kimi');
    expect(provider.name).toBe('Kimi Code');
    expect(provider.status).toBe('experimental');
    expect(provider.cli.command).toBe('kimi');

    const home = join(homedir(), '.kimi-code');
    expect(provider.instructionsFile?.()).toBe(join(home, 'AGENTS.md'));
    expect(provider.instructionsList).toBeUndefined();
    expect(provider.instructionsRules).toBeUndefined();

    expect(provider.mcpConfig).toMatchObject({ format: 'json', jsonHttpUrlKey: 'url' });
    expect(provider.mcpConfig?.path()).toBe(join(home, 'mcp.json'));
    expect(provider.permissionsConfig).toMatchObject({ format: 'kimi-toml' });
    expect(provider.permissionsConfig?.path()).toBe(join(home, 'config.toml'));

    // Своего файла переменных у Kimi нет: ключи провайдеров лежат в config.toml,
    // а секреты панель в чужие конфиги не пишет → раздел закрыт.
    expect(provider.envConfig).toBeUndefined();
    expect(provider.capabilities.env).toBe('unsupported');

    // Хуки (KIMI-1) — `[[hooks]]` в том же config.toml, что и права.
    expect(provider.hooksConfig).toMatchObject({ format: 'kimi-toml' });
    expect(provider.hooksConfig?.path()).toBe(join(home, 'config.toml'));
    // Скиллы (KIMI-2): свой каталог + чужой `~/.agents/skills` только на показ,
    // описание ограничено 240 знаками — так сказано в документации Kimi.
    expect(provider.skillsConfig).toMatchObject({ format: 'skill-md-dir', descriptionMax: 240 });
    expect(provider.skillsConfig?.dir()).toBe(join(home, 'skills'));
    expect(provider.skillsConfig?.alsoLoadedFrom?.()).toEqual([
      join(homedir(), '.agents', 'skills'),
    ]);
    // Плагины (KIMI-3) — только показ: каталог установленного + реестр, в
    // который панель не пишет. Конфига со списком у этого формата нет вовсе.
    expect(provider.pluginsConfig).toMatchObject({ format: 'kimi-plugins' });
    expect(provider.pluginsConfig?.dir()).toBe(join(home, 'plugins', 'managed'));
    expect(provider.pluginsConfig?.registryPath?.()).toBe(join(home, 'plugins', 'installed.json'));
    expect(provider.pluginsConfig?.configPath).toBeUndefined();

    // В проекте — инструкции, MCP и скиллы; проектных прав и хуков нет (нет
    // проектного config.toml).
    expect(provider.projectConfig).toEqual({
      instructions: 'AGENTS.md',
      mcp: { format: 'json', relativePath: '.kimi-code/mcp.json', jsonHttpUrlKey: 'url' },
      skills: { format: 'skill-md-dir', relativeDir: '.kimi-code/skills' },
    });
    expect(provider.configLocations?.()).toEqual([home]);

    expect(CAPABILITIES.filter((cap) => provider.capabilities[cap] === 'ready').sort()).toEqual([
      'chat',
      'globalInstructions',
      'hooks',
      'mcp',
      'permissions',
      'plugins',
      'projects',
      'scripts',
      'skills',
    ]);
  });

  it('assistant-метаданные заданы у всех провайдеров по карте Ф6a', () => {
    const claude = getProvider('claude').assistant;
    expect(claude).toMatchObject({
      apiKind: 'anthropic',
      apiKeyEnvVars: ['ANTHROPIC_API_KEY'],
      cliRunnable: true,
    });
    // Claude делегирует своему пути — generic one-shot-флаг у него НЕ задаётся.
    expect(claude?.oneShotArgs).toBeUndefined();
    expect(getProvider('codex').assistant).toMatchObject({
      apiKind: 'openai',
      apiKeyEnvVars: ['OPENAI_API_KEY'],
      cliRunnable: true,
    });
    expect(getProvider('gemini').assistant).toMatchObject({
      apiKind: 'google',
      apiKeyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
      cliRunnable: true,
    });
    // One-shot-флаг задан у codex/gemini и (OPENCODE-7) у opencode — все
    // задокументированы. Промпт всегда ОТДЕЛЬНЫМ элементом argv.
    expect(getProvider('codex').assistant?.oneShotArgs?.('P')).toEqual(['exec', 'P']);
    expect(getProvider('gemini').assistant?.oneShotArgs?.('P')).toEqual(['-p', 'P']);
    // Qwen Code: OpenAI-совместимое API (OPENAI_API_KEY / DASHSCOPE_API_KEY),
    // one-shot `qwen -p <промпт>` — задокументированный headless-режим.
    expect(getProvider('qwen').assistant).toMatchObject({
      apiKind: 'openai-compat',
      apiKeyEnvVars: ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY'],
      cliRunnable: true,
    });
    expect(getProvider('qwen').assistant?.oneShotArgs?.('P')).toEqual(['-p', 'P']);
    // Kimi Code: OpenAI-совместимое API Moonshot, one-shot `kimi -p <промпт>`.
    expect(getProvider('kimi').assistant).toMatchObject({
      apiKind: 'openai-compat',
      apiKeyEnvVars: ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
      cliRunnable: true,
    });
    expect(getProvider('kimi').assistant?.oneShotArgs?.('P')).toEqual(['-p', 'P']);
    expect(getProvider('opencode').assistant).toMatchObject({
      apiKind: 'openai-compat',
      apiKeyEnvVars: [],
      cliRunnable: true,
    });
    // OPENCODE-7: `opencode run "<промпт>"` — подкоманда `run`, промпт позиционный.
    expect(getProvider('opencode').assistant?.oneShotArgs?.('P')).toEqual(['run', 'P']);
    expect(getProvider('aider').assistant).toMatchObject({
      apiKind: 'openai-compat',
      apiKeyEnvVars: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
      cliRunnable: true,
    });
    // AIDER-2: задокументированный one-shot `--message <text>` — промпт ОТДЕЛЬНЫМ
    // элементом argv, без интерполяции в shell.
    expect(getProvider('aider').assistant?.oneShotArgs?.('привет "мир" && rm -rf /')).toEqual([
      '--message',
      'привет "мир" && rm -rf /',
    ]);
    // Cursor: нет модельного API и запуск через CLI не поддержан → ассистент unsupported.
    expect(getProvider('cursor').assistant).toEqual({
      apiKind: 'none',
      apiKeyEnvVars: [],
      cliRunnable: false,
    });
  });

  it('CURSOR-1/2 cursor: MCP + правила КАТАЛОГОМ .mdc + права allow/deny', () => {
    const provider = getProvider('cursor');
    const { capabilities } = provider;
    expect(capabilities.mcp).toBe('ready');
    expect(capabilities.globalInstructions).toBe('ready');
    // CURSOR-2: права — ключ `permissions` в cli-config.json.
    expect(capabilities.permissions).toBe('ready');
    // COMMON-1: скрипты — раздел самой панели, ready у всех провайдеров.
    // COMMON-2 + CURSOR-1 + CURSOR-2: проектный уровень Cursor — `.cursor/mcp.json`
    // (тот же json-адаптер), каталог правил `.cursor/rules` (тот же адаптер `.mdc`)
    // и права `.cursor/cli.json` (тот же адаптер `cursor-json`).
    expect(CAPABILITIES.filter((cap) => capabilities[cap] === 'ready').sort()).toEqual([
      'globalInstructions',
      'mcp',
      'permissions',
      'projects',
      'scripts',
    ]);
    // Единого файла инструкций у Cursor нет — и списка ссылок тоже: модель одна
    // из трёх, и у него это КАТАЛОГ.
    expect(provider.instructionsFile).toBeUndefined();
    expect(provider.instructionsList).toBeUndefined();
    expect(provider.instructionsRules).toMatchObject({ format: 'cursor-mdc' });
    expect(provider.instructionsRules?.dir()).toBe(join(homedir(), '.cursor', 'rules'));

    expect(provider.projectConfig?.instructions).toBeUndefined();
    expect(provider.projectConfig?.instructionsRules).toEqual({
      format: 'cursor-mdc',
      relativeDir: '.cursor/rules',
    });
    expect(provider.projectConfig?.mcp).toEqual({
      format: 'json',
      relativePath: '.cursor/mcp.json',
      jsonHttpUrlKey: 'url',
    });
    // Имя проектного файла прав ДРУГОЕ: `cli.json`, не `cli-config.json`.
    expect(provider.projectConfig?.permissions).toEqual({
      format: 'cursor-json',
      relativePath: '.cursor/cli.json',
    });
  });

  it('OPENCODE-1/2 opencode: MCP + инструкции + ПРАВА; переменных окружения нет', () => {
    const { capabilities } = getProvider('opencode');
    expect(capabilities.mcp).toBe('ready');
    expect(capabilities.globalInstructions).toBe('ready');
    // OPENCODE-1: ключ `permission` в opencode.json.
    expect(capabilities.permissions).toBe('ready');
    // OPENCODE-2: хранить переменные окружения OpenCode негде — он только
    // подставляет `{env:ПЕРЕМЕННАЯ}` из уже заданного окружения процесса.
    // Значит раздел неприменим (скрыт), а не «в разработке».
    expect(capabilities.env).toBe('unsupported');
    expect(getProvider('opencode').envConfig).toBeUndefined();
    expect(CAPABILITIES.filter((cap) => capabilities[cap] === 'ready').sort()).toEqual([
      // OPENCODE-7: one-shot `opencode run "<промпт>"` — basic-чат стал рабочим.
      'chat',
      // Команды: файлы commands/*.md с шапкой + ключ `command` в opencode.json.
      'commands',
      'globalInstructions',
      // OPENCODE-3: `experimental.hook` в opencode.json (глобальном и проектном).
      'hooks',
      'mcp',
      'permissions',
      // OPENCODE-4: каталог файлов-плагинов + массив npm-пакетов `plugin`.
      'plugins',
      'projects',
      'scripts',
      // OPENCODE-5: каталог скиллов `skills/` (глобальный и проектный).
      'skills',
    ]);
  });

  it('aider: ready — env, инструкции-список, проекты и чат; MCP по-прежнему нет', () => {
    const provider = getProvider('aider');
    const { capabilities } = provider;
    // Подтверждённые документацией объекты Aider в `.aider.conf.yml`.
    expect(capabilities.env).toBe('ready');
    // AIDER-1: инструкции есть, но модель ДРУГАЯ — список ссылок `read`, а не файл.
    expect(capabilities.globalInstructions).toBe('ready');
    expect(provider.instructionsFile).toBeUndefined();
    expect(provider.instructionsList).toEqual({
      format: 'aider-yaml',
      path: expect.any(Function),
    });
    // Плюс `scripts` — раздел самой панели (COMMON-1), к формату Aider отношения не имеет.
    expect(CAPABILITIES.filter((cap) => capabilities[cap] === 'ready').sort()).toEqual([
      'chat',
      'env',
      'globalInstructions',
      'projects',
      'scripts',
    ]);
    // MCP у Aider нет вовсе — в справочнике опций такой настройки не существует.
    expect(capabilities.mcp).toBe('unsupported');
    expect(provider.mcpConfig).toBeUndefined();
    expect(provider.permissionsConfig).toBeUndefined();
  });

  it('codex: заявленные ready/planned/unsupported разложены по карте верно', () => {
    const { capabilities } = getProvider('codex');
    const ready = [
      'globalInstructions',
      'mcp',
      'env',
      'permissions',
      'chat',
      'scripts',
      // COMMON-2: проектный AGENTS.md + <проект>/.codex/config.toml.
      'projects',
    ] as const;
    const unsupported = ['skills', 'hooks', 'plugins', 'analytics', 'sandbox', 'rules'] as const;
    for (const cap of ready) expect(capabilities[cap]).toBe('ready');
    for (const cap of unsupported) expect(capabilities[cap]).toBe('unsupported');
  });

  it('envConfig задан у codex (toml), aider (yaml) и gemini (dotenv)', () => {
    expect(getProvider('codex').envConfig).toEqual({
      format: 'toml',
      path: expect.any(Function),
    });
    expect(getProvider('codex').envConfig?.path()).toBe(join(homedir(), '.codex', 'config.toml'));
    // Aider: задокументированный ключ set-env в глобальном ~/.aider.conf.yml.
    expect(getProvider('aider').envConfig).toEqual({
      format: 'aider-yaml',
      path: expect.any(Function),
    });
    expect(getProvider('aider').envConfig?.path()).toBe(join(homedir(), '.aider.conf.yml'));
    // Gemini (GEMINI-3): задокументированный файл ~/.gemini/.env.
    expect(getProvider('gemini').envConfig).toEqual({
      format: 'dotenv',
      path: expect.any(Function),
    });
    expect(getProvider('gemini').envConfig?.path()).toBe(join(homedir(), '.gemini', '.env'));
    expect(getProvider('gemini').capabilities.env).toBe('ready');
    // Прочие — тоже без envConfig (fail-closed; у opencode это OPENCODE-2).
    for (const id of ['cursor', 'opencode'] as const) {
      expect(getProvider(id).envConfig).toBeUndefined();
    }
  });

  it('permissionsConfig задан у codex (toml) и gemini (gemini-json); у claude и прочих — нет', () => {
    expect(getProvider('codex').permissionsConfig).toEqual({
      format: 'toml',
      path: expect.any(Function),
    });
    expect(getProvider('codex').permissionsConfig?.path()).toBe(
      join(homedir(), '.codex', 'config.toml'),
    );
    // Claude обслуживается своими роутами (settings.json), permissionsConfig ему не нужен.
    expect(claudeProvider.permissionsConfig).toBeUndefined();
    // Gemini (GEMINI-2): general.defaultApprovalMode + coreTools/excludeTools.
    expect(getProvider('gemini').permissionsConfig).toEqual({
      format: 'gemini-json',
      path: expect.any(Function),
    });
    expect(getProvider('gemini').permissionsConfig?.path()).toBe(
      join(homedir(), '.gemini', 'settings.json'),
    );
    expect(getProvider('gemini').capabilities.permissions).toBe('ready');
    // OpenCode (OPENCODE-1): ключ `permission` в opencode.json — третья модель.
    expect(getProvider('opencode').permissionsConfig).toEqual({
      format: 'opencode-json',
      path: expect.any(Function),
    });
    expect(getProvider('opencode').permissionsConfig?.path()).toBe(
      join(homedir(), '.config', 'opencode', 'opencode.json'),
    );
    expect(getProvider('opencode').capabilities.permissions).toBe('ready');
    // Cursor (CURSOR-2): ключ `permissions` в ~/.cursor/cli-config.json — восьмая
    // модель (два списка allow/deny, ни режима, ни `ask`).
    expect(getProvider('cursor').permissionsConfig).toEqual({
      format: 'cursor-json',
      path: expect.any(Function),
    });
    expect(getProvider('cursor').permissionsConfig?.path()).toBe(
      join(homedir(), '.cursor', 'cli-config.json'),
    );
    expect(getProvider('cursor').capabilities.permissions).toBe('ready');
    // У Aider задокументированного файла прав нет — fail-closed.
    expect(getProvider('aider').permissionsConfig).toBeUndefined();
  });

  it('instructionsFile задан у claude/codex/gemini/opencode и указывает на верный файл', () => {
    expect(claudeProvider.instructionsFile?.()).toBe(join(homedir(), '.claude', 'CLAUDE.md'));
    expect(getProvider('codex').instructionsFile?.()).toBe(join(homedir(), '.codex', 'AGENTS.md'));
    expect(getProvider('gemini').instructionsFile?.()).toBe(
      join(homedir(), '.gemini', 'GEMINI.md'),
    );
    // Ф8: OpenCode — обычный markdown ~/.config/opencode/AGENTS.md.
    expect(getProvider('opencode').instructionsFile?.()).toBe(
      join(homedir(), '.config', 'opencode', 'AGENTS.md'),
    );
    // У этих двоих инструкции устроены ИНАЧЕ (список ссылок у Aider, каталог
    // правил у Cursor) — единого файла у них не бывает по построению.
    for (const id of ['cursor', 'aider'] as const) {
      expect(getProvider(id).instructionsFile).toBeUndefined();
    }
  });

  it('имя файла инструкций уходит клиенту вместе с моделью — меню подписывает раздел им', () => {
    const names = Object.fromEntries(
      describeProviders(fakeStore('claude')).providers.map((info) => [
        info.id,
        info.instructionsFileName,
      ]),
    );
    expect(names.claude).toBe('CLAUDE.md');
    expect(names.codex).toBe('AGENTS.md');
    expect(names.gemini).toBe('GEMINI.md');
    expect(names.qwen).toBe('QWEN.md');
    expect(names.opencode).toBe('AGENTS.md');
    // Список ссылок и каталог правил — единого файла нет, подпись общая.
    expect(names.cursor).toBeUndefined();
    expect(names.aider).toBeUndefined();
  });

  it('модель инструкций отдаётся клиенту явно: file / list / rules', () => {
    const models = Object.fromEntries(
      describeProviders(fakeStore('claude')).providers.map((info) => [
        info.id,
        info.instructionsModel,
      ]),
    );
    expect(models).toEqual({
      claude: 'file',
      codex: 'file',
      gemini: 'file',
      // Qwen Code — контекстный файл QWEN.md, та же модель «один файл».
      qwen: 'file',
      // CURSOR-1: каталог `~/.cursor/rules/*.mdc` — третья модель.
      cursor: 'rules',
      opencode: 'file',
      // AIDER-1: список ссылок `read` в `.aider.conf.yml`.
      aider: 'list',
      // CONTINUE: глобальных инструкций нет вовсе — задокументирован только
      // проектный каталог правил `.continue/rules`, ключ `rules:` конфига
      // неоднороден (строки вперемешку со ссылками `uses:`) → fail-closed.
      continue: 'none',
      // GOOSE: `.goosehints` — обычный файл подсказок в каталоге конфигурации.
      goose: 'file',
      // KIMI: `<KIMI_CODE_HOME>/AGENTS.md` — тот же обычный markdown.
      kimi: 'file',
    });
  });

  it('OPENCODE-3/4/5 opencode: хуки, плагины и скиллы ready, analytics/sandbox — нет', () => {
    const provider = getProvider('opencode');
    const { capabilities } = provider;
    // OPENCODE-5: скиллы — каталог `skills/` со `SKILL.md`, своя модель.
    expect(capabilities.skills).toBe('ready');
    expect(provider.skillsConfig).toEqual({
      format: 'skill-md-dir',
      dir: expect.any(Function),
      alsoLoadedFrom: expect.any(Function),
    });
    expect(provider.skillsConfig?.dir()).toBe(join(homedir(), '.config', 'opencode', 'skills'));
    // ЧЕСТНАЯ ОГОВОРКА (surfaced in UI): те же скиллы OpenCode грузит из
    // ~/.claude/skills и ~/.agents/skills — панель их только показывает.
    expect(provider.skillsConfig?.alsoLoadedFrom?.()).toEqual([
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.agents', 'skills'),
    ]);
    // OPENCODE-3: ключ `experimental.hook` — своя модель, не claude-овская.
    // С 2026-07-25 раздел ТОЛЬКО ДЛЯ ЧТЕНИЯ: ключ исчез из справочника
    // конфигурации OpenCode и из опубликованной схемы, поэтому панель его больше
    // не пишет (но продолжает показывать уже записанное).
    expect(capabilities.hooks).toBe('ready');
    expect(provider.hooksConfig).toEqual({
      format: 'opencode-json',
      path: expect.any(Function),
      writeDisabledReason: expect.stringContaining('experimental.hook'),
    });
    // OPENCODE-4: каталог файлов JS/TS + массив `plugin` в том же конфиге.
    expect(capabilities.plugins).toBe('ready');
    expect(provider.pluginsConfig).toEqual({
      format: 'opencode-plugins',
      dir: expect.any(Function),
      configPath: expect.any(Function),
    });
    for (const cap of ['analytics', 'sandbox'] as const) {
      expect(capabilities[cap]).toBe('unsupported');
    }
  });

  it('hooks/plugins/skillsConfig есть ТОЛЬКО у opencode: Claude на своих роутах', () => {
    // У Claude все три модели свои и богатые (события settings.json / расширения
    // самой панели / каталог скиллов с группами) — универсальные разделы не
    // должны их даже видеть.
    expect(claudeProvider.hooksConfig).toBeUndefined();
    expect(claudeProvider.pluginsConfig).toBeUndefined();
    expect(claudeProvider.skillsConfig).toBeUndefined();
    for (const id of ['codex', 'gemini', 'cursor', 'aider']) {
      expect(getProvider(id).hooksConfig, id).toBeUndefined();
      expect(getProvider(id).pluginsConfig, id).toBeUndefined();
      expect(getProvider(id).skillsConfig, id).toBeUndefined();
      // Раздела нет → возможность обязана быть НЕ ready (fail-closed).
      expect(getProvider(id).capabilities.hooks, id).not.toBe('ready');
      expect(getProvider(id).capabilities.plugins, id).not.toBe('ready');
      expect(getProvider(id).capabilities.skills, id).not.toBe('ready');
    }
  });

  it('каждая карта покрывает ровно все ключи CAPABILITIES', () => {
    for (const provider of listProviders()) {
      expect(Object.keys(provider.capabilities).sort()).toEqual([...CAPABILITIES].sort());
    }
  });

  it('isKnownProviderId различает известные и по-настоящему неизвестные', () => {
    expect(isKnownProviderId('claude')).toBe(true);
    expect(isKnownProviderId('codex')).toBe(true);
    expect(isKnownProviderId('nonexistent')).toBe(false);
    expect(isKnownProviderId('')).toBe(false);
  });

  it('неизвестный id откатывается на claude', () => {
    expect(getProvider('nonexistent')).toBe(claudeProvider);
  });

  it('getActiveProviderId по умолчанию отдаёт claude', () => {
    expect(DEFAULT_PROVIDER_ID).toBe('claude');
    expect(getActiveProviderId(fakeStore('claude'))).toBe('claude');
  });

  it('известный не-claude provider остаётся активным', () => {
    expect(getActiveProviderId(fakeStore('codex'))).toBe('codex');
    expect(getActiveProvider(fakeStore('codex')).id).toBe('codex');
  });

  it('незнакомое значение настройки → фоллбек на claude', () => {
    expect(getActiveProviderId(fakeStore('nonexistent'))).toBe('claude');
    expect(getActiveProviderId(fakeStore(''))).toBe('claude');
    expect(getActiveProvider(fakeStore('nonexistent'))).toBe(claudeProvider);
  });

  it('describeProviders отдаёт активный id и карточки со статусами', () => {
    const payload = describeProviders(fakeStore('claude'));
    expect(payload.active).toBe('claude');
    expect(payload.providers.map((p) => p.id)).toEqual(EXPECTED_IDS);
    const claude = payload.providers[0];
    expect(claude).toMatchObject({ id: 'claude', name: 'Claude Code', status: 'verified' });
    expect(allStatus(claude!.capabilities, 'ready')).toBe(true);
  });
});

describe('имя CLI берётся из провайдера', () => {
  it('providerCliCommand отдаёт команду провайдера под текущую ОС', () => {
    expect(providerCliCommand(claudeProvider)).toBe(expectedClaudeCommand);
  });

  it('activeCliCommand берёт команду активного провайдера', () => {
    expect(activeCliCommand(fakeStore('claude'))).toBe(expectedClaudeCommand);
    // Мусорный id → фоллбек на claude.
    expect(activeCliCommand(fakeStore('nonexistent'))).toBe(expectedClaudeCommand);
    // Известный провайдер отдаёт свою команду.
    const expectedCodex = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    expect(activeCliCommand(fakeStore('codex'))).toBe(expectedCodex);
  });

  it('defaultCliCommand возвращает команду провайдера по умолчанию', () => {
    expect(defaultCliCommand()).toBe(expectedClaudeCommand);
  });
});
