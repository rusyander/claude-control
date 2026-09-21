import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { envItemKinds } from '@agentdeck/contracts/portable-env';
import type {
  EnvItem,
  EnvItemKind,
  EnvSkip,
  McpTransport,
} from '@agentdeck/contracts/portable-env';
import { detectClaudeLocation } from '../../../lib/claude-paths.ts';
import { readJsonFile, readTextFile } from '../../../lib/safe-io.ts';
import { readClaudeCommands } from '../../commands/claude.ts';
import { readEnvVars } from '../../env.ts';
import { readHooksFromFiles } from '../../hooks.ts';
import { readMcpServers } from '../../mcp.ts';
import { readPermissions } from '../../permissions.ts';
import { parseRules } from '../../rules.ts';
import { splitFrontmatter } from '../../skills/frontmatter.ts';
import { disabledSkillsDir } from '../../skills/paths.ts';
import { readSkills } from '../../skills/read.ts';
import { envSkip } from '../canon.ts';
import {
  DEFAULT_INSTRUCTION_FILES_MODE,
  readInstructionFilesChoice,
  resolveInstructionSources,
} from '../../../lib/instruction-files.ts';
import { expandInstructionText } from '../instruction-imports.ts';
import {
  commandItem,
  envVarOrSecret,
  instructionsItem,
  skillItem,
  subagentItem,
} from '../normalize-files.ts';
import { normalizeHooks, type HookInput } from '../normalize-hooks.ts';
import { normalizeMcpServers, type McpServerInput } from '../normalize-mcp.ts';
import { normalizeClaudePermissions } from '../normalize-permissions.ts';
import { sourceFactory } from '../normalize-types.ts';
import { readClaudePlugins } from '../plugins-claude.ts';
import { claudeProjectPaths, ProjectRootRequiredError, type ClaudeLevelPaths } from '../project.ts';
import { readSubagentsDir } from '../subagents.ts';
import type { ImportDeps, ImportResult } from '../types.ts';
import { importStore } from './store-view.ts';

/**
 * Claude Code → канон.
 *
 * Собственный CLI — единственный, у кого панель читает КАЖДЫЙ раздел своим
 * читателем, поэтому общих этапов `sections.ts` здесь нет: они собраны поверх
 * `readProvider*`, а у Claude источники другие (`domains/{rules,skills,hooks,
 * commands,mcp,env,permissions}.ts`).
 *
 * Четыре обязанности, которых нет ни у кого другого (§1.1 плана):
 *
 *  1. имя файла инструкций берётся по ключу `instructionFiles`, а не как
 *     константа `CLAUDE.md`;
 *  2. разделы `## ПРАВИЛО:` едут отдельными записями со своим состоянием
 *     вкл/выкл — и текст файла делится между преамбулой и правилами, а не
 *     дублируется: применить у цели и файл целиком, и его же правила значило бы
 *     записать инструкции дважды;
 *  3. скилл, синхронизированный с аккаунтом (`skills/synced/`), едет с
 *     происхождением `account`, а не как обычный файл;
 *  4. MCP-запись `"type": "sdk"` — не команда: читатель панели сводит незнакомый
 *     транспорт к `stdio`, поэтому сырой ключ `type` перечитывается из
 *     `.claude.json` отдельно.
 */
export function importClaudeEnvironment(deps: ImportDeps): ImportResult {
  const level = claudeLevel(deps);
  if ('why' in level) {
    // Каталога нет или он не читается — это НЕ пустая среда: каждый раздел
    // называется непрочитанным с одной и той же причиной, иначе паспорт покажет
    // человеку «ничего нет» вместо «прочитать не удалось».
    return {
      items: [],
      skipped: CLAUDE_KINDS.map((kind) => envSkip(kind, 'not_readable', level.why)),
    };
  }

  const { paths } = level;
  const store = importStore(deps.state);
  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const stage of [
    readInstructionsAndRules,
    readSubagents,
    readClaudeSkills,
    readCommands,
    readHooks,
    readClaudePermissions,
    readMcp,
    readEnv,
    readPlugins,
  ]) {
    const result = stage({ deps, paths, store });
    items.push(...result.items);
    skipped.push(...result.skipped);
  }

  // Вид, о котором не сказано НИЧЕГО — ни записи, ни пропуска, — со страницы
  // исчезает целиком: экран рисует только непустые разделы. Человек читает это
  // как «панель сюда не смотрела», хотя смотрела и не нашла. Поэтому каждый вид,
  // который у Claude есть, обязан отметиться — пустой так и назван пустым.
  const spoken = new Set([...items.map((item) => item.kind), ...skipped.map((skip) => skip.kind)]);
  for (const kind of CLAUDE_KINDS) {
    if (!spoken.has(kind))
      skipped.push(envSkip(kind, 'empty', `${whereLooked(kind, paths)}: записей нет`));
  }

  return { items, skipped };
}

/**
 * Где панель искала записи этого вида.
 *
 * Пустой раздел называет КАТАЛОГ, в который смотрели, и общий корень тут врёт
 * тем сильнее, чем дальше раздел от него: `CLAUDE.md` проекта лежит в корне
 * репозитория, а не в `.claude/`, и строка «<проект>/.claude: записей нет»
 * отправляла человека искать файл не туда. Пути берутся из той же раскладки,
 * которой читали разделы, — второго списка путей здесь не заводится.
 */
function whereLooked(kind: EnvItemKind, paths: ClaudeLevelPaths): string {
  switch (kind) {
    case 'instructions':
      return paths.instructionsRoot;
    case 'skill':
      return paths.skills;
    case 'command':
      return join(paths.root, 'commands');
    case 'subagent':
      return join(paths.root, 'agents');
    case 'plugin':
      return join(paths.root, 'plugins');
    case 'mcpServer':
      return paths.mcpConfig;
    case 'hook':
    case 'permission':
    case 'envVar':
      return paths.settings;
    case 'secret':
      // Файл секретов — понятие панели и её дома; у проекта его нет вовсе.
      return paths.secretsEnv ?? paths.settings;
    default:
      return paths.root;
  }
}

/**
 * Раскладка того уровня, о котором спросили: дом человека или каталог проекта.
 *
 * Проектный уровень НЕ ищется «обнаружением»: каталог проекта назван человеком в
 * реестре панели, и если его нет на диске — это непрочитанная среда с причиной,
 * а не повод уйти в дом. Уйти в дом значило бы отдать глобальный паспорт за
 * проектный (П2.5, критерий 3).
 */
function claudeLevel(deps: ImportDeps): { paths: ClaudeLevelPaths } | { why: string } {
  if (deps.scope !== 'project') {
    const location = detectClaudeLocation(deps.override);
    if (!location.isValid) {
      return { why: location.problem ?? `каталог ${location.paths.root} не прочитан` };
    }
    // У дома каталог конфигурации и есть корень поиска инструкций.
    return { paths: { ...location.paths, instructionsRoot: location.paths.root } };
  }

  if (!deps.projectRoot) throw new ProjectRootRequiredError();
  if (!existsSync(deps.projectRoot)) {
    return { why: `каталога проекта ${deps.projectRoot} нет на диске` };
  }
  return { paths: claudeProjectPaths(deps.projectRoot) };
}

/**
 * Виды записей самой панели, а не среды CLI: группы и разговоры человек заводит
 * в AgentDeck, на диске Claude их нет, и переносить в чужой CLI нечего. Только
 * они и вычитаются из словаря — всё остальное у Claude есть и обязано отметиться.
 */
const PANEL_ONLY_KINDS: readonly EnvItemKind[] = ['panelGroup', 'conversation'];

/**
 * Виды записей, которые у Claude есть: по ним же называется непрочитанный дом.
 *
 * Список ВЫЧИСЛЯЕТСЯ из словаря канона: выписанный руками, он потерял `secret` —
 * и о нечитаемом доме паспорт говорил «про секреты не сказано ничего» вместо
 * «не прочитано». Новый вид канона теперь попадает сюда сам, а не по памяти.
 */
const CLAUDE_KINDS: readonly EnvItemKind[] = envItemKinds.filter(
  (kind) => !PANEL_ONLY_KINDS.includes(kind),
);

/** Что нужно каждому этапу: раскладка уровня и нейтральный вид состояния панели. */
interface Stage {
  deps: ImportDeps;
  paths: ClaudeLevelPaths;
  store: ReturnType<typeof importStore>;
}

/**
 * Инструкции и правила. Источник выбирается по `instructionFiles`: при
 * `claude-md-and-agents-md` в канон едут ОБА файла разными записями, при
 * `managed-only` — ни одного, и сказано почему.
 */
function readInstructionsAndRules(stage: Stage): ImportResult {
  const { paths, deps, store } = stage;
  const choice = readInstructionFilesChoice(paths.settings);
  // Корень поиска инструкций, а не корень раскладки: у дома это сам `.claude`, а
  // у проекта — корень РЕПОЗИТОРИЯ (`<проект>/CLAUDE.md`, рядом с `.claude/`).
  const resolved = resolveInstructionSources(paths.instructionsRoot, choice);

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = resolved.skips.map((skip) =>
    envSkip('instructions', 'no_section', skip.detail),
  );
  if (choice.source === 'projectInstructions') {
    skipped.push(
      envSkip(
        'instructions',
        'unsupported_format',
        `ключ projectInstructions устарел: CLI читает его с предупреждением, актуальный ключ — instructionFiles (режим ${choice.mode}, умолчание ${DEFAULT_INSTRUCTION_FILES_MODE})`,
      ),
    );
  }

  for (const file of resolved.sources) {
    const raw = readTextFile(file.filePath);
    const source = sourceFactory(deps.provider.id, deps.scope, file.filePath);
    const parsed = parseRules(raw, deps.scope, store);

    if (parsed.rules.length === 0) {
      items.push(
        instructionsItem({
          source,
          filePath: file.filePath,
          fileName: file.fileName,
          legacy: file.legacy,
          raw,
          skips: skipped,
        }),
      );
      continue;
    }

    // Файл с правилами делится на непересекающиеся части: преамбула плюс
    // разделы. Так у каждого правила своё состояние вкл/выкл, и ни один кусок
    // текста не едет дважды.
    if (parsed.preamble.trim()) {
      items.push(
        instructionsItem({
          source,
          filePath: file.filePath,
          fileName: file.fileName,
          legacy: file.legacy,
          raw: parsed.preamble,
          content: expandInstructionText(parsed.preamble, file.filePath),
          skips: skipped,
        }),
      );
    }

    for (const rule of parsed.rules) {
      items.push(
        instructionsItem({
          source,
          filePath: file.filePath,
          // Имя файла у правила — файл плюс его собственный якорь: по нему идёт
          // upsert, и два правила одного файла обязаны быть разными записями.
          fileName: `${file.fileName}#${rule.id}`,
          legacy: file.legacy,
          raw: rule.body,
          content: expandInstructionText(rule.body, file.filePath),
          enabled: rule.isEnabled,
          skips: skipped,
        }),
      );
    }
  }

  return { items, skipped };
}

/** Субагенты `~/.claude/agents/*.md` — единственный по-настоящему новый парсер партии. */
function readSubagents(stage: Stage): ImportResult {
  const dir = join(stage.paths.root, 'agents');
  const scan = readSubagentsDir(dir);
  const source = sourceFactory(stage.deps.provider.id, stage.deps.scope, dir);

  return {
    items: scan.subagents.map((parsed) => subagentItem(source, parsed)),
    skipped: scan.problems.map((problem) =>
      envSkip('subagent', 'unsupported_format', `${problem.filePath}: ${problem.detail}`),
    ),
  };
}

/** Каталог, в который CLI кладёт скиллы, синхронизированные с аккаунтом. */
const SYNCED_SKILLS_DIR = 'synced';

/**
 * Скиллы: файловые из `skills/` и `skills-disabled/` плюс синхронизированные с
 * аккаунтом из `skills/synced/` — их читатель панели не видит (в самом каталоге
 * `SKILL.md` нет), а среда их содержит.
 */
function readClaudeSkills(stage: Stage): ImportResult {
  const { paths, deps, store } = stage;
  const source = sourceFactory(deps.provider.id, deps.scope, paths.skills);
  const disabledDir = disabledSkillsDir(paths.skills);

  const items: EnvItem[] = readSkills(paths.skills, store).map((skill) => {
    const dir = join(skill.isEnabled ? paths.skills : disabledDir, skill.id);
    return skillItem({
      source,
      name: skill.id,
      description: skill.description,
      body: skill.body,
      dir,
      enabled: skill.isEnabled,
      raw: readTextFile(join(dir, 'SKILL.md')),
    });
  });

  // Скиллы, синхронизированные с аккаунтом, CLI держит ТОЛЬКО в доме: у проекта
  // такого каталога нет, и искать его там — придумывать среде путь.
  if (deps.scope === 'project') return { items, skipped: [] };

  const synced = readSyncedSkills(join(paths.skills, SYNCED_SKILLS_DIR), source);
  return { items: [...items, ...synced.items], skipped: synced.skipped };
}

function readSyncedSkills(dir: string, source: ReturnType<typeof sourceFactory>): ImportResult {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    // Каталога нет — это обычное состояние, а не поломка: синхронизация с
    // аккаунтом включена не у всех.
    return { items: [], skipped: [] };
  }

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];
  for (const name of names) {
    const skillFile = join(dir, name, 'SKILL.md');
    if (!existsSync(skillFile)) {
      skipped.push(envSkip('skill', 'unsupported_format', `${name}: в каталоге нет SKILL.md`));
      continue;
    }
    const raw = readTextFile(skillFile);
    const { frontmatter, body } = splitFrontmatter(raw);
    items.push(
      skillItem({
        source,
        name,
        description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
        body,
        dir: join(dir, name),
        // Владелец записи — аккаунт: у цели она даст уровень `×` с причиной, а не
        // поедет обычным файлом.
        origin: 'account',
        enabled: true,
        raw,
      }),
    );
  }
  return { items, skipped };
}

/**
 * Команды. Берутся только записи `commands/**`: скилл и плагин — это свои виды
 * канона, и приезжать вторым лицом (командой палитры) они не имеют права,
 * иначе один и тот же скилл поехал бы дважды.
 */
function readCommands(stage: Stage): ImportResult {
  const { paths, deps, store } = stage;
  const { commands, notes } = readClaudeCommands(paths, store);
  const source = sourceFactory(deps.provider.id, deps.scope, join(paths.root, 'commands'));

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = notes.map((note) => envSkip('command', 'not_readable', note));

  for (const command of commands) {
    if (command.source !== 'command') continue;
    if (!command.path) {
      skipped.push(
        envSkip('command', 'unsupported_format', `${command.invocation}: тела команды нет в файле`),
      );
      continue;
    }
    const raw = readTextFile(command.path);
    const [namespace, name] = splitInvocation(command.name, command.invocation);
    items.push(
      commandItem({
        source,
        name,
        namespace,
        description: command.description,
        prompt: splitFrontmatter(raw).body.trim(),
        file: command.path,
        raw,
      }),
    );
  }

  return { items, skipped };
}

/** Хуки обоих файлов настроек. Таймаут у Claude — в секундах. */
function readHooks(stage: Stage): ImportResult {
  const { paths, deps } = stage;
  const source = sourceFactory(deps.provider.id, deps.scope, paths.settings);
  // Третий аргумент — корень, от которого CLI разрешает ОТНОСИТЕЛЬНЫЙ путь
  // скрипта в команде хука. У дома такого корня нет, у проекта он есть, и без
  // него хук проекта выглядел бы записью с несуществующим скриптом.
  const hooks = readHooksFromFiles(paths.settings, paths.settingsLocal, deps.projectRoot);

  const skipped: EnvSkip[] = [];
  const inputs: HookInput[] = hooks.map((hook) => {
    // Битый путь скрипта обязан быть НАЗВАН: зарегистрировать у цели хук,
    // который нечем исполнить, хуже, чем не перенести его вовсе.
    if (hook.scriptPath && hook.scriptExists === false) {
      skipped.push(
        envSkip('hook', 'not_readable', `${hook.id}: скрипт ${hook.scriptPath} не найден на диске`),
      );
    }
    return {
      event: hook.event,
      matcher: hook.matcher ?? null,
      command: hook.command,
      timeout: hook.timeout ?? null,
      scriptPath: hook.scriptPath ?? null,
      enabled: hook.isEnabled,
      raw: JSON.stringify(hook),
    };
  });

  const normalized = normalizeHooks(inputs, {
    source,
    provider: deps.provider,
    timeoutUnit: 's',
    observedNeeds: deps.observedNeeds,
    ownMachine: true,
    // Тот же корень, от которого CLI разрешает относительный путь скрипта: у
    // проекта он есть, у дома его нет.
    ...(deps.projectRoot ? { resolveFrom: deps.projectRoot } : {}),
  });
  return { items: normalized.items, skipped: [...skipped, ...normalized.skipped] };
}

function readClaudePermissions(stage: Stage): ImportResult {
  const { paths, deps, store } = stage;
  const source = sourceFactory(deps.provider.id, deps.scope, paths.settings);
  const normalized = normalizeClaudePermissions(
    readPermissions(paths.settings, store, paths.settingsLocal).map((rule) => ({
      pattern: rule.pattern,
      decision: rule.decision,
      isEnabled: rule.isEnabled,
      source: rule.source,
    })),
    source,
  );
  return { items: normalized.items, skipped: normalized.skipped };
}

/** Сырые записи `.claude.json`: нужен ключ `type`, который читатель панели сводит к stdio. */
interface RawMcpConfig {
  mcpServers?: Record<string, { type?: string }>;
}

function readMcp(stage: Stage): ImportResult {
  const { paths, deps, store } = stage;
  const source = sourceFactory(deps.provider.id, deps.scope, paths.mcpConfig);
  const raw = readJsonFile<RawMcpConfig>(paths.mcpConfig, {});

  const skipped: EnvSkip[] = [];
  const inputs: McpServerInput[] = [];
  for (const server of readMcpServers(paths.mcpConfig, store)) {
    inputs.push({
      // Выключенный сервер лежит в служебном разделе ТОГО ЖЕ файла, и состояние
      // это файловое: он едет записью с `enabled: false` (П2.6), а не исчезает
      // пропуском. Цель с таким же разделом получит его выключенным; цель без
      // него — не получит вовсе, и эмиттер скажет, что именно из двух.
      enabled: server.isEnabled,
      name: server.name,
      // Читатель панели знает три транспорта и незнакомый сводит к stdio —
      // поэтому `sdk` берётся из сырого ключа, иначе запись «сервер внутри
      // процесса SDK» выглядела бы обычной командой.
      transport: rawTransport(raw, server.name) ?? server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      env: server.env,
      headers: server.headers,
      sourceFile: paths.mcpConfig,
    });
  }

  const normalized = normalizeMcpServers(inputs, source);
  return { items: normalized.items, skipped: [...skipped, ...normalized.skipped] };
}

function rawTransport(config: RawMcpConfig, name: string): McpTransport | undefined {
  const type = config.mcpServers?.[name]?.type;
  return type === 'sdk' ? 'sdk' : undefined;
}

/**
 * Переменные окружения и секреты обоих файлов настроек плюс файл секретов.
 *
 * Файла секретов у уровня проекта НЕТ: `.mcp-secrets.env` — механизм панели и
 * её дома, и она одна подставляет оттуда значения лаунчеру. Сказать об этом
 * вслух обязательно: без строки раздел «секреты» исчез бы со страницы проекта, а
 * человек прочитал бы это как «секретов нет», хотя их просто некуда класть.
 */
function readEnv(stage: Stage): ImportResult {
  const { paths, deps } = stage;
  const source = sourceFactory(deps.provider.id, deps.scope, paths.settings);
  const secretsEnv = paths.secretsEnv;

  return {
    // Значения СЫРЫЕ (`mask: false`): что здесь секрет, решает правило паспорта,
    // и маску считает он сам. Замаскированное списком панели значение приезжало
    // записью `envVar`, чей `value` — строка с точками: запись, утверждающая
    // значение, которого у переменной нет.
    items: readEnvVars(paths.settings, secretsEnv, paths.settingsLocal, false).map((variable) =>
      envVarOrSecret({
        source,
        key: variable.key,
        value: variable.value,
        file: variable.source === 'secrets' && secretsEnv ? secretsEnv : paths.settings,
        // Значение из файла секретов держит панель — она же его и подставляет
        // лаунчеру; значение из settings.json держит сам CLI.
        holder: variable.source === 'secrets' ? 'panel' : 'provider',
      }),
    ),
    skipped: secretsEnv
      ? []
      : [
          envSkip(
            'secret',
            'no_section',
            'файл секретов панели (.mcp-secrets.env) есть только у дома: у проекта своего нет',
          ),
        ],
  };
}

/**
 * Плагины — СОДЕРЖИМЫМ (П2.6, разбор в `plugins-claude.ts`).
 *
 * Раньше раздел целиком назывался непрочитанным: состав реестра якобы знает
 * только `claude plugin list`, а паспорт чужих процессов не запускает. Реестр
 * при этом лежит файлом (`plugins/installed_plugins.json`) и читается без
 * единого запуска — так что непрочитанным раздел был не по природе, а потому
 * что файл не читали.
 */
function readPlugins(stage: Stage): ImportResult {
  // Реестр плагинов у CLI один и домашний: проектного уровня у него нет вовсе.
  if (stage.deps.scope === 'project') {
    return {
      items: [],
      skipped: [
        envSkip('plugin', 'no_section', 'плагины CLI ставит домом: уровня проекта у них нет'),
      ],
    };
  }

  const dir = join(stage.paths.root, 'plugins');
  if (!isDirectory(dir)) return { items: [], skipped: [] };

  return readClaudePlugins({
    pluginsDir: dir,
    // Порядок значим: локальный файл настроек старше общего, как и у всех
    // остальных разделов панели.
    settingsPaths: [stage.paths.settings, stage.paths.settingsLocal],
    provider: stage.deps.provider,
    scope: stage.deps.scope,
    observedNeeds: stage.deps.observedNeeds,
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `/dir:name` → пространство имён и имя. */
function splitInvocation(name: string, invocation: string): [string | null, string] {
  const bare = invocation.replace(/^\//, '');
  const separator = bare.lastIndexOf(':');
  if (separator === -1) return [null, name];
  return [bare.slice(0, separator), bare.slice(separator + 1)];
}
