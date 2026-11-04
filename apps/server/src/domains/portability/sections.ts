import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type {
  EnvItem,
  EnvItemKind,
  EnvScope,
  EnvSectionState,
  EnvSkip,
} from '@agentdeck/contracts/portable-env';
import { readTextFile } from '../../lib/safe-io/safe-io.ts';
import { readProviderCommands } from '../commands/providers.ts';
import { readProviderEnvVars } from '../provider-env/provider-env.ts';
import { readProviderHooksInfo } from '../provider-hooks/info.ts';
import { readProviderInstructionsEntries } from '../provider-instructions/provider-instructions.ts';
import { readProviderMcpSection } from '../provider-mcp/section.ts';
import { readProviderPermissions } from '../provider-permissions/dispatch.ts';
import { readProviderPluginsInfo } from '../provider-plugins/info.ts';
import { readProviderRulesInfo } from '../provider-rules/read.ts';
import { readProviderSkillsInfo } from '../provider-skills/read.ts';
import type { ServerMessageCode } from '@agentdeck/contracts/server-messages';
import { envSkip } from './canon.ts';
import { guardSection, unreadableSection } from './section-guard.ts';
import { nested } from './intent-codes.ts';
import { sectionTargets, type SectionTargets } from './project/project.ts';
import { bodyAfterFrontmatter } from './markdown.ts';
import {
  normalizeHooks,
  opencodeHookInputs,
  preservedHookItem,
  scriptPathOf,
  type HookInput,
} from './normalize-hooks.ts';
import { normalizeMcpServers } from './normalize-mcp.ts';
import { readHookShimCommand } from './emit/hook-shim/hook-shim.ts';
import { normalizePermissions } from './normalize-permissions.ts';
import {
  commandItem,
  envVarOrSecret,
  instructionsItem,
  pluginItem,
  skillItem,
} from './normalize-files.ts';
import { sourceFactory } from './normalize-types.ts';
import type { ImportDeps, ImportResult } from './types.ts';

/**
 * Универсальные разделы девяти чужих CLI → канон.
 *
 * Это НЕ «общий файл для похожих провайдеров»: у каждого CLI свой файл в
 * `import/`, и он решает, какие разделы читать и что добавить сверх общего. Здесь
 * лежат ЭТАПЫ, одинаковые по имени у всех (§5.3 плана), — сами тела разные, и
 * различает их каталог возможностей, а не ветка по идентификатору.
 *
 * Каждый этап отвечает одинаково: раздела у провайдера нет — ПРОПУСК С
 * ПРИЧИНОЙ, а не исключение. Провайдер без хуков — это законная среда, а не
 * поломка, и падать на ней значило бы соврать о поломке.
 */

/** Один этап импорта: разделы уровня уже разрешены, читать остаётся по путям. */
type Stage = (deps: ImportDeps, targets: SectionTargets) => ImportResult;

/**
 * Виды записей, о которых отчитываются универсальные этапы. Список нужен, когда
 * отчитываться нечем: уровня у провайдера нет, и каждый вид обязан назвать эту
 * причину — иначе раздел исчезнет со страницы и прочитается как «панель сюда не
 * смотрела».
 */
const UNIVERSAL_KINDS: readonly EnvItemKind[] = [
  'instructions',
  'mcpServer',
  'envVar',
  'permission',
  'hook',
  'skill',
  'plugin',
  'command',
];

/** Собрать все разделы, которые объявлены каталогом возможностей провайдера. */
export function readUniversalSections(deps: ImportDeps): ImportResult {
  const targets = sectionTargets(deps.provider, deps.scope, {
    override: deps.override,
    projectRoot: deps.projectRoot,
  });

  // Уровень провайдеру не известен (проектных путей он не документирует) —
  // названный пропуск по каждому виду. Подставить сюда домашние пути значило бы
  // выдать глобальную среду за проектную.
  if (!targets.supported) {
    // `projectSupport` называет причину с кодом на каждой ветке «не поддержан».
    const skip = (kind: EnvItemKind) =>
      envSkip(kind, 'no_section', targets.why ?? '', targets.whyCode, targets.whyParams);
    return { items: [], skipped: UNIVERSAL_KINDS.map(skip) };
  }

  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];
  const sectionStates: EnvSectionState[] = [];

  // Раздел, который бросил, назван непрочитанным; остальные разделы паспорта на месте.
  for (const [stage, kinds, where] of [
    [readInstructions, ['instructions'], targets.instructionsFile],
    [readRules, ['instructions'], targets.instructionsRules?.rulesDir],
    [readInstructionsList, ['instructions'], targets.instructionsList?.configPath],
    [readMcp, ['mcpServer'], targets.mcp?.filePath],
    [readEnv, ['envVar'], targets.env?.filePath],
    [readPermissions, ['permission'], targets.permissions?.filePath],
    [readHooks, ['hook'], targets.hooks?.filePath],
    [readSkills, ['skill'], targets.skills?.skillsDir],
    [readPlugins, ['plugin'], targets.plugins?.pluginsDir],
    [readCommands, ['command'], targets.commands?.dir],
  ] satisfies [Stage, EnvItemKind[], string | undefined][]) {
    const result = guardSection(kinds, where ?? targets.root, () => stage(deps, targets));
    items.push(...result.items);
    skipped.push(...result.skipped);
    sectionStates.push(...(result.sectionStates ?? []));
  }

  return { items, skipped, sectionStates };
}

/** Один файл инструкций (`AGENTS.md`, `GEMINI.md`, …). */
function readInstructions(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const { provider } = deps;
  const filePath = targets.instructionsFile;
  if (!filePath) {
    // «Раздела нет» говорится только о провайдере, у которого инструкций нет
    // ВООБЩЕ. У cursor они лежат каталогом правил, у aider — списком в конфиге, и
    // эти этапы читают их следом: сказать про них «этого раздела не имеет» —
    // утверждение о чужом CLI, которое человек читает рядом со своими же
    // правилами.
    if (targets.instructionsRules ?? targets.instructionsList) return { items: [], skipped: [] };
    return {
      items: [],
      skipped: [
        envSkip('instructions', 'no_section', ...notSupported(provider.name, targets.scope)),
      ],
    };
  }

  if (!existsSync(filePath)) {
    return {
      items: [],
      skipped: [
        envSkip('instructions', 'empty', `файла ${filePath} нет`, 'portability-skip-file-missing', {
          path: filePath,
        }),
      ],
    };
  }

  const source = sourceFactory(provider.id, deps.scope, filePath);
  // Нераскрытые импорты складываются сюда: цикл обязан быть НАЗВАН, а не
  // проглочен вместе с куском инструкций.
  const skipped: EnvSkip[] = [];
  return {
    items: [
      instructionsItem({
        source,
        filePath,
        fileName: basename(filePath),
        legacy: false,
        raw: readTextFile(filePath),
        skips: skipped,
      }),
    ],
    skipped,
  };
}

/** Каталог правил (`~/.cursor/rules`, Continue): каждое правило — свои инструкции. */
function readRules(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.instructionsRules;
  if (!target) return { items: [], skipped: [] };

  const info = readProviderRulesInfo(target);
  if (info.error) {
    return {
      items: [],
      skipped: [unreadableSection('instructions', target.rulesDir, info.error)],
    };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.rulesDir);
  const skipped: EnvSkip[] = info.ignored.map((file) =>
    envSkip(
      'instructions',
      'unsupported_format',
      `${file.path}: расширение не читается этим CLI`,
      'portability-skip-rule-extension',
      { path: file.path },
    ),
  );
  return {
    items: info.rules.map((rule) =>
      instructionsItem({
        source,
        filePath: rule.fullPath,
        fileName: rule.path,
        legacy: false,
        raw: readTextFile(rule.fullPath),
        skips: skipped,
      }),
    ),
    skipped,
  };
}

/** Список ссылок на файлы инструкций (Aider `~/.aider.conf.yml`). */
function readInstructionsList(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.instructionsList;
  if (!target) return { items: [], skipped: [] };

  const source = sourceFactory(deps.provider.id, deps.scope, target.configPath);
  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];
  for (const entry of readProviderInstructionsEntries(target)) {
    if (!entry.exists) {
      skipped.push(
        envSkip(
          'instructions',
          'not_readable',
          `${entry.raw}: файла нет на диске`,
          'portability-skip-file-absent',
          { path: entry.raw },
        ),
      );
      continue;
    }
    items.push(
      instructionsItem({
        source,
        filePath: entry.path,
        fileName: basename(entry.path),
        legacy: false,
        raw: readTextFile(entry.path),
        skips: skipped,
      }),
    );
  }
  return { items, skipped };
}

function readMcp(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.mcp;
  if (!target) {
    return {
      items: [],
      skipped: [
        envSkip('mcpServer', 'no_section', ...notSupported(deps.provider.name, targets.scope)),
      ],
    };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.filePath);
  try {
    const section = readProviderMcpSection(target);
    const normalized = normalizeMcpServers(section.servers, source);
    return orEmpty('mcpServer', target.filePath, {
      items: normalized.items,
      skipped: [
        ...normalized.skipped,
        ...section.skippedBlocks.map((block) =>
          envSkip(
            'mcpServer',
            'unsupported_format',
            `${block.path}: ${block.reason}`,
            'portability-skip-mcp-block',
            { path: block.path, reason: nested(block.reasonCode) },
          ),
        ),
      ],
    });
  } catch (error) {
    // Fail-closed: файл не разобран — записей нет, причина названа.
    return { items: [], skipped: [unreadableSection('mcpServer', target.filePath, error)] };
  }
}

function readEnv(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.env;
  if (!target) {
    return {
      items: [],
      skipped: [
        envSkip('envVar', 'no_section', ...notSupported(deps.provider.name, targets.scope)),
      ],
    };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.filePath);
  try {
    return orEmpty('envVar', target.filePath, {
      items: readProviderEnvVars(target).map((variable) =>
        envVarOrSecret({
          source,
          key: variable.key,
          value: variable.value,
          file: target.filePath,
          // Значение лежит в файле самого CLI — держатель он, не панель.
          holder: 'provider',
        }),
      ),
      skipped: [],
    });
  } catch (error) {
    return { items: [], skipped: [unreadableSection('envVar', target.filePath, error)] };
  }
}

function readPermissions(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.permissions;
  if (!target) {
    return {
      items: [],
      skipped: [
        envSkip('permission', 'no_section', ...notSupported(deps.provider.name, targets.scope)),
      ],
    };
  }

  // Файла нет — читать нечего, и УМОЛЧАНИЯ адаптера сюда не подставляются.
  // Иначе паспорт CLI, который на машине даже не установлен, утверждал бы режим
  // подтверждений «в файле ключа нет» — описанную среду, которой не существует
  // (§7, строка «целевой CLI не установлен» требует «не проверено»).
  if (!existsSync(target.filePath)) {
    return {
      items: [],
      skipped: [
        envSkip(
          'permission',
          'empty',
          `файла ${target.filePath} нет`,
          'portability-skip-file-missing',
          {
            path: target.filePath,
          },
        ),
      ],
    };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.filePath);
  try {
    const normalized = normalizePermissions(readProviderPermissions(target), source);
    return orEmpty('permission', target.filePath, {
      items: normalized.items,
      skipped: normalized.skipped,
    });
  } catch (error) {
    return { items: [], skipped: [unreadableSection('permission', target.filePath, error)] };
  }
}

function readHooks(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.hooks;
  if (!target) {
    return {
      items: [],
      skipped: [envSkip('hook', 'no_section', ...notSupported(deps.provider.name, targets.scope))],
    };
  }

  const info = readProviderHooksInfo(target);
  if (info.error) {
    return { items: [], skipped: [unreadableSection('hook', target.filePath, info.error)] };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.filePath);
  const inputs: HookInput[] =
    info.shape === 'opencode-events'
      ? opencodeHookInputs({ fileEdited: info.fileEdited, sessionCompleted: info.sessionCompleted })
      : info.rules.map((rule) => {
          // Переходник (П3.3) в конфиге цели стоит ВМЕСТО команды человека.
          // В канон обязана вернуться команда человека: иначе повторный импорт
          // записал бы в канон сгенерированный посредник, и перенос подменил бы
          // людям их же хуки. `raw` остаётся как в файле — это то, что там
          // действительно лежит.
          const command = readHookShimCommand(rule.command) ?? rule.command;
          return {
            event: rule.event,
            matcher: rule.matcher ?? null,
            command,
            timeout: rule.timeout ?? null,
            scriptPath: scriptPathOf(command),
            enabled: true,
            raw: JSON.stringify(rule),
          };
        });

  const normalized = normalizeHooks(inputs, {
    source,
    provider: deps.provider,
    // Единица едет вместе со значением: `qwen` — мс, `kimi` — секунды.
    timeoutUnit: info.timeoutUnit ?? 's',
    observedNeeds: deps.observedNeeds,
    ownMachine: true,
    // Рубильник раздела опускается на КАЖДУЮ запись: у источника они не
    // исполняются, и приехать к цели действующими не имеют права (П2.6).
    // Прежде он был пропуском рядом с включёнными записями — то есть перенос
    // включал у цели то, что человек выключил целым разделом.
    sectionEnabled: !info.disableAll,
  });

  const preserved = [...info.preservedRules, ...info.preservedEvents].map((entry) =>
    preservedHookItem({ source, key: entry.key, value: entry.value }),
  );

  // Рубильник всего раздела: хуки в файле есть, но CLI их не исполняет. Он едет
  // СОСТОЯНИЕМ — записи раздела выключены выше, — а эта строка объясняет
  // человеку, откуда состояние взялось.
  const sectionStates: EnvSectionState[] = info.disableAll
    ? [
        {
          kind: 'hook',
          enabled: false,
          detail: `${target.filePath}: ключ disableAllHooks выключает весь раздел`,
          detailCode: 'portability-section-hooks-off',
          detailParams: { path: target.filePath },
        },
      ]
    : [];

  return {
    ...orEmpty('hook', target.filePath, {
      items: [...normalized.items, ...preserved],
      skipped: [...normalized.skipped],
    }),
    sectionStates,
  };
}

function readSkills(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.skills;
  if (!target) {
    return {
      items: [],
      skipped: [envSkip('skill', 'no_section', ...notSupported(deps.provider.name, targets.scope))],
    };
  }

  const info = readProviderSkillsInfo(target);
  if (info.error) {
    return { items: [], skipped: [unreadableSection('skill', target.skillsDir, info.error)] };
  }

  const source = sourceFactory(deps.provider.id, deps.scope, target.skillsDir);
  return orEmpty('skill', target.skillsDir, {
    items: info.skills.map((skill) => {
      const raw = readTextFile(skill.fullPath);
      return skillItem({
        source,
        name: skill.name,
        description: skill.description ?? '',
        body: bodyAfterFrontmatter(raw),
        dir: skill.fullPath.slice(0, skill.fullPath.length - basename(skill.fullPath).length - 1),
        enabled: true,
        raw,
      });
    }),
    skipped: info.ignored.map((dir) =>
      envSkip(
        'skill',
        'unsupported_format',
        `${dir.dirName}: в каталоге нет SKILL.md`,
        'portability-skip-no-skill-file',
        { name: dir.dirName },
      ),
    ),
  });
}

function readPlugins(deps: ImportDeps, targets: SectionTargets): ImportResult {
  const target = targets.plugins;
  if (!target) {
    return {
      items: [],
      skipped: [
        envSkip('plugin', 'no_section', ...notSupported(deps.provider.name, targets.scope)),
      ],
    };
  }

  const info = readProviderPluginsInfo(target);
  const source = sourceFactory(deps.provider.id, deps.scope, target.pluginsDir);
  const items: EnvItem[] = [];

  // Раздел read-only у источника (`kimi`: состоянием владеет его `/plugins`) —
  // это факт записи, а не запрет на чтение.
  const readOnly = target.format === 'kimi-plugins';
  for (const installed of info.installed) {
    items.push(
      pluginItem({
        source,
        name: installed.name ?? installed.id,
        version: installed.version ?? null,
        // Единица чужого реестра: ни кода, ни имени пакета у панели нет.
        form: 'installed',
        readOnly,
        provides: installed.hasSkills ? ['skill'] : [],
        file: installed.manifestPath,
        raw: JSON.stringify(installed),
      }),
    );
  }
  for (const file of info.files) {
    items.push(
      pluginItem({
        source,
        name: file.path,
        version: null,
        // Файл кода: содержимое уже в `raw`, и оно и есть весь плагин.
        form: 'module',
        readOnly,
        provides: [],
        file: file.fullPath,
        raw: readTextFile(file.fullPath),
      }),
    );
  }
  for (const name of info.packages) {
    items.push({
      // Имя npm-пакета в списке конфига: едет имя, пакет ставит сам CLI.
      ...pluginItem({
        source,
        name,
        version: null,
        form: 'package',
        readOnly,
        provides: [],
        file: null,
        raw: name,
      }),
    });
  }

  const skipped: EnvSkip[] = [];
  if (info.filesError) {
    skipped.push(unreadableSection('plugin', target.pluginsDir, info.filesError));
  }
  if (info.packagesError) {
    const where = target.configPath ?? target.pluginsDir;
    skipped.push(unreadableSection('plugin', where, info.packagesError));
  }
  return orEmpty('plugin', target.pluginsDir, { items, skipped });
}

function readCommands(deps: ImportDeps, targets: SectionTargets): ImportResult {
  if (!targets.commands) {
    return {
      items: [],
      skipped: [
        envSkip('command', 'no_section', ...notSupported(deps.provider.name, targets.scope)),
      ],
    };
  }

  const commandsDir = targets.commands.dir;
  const { commands } = readProviderCommands(deps.provider);
  const configPath = targets.commands.config.configPath?.();
  const source = sourceFactory(deps.provider.id, deps.scope, null);
  const items: EnvItem[] = [];
  const skipped: EnvSkip[] = [];

  for (const command of commands) {
    const declaredInConfig = command.path !== undefined && command.path === configPath;
    const prompt = command.path && !declaredInConfig ? commandPrompt(command.path) : undefined;
    if (prompt === undefined) {
      // Тела нет — переносить нечего: команда, объявленная ключом конфига, живёт
      // внутри чужого файла, и вытащить её текст отсюда нельзя.
      skipped.push(
        envSkip(
          'command',
          'unsupported_format',
          `${command.invocation}: тело команды не в файле`,
          'portability-skip-command-body-config',
          { command: command.invocation },
        ),
      );
      continue;
    }
    const [namespace, name] = splitInvocation(command.name, command.invocation);
    items.push(
      commandItem({
        source,
        name,
        namespace,
        description: command.description,
        prompt,
        file: command.path ?? null,
        raw: command.path ? readTextFile(command.path) : prompt,
      }),
    );
  }

  return orEmpty('command', commandsDir, { items, skipped });
}

// --- Мелкие общие вещи -------------------------------------------------------

/**
 * «Раздела нет» — и на КАКОМ уровне нет. Без уровня фраза врала бы: у opencode
 * скиллы есть и дома, и в проекте, а у codex проектный уровень — только
 * `AGENTS.md`, и «codex этого раздела не имеет» человек прочитал бы как приговор
 * всему CLI.
 */
function notSupported(
  providerName: string,
  scope: EnvScope,
): [string, ServerMessageCode, { provider: string }] {
  return scope === 'project'
    ? [
        `${providerName} не имеет этого раздела на уровне проекта`,
        'portability-skip-no-section-project',
        { provider: providerName },
      ]
    : [
        `${providerName} этого раздела не имеет`,
        'portability-skip-no-section',
        { provider: providerName },
      ];
}

/**
 * Раздел у провайдера есть, он прочитан — и в нём ничего не нашлось. Это ОТВЕТ,
 * и он произносится вслух.
 *
 * Пустой возврат стирал раздел со страницы целиком: экран рисует только те виды,
 * у которых есть записи или пропуски. Отсутствие строки человек читает как «сюда
 * панель не смотрела», а это ровно та ложь о среде, ради запрета которой и
 * заведён словарь причин — причина `empty` в нём была с самого начала и не
 * использовалась ни разу, кроме отсутствующего файла инструкций.
 */
function orEmpty(kind: EnvItemKind, where: string, result: ImportResult): ImportResult {
  if (result.items.length > 0 || result.skipped.length > 0) return result;
  return {
    items: [],
    skipped: [
      envSkip(kind, 'empty', `${where}: записей нет`, 'portability-skip-no-records', { where }),
    ],
  };
}

/**
 * Текст команды из её файла: у формата `toml-prompt` это ключ `prompt`, у
 * markdown — тело после шапки. Файл не прочитан → `undefined` (вызывающий
 * назовёт причину).
 */
function commandPrompt(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  if (!path.toLowerCase().endsWith('.toml')) return bodyAfterFrontmatter(raw);
  try {
    const parsed = parseToml(raw) as { prompt?: unknown };
    return typeof parsed.prompt === 'string' ? parsed.prompt : undefined;
  } catch {
    return undefined;
  }
}

/** `/dir:name` → пространство имён и имя. Разделитель у всех форматов один. */
function splitInvocation(name: string, invocation: string): [string | null, string] {
  const bare = invocation.replace(/^\//, '');
  const separator = bare.lastIndexOf(':');
  if (separator === -1) return [null, name];
  return [bare.slice(0, separator), bare.slice(separator + 1)];
}
