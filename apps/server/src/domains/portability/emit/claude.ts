import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  CommandItem,
  EnvVarItem,
  HookItem,
  McpServerItem,
  PermissionItem,
  SkillItem,
  SubagentItem,
} from '@agentdeck/contracts/portable-env';
import { permissionDecisions } from '@agentdeck/contracts/portable-env';
import type { Hook, McpServerDraft, PermissionDraft } from '@agentdeck/contracts';
import { detectClaudeLocation } from '../../../lib/claude-paths.ts';
import { claudeProjectPaths, ProjectRootRequiredError, type ClaudeLevelPaths } from '../project.ts';
import { readTextFile, writeTextFile } from '../../../lib/safe-io.ts';
import { slugify } from '../../../lib/slug.ts';
import { readHooksFromFiles, writeHooks } from '../../hooks.ts';
import { assertMcpDraft, DISABLED_MCP_KEY, saveMcpServer, setMcpServerEnabled } from '../../mcp.ts';
import { saveEnvVar } from '../../env.ts';
import { savePermission } from '../../permissions.ts';
import { disabledSkillsDir } from '../../skills/paths.ts';
import { saveSkill } from '../../skills/write.ts';
import { splitFrontmatter } from '../../skills/frontmatter.ts';
import { bodyAfterFrontmatter } from '../markdown.ts';
import { targetEventName } from '../fidelity.ts';
import { translatePermission } from '../permissions-map.ts';
import { readSubagentsDir } from '../subagents.ts';
import {
  buildPlan,
  claimTargetFile,
  EmitMechanismMissingError,
  emitEntry,
  isSafeSegment,
  sharesLocation,
  ownedByPanel,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';
import { hookCommandForTarget } from './hook-command.ts';
import { blockOf, isEnabled, spliceBlock, textOf } from './text-block.ts';
import { attachmentWrites } from './write-attachments.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Claude Code, то есть перенос В свой CLI (`gemini → claude`,
 * `codex → claude`, `claude → claude`).
 *
 * Единственный эмиттер, у которого нет ни одного универсального этапа. Причина
 * та же, что у импортёра: у Claude КАЖДЫЙ раздел свой и богатый, и универсальные
 * адаптеры каталога его не видят — `claudeProvider` нарочно объявлен без
 * `hooksConfig`/`skillsConfig`/`commandsConfig` (это закреплено тестом реестра),
 * чтобы чужие форматы не пытались писать в его файлы своей моделью.
 *
 * Общее с девятью чужими — каркас плана (`context.ts`): приговор считается один
 * раз тем же `fidelity.ts`, каждая запись получает ровно одну строку, а всё, что
 * не забрал ни один этап, объясняется рантаймом. Вторая таблица «запись → что с
 * ней делать» здесь не появляется: этапы исполняют приговор, а не пересчитывают.
 *
 * Права (`permission`) переводит общий `permissions-map.ts`: грамматика Claude И
 * ЕСТЬ каноническая, поэтому перевод тождественный, а проверки — те же, что у
 * чужих целей.
 */
export const emitToClaude: Emitter = (env, deps) =>
  buildPlan(env, deps, [
    emitClaudeInstructions,
    emitClaudeSkills,
    emitClaudeCommands,
    emitClaudeSubagents,
    emitClaudeHooks,
    emitClaudeMcp,
    emitClaudeEnvVars,
    emitClaudePermissions,
  ]);

/**
 * Пути Claude на уровне плана.
 *
 * Дом — ручной каталог уважается, как и во всей панели. Проект — раскладка
 * репозитория (`CLAUDE.md` в корне, `.claude/` рядом, `.mcp.json` в корне), и
 * строит её тот же `claudeProjectPaths`, которым пользуется импорт: два
 * построителя разошлись бы молча, и предпросмотр показывал бы один файл, а
 * запись правила другой.
 */
function paths(context: EmitContext): ClaudeLevelPaths {
  const { deps } = context;
  if (deps.scope !== 'project') {
    const home = detectClaudeLocation(deps.override).paths;
    return { ...home, instructionsRoot: home.root };
  }
  if (!deps.projectRoot) throw new ProjectRootRequiredError();
  return claudeProjectPaths(deps.projectRoot);
}

/**
 * Инструкции и всё, что доехало ТЕКСТОМ, — в область панели внутри `CLAUDE.md`.
 *
 * Текст человека снаружи меток не трогается, а повторное применение плана
 * заменяет ровно эту область: инвариант 10 требует, чтобы второй прогон не
 * наращивал копии.
 */
function emitClaudeInstructions(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item) => {
    const verdict = verdictOf(context, item);
    if (verdict.level === 'text') return true;
    return item.kind === 'instructions' && verdict.level === 'native';
  });
  if (items.length === 0) return result;

  const filePath = paths(context).claudeMd;
  const carried = [];
  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (!isEnabled(item)) {
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', filePath));
      continue;
    }
    carried.push(item);
    result.entries.push(emitEntry(item, verdict, 'written', filePath));
  }
  if (carried.length === 0) return result;

  const block = blockOf(carried.map((item) => textOf(item)));
  // Имя резервной копии у Claude ПРЕЖНЕЕ (`CLAUDE.md.<метка>.bak`), без префикса
  // провайдера: то же решение, что в `domains/instructions.ts` — история и откат
  // ленты правил опираются на это имя, и второе имя порвало бы им ротацию.
  const write = (path: string, backupDir: string | undefined): void => {
    const original = existsSync(path) ? readTextFile(path) : '';
    void writeTextFile(path, spliceBlock(original, block), { backupDir });
  };

  result.writes.push({
    kind: 'instructions',
    itemIds: carried.map((item) => item.id),
    filePath,
    apply: (backupDir) => write(filePath, backupDir),
    applyTo: (path) => write(path, undefined),
  });
  return result;
}

/** Скиллы: папка на скилл со `SKILL.md`, тем же адаптером, что правит панель. */
function emitClaudeSkills(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is SkillItem => item.kind === 'skill');
  if (items.length === 0) return result;

  const skillsDir = paths(context).skills;

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    // Источник держит скилл в каталоге, который Claude читает сам: копия
    // создала бы второй экземпляр, который дальше разойдётся правками.
    if (sharesLocation(verdict)) {
      result.entries.push(emitEntry(item, verdict, 'already_available', item.dir));
      continue;
    }
    // Имя папки считается ТЕМ ЖЕ `slugify`, каким его посчитает `saveSkill`:
    // иначе план назвал бы один путь, а запись легла бы в другой.
    const slug = slugify(item.name);
    if (!slug) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    // Выключенный скилл приезжает ВЫКЛЮЧЕННЫМ (П2.6): у Claude состояние
    // файловое — выключенный скилл физически лежит в `skills-disabled/`, — и
    // запись туда переносит и сам скилл, и решение человека о нём. Прежде такая
    // запись не ехала вовсе (`disabled_at_source`): у форматов без выключателя
    // это единственный честный ответ, но у цели с выключателем — потеря.
    const baseDir = item.enabled ? skillsDir : disabledSkillsDir(skillsDir);
    const filePath = join(baseDir, slug, 'SKILL.md');
    const exists = existsSync(filePath);
    // Столкновение бывает и с тем, что лежит у цели, и с записью ЭТОГО ЖЕ
    // паспорта: свой скилл и скилл из плагина носят одно имя (П2.6).
    if (
      (exists && differsFromSkill(filePath, item) && !ownedByPanel(context, item)) ||
      !claimTargetFile(context, 'skill', filePath)
    ) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', filePath));
      continue;
    }

    const draft = { name: item.name, description: item.description, body: item.body, groupIds: [] };
    // Создание или правка решается В МОМЕНТ ЗАПИСИ, а не при построении плана:
    // `saveSkill` на создании с занятым слагом отказывает (и правильно делает),
    // а после первого применения слаг занят СВОЕЙ же записью — решённое заранее
    // «создать» превратило бы второй прогон того же плана в падение.
    const write = (dir: string, backupDir: string | undefined): void => {
      const lives = existsSync(join(dir, slug, 'SKILL.md'));
      void saveSkill(dir, lives ? slug : null, draft, backupDir);
    };

    result.entries.push(emitEntry(item, verdict, 'written', filePath));
    result.writes.push({
      kind: 'skill',
      itemIds: [item.id],
      filePath,
      // Песочница сохраняет `<слаг>/SKILL.md` — иначе прародителем копии
      // оказался бы системный временный каталог, и скилл лёг бы туда.
      sandboxSegments: 2,
      apply: (backupDir) => write(baseDir, backupDir),
      // Путь песочницы указывает на `<каталог>/<слаг>/SKILL.md`, поэтому
      // каталогом скиллов для неё служит его прародитель.
      applyTo: (path) => write(dirname(dirname(path)), undefined),
    });
    // Вложения — ПОСЛЕ самого скилла, и порядок здесь содержательный: адаптер
    // скилла отказывается создавать скилл в каталоге, который уже существует
    // (`SkillExistsError`), а первое же вложение этот каталог и создаёт.
    result.writes.push(
      ...attachmentWrites({
        item,
        targetDir: join(baseDir, slug),
        targetId: context.deps.target.id,
      }),
    );
  }

  return result;
}

/**
 * Слэш-команды: `commands/<пространство>/<имя>.md` с шапкой `description`.
 * Адаптера записи у раздела нет (панель эти файлы только читает), поэтому запись
 * идёт через `lib/safe-io.ts` — прямого `writeFileSync` здесь не будет (§5.3).
 */
function emitClaudeCommands(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is CommandItem => item.kind === 'command');
  if (items.length === 0) return result;

  const commandsDir = join(paths(context).root, 'commands');

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    // Пространство имён Claude пишет подкаталогом, а зовёт через двоеточие.
    const segments = [...(item.namespace ? item.namespace.split(':') : []), item.name];
    if (!segments.every(isSafeSegment)) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    const filePath = `${join(commandsDir, ...segments)}.md`;
    const text = commandMarkdown(item);
    if (
      (existsSync(filePath) && readTextFile(filePath) !== text && !ownedByPanel(context, item)) ||
      !claimTargetFile(context, 'command', filePath)
    ) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', filePath));
      continue;
    }

    result.entries.push(emitEntry(item, verdict, 'written', filePath));
    result.writes.push({
      kind: 'command',
      itemIds: [item.id],
      filePath,
      apply: (backupDir) => void writeTextFile(filePath, text, { backupDir }),
      applyTo: (path) => void writeTextFile(path, text, {}),
    });
  }

  return result;
}

/**
 * Субагенты: `agents/<имя>.md` с шапкой. Писателя у раздела нет ни одного (панель
 * эти файлы только читает), поэтому шапка собирается здесь — и ровно из тех
 * ключей, что несёт канон: лишний ключ был бы догадкой о чужом файле.
 */
function emitClaudeSubagents(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is SubagentItem => item.kind === 'subagent');
  if (items.length === 0) return result;

  const agentsDir = join(paths(context).root, 'agents');
  const already = readSubagentsDir(agentsDir);

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!isSafeSegment(item.name)) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    const filePath = join(agentsDir, `${item.name}.md`);
    const body = bodyAfterFrontmatter(item.raw);
    const text = subagentMarkdown(item, body);
    const found = already.subagents.find((parsed) => parsed.name === item.name);
    if (
      (found && found.body !== body.trim() && !ownedByPanel(context, item)) ||
      !claimTargetFile(context, 'subagent', filePath)
    ) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', filePath));
      continue;
    }

    result.entries.push(emitEntry(item, verdict, 'written', filePath));
    result.writes.push({
      kind: 'subagent',
      itemIds: [item.id],
      filePath,
      apply: (backupDir) => void writeTextFile(filePath, text, { backupDir }),
      applyTo: (path) => void writeTextFile(path, text, {}),
    });
  }

  return result;
}

/**
 * Хуки: ключ `hooks` в `settings.json`, собранный тем же кодом, каким его пишет
 * раздел хуков. Соседние записи читаются и уезжают в запись вместе с новыми —
 * передать только свои значило бы стереть остальные.
 *
 * Состояние панели здесь НЕ читается (`readHooksFromFiles` — нейтральный вид):
 * перенос обязан работать и в чужом доме, где отметок панели нет вовсе, и тот же
 * приём использует импортёр.
 */
function emitClaudeHooks(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is HookItem => item.kind === 'hook');
  if (items.length === 0) return result;

  const settingsPath = paths(context).settings;
  const hooks = readHooksFromFiles(settingsPath);
  const before = hooks.length;
  const carried: string[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    if (!item.enabled) {
      // Приехавший извне хук выключен по инварианту 9: включение чужого скрипта
      // — отдельное подтверждение человека с показанным содержимым, а в
      // `settings.json` выключателя нет, и запись сделала бы его действующим.
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', settingsPath));
      continue;
    }

    const event = targetEventName(context.deps.target, item.trigger);
    if (!event) throw new EmitMechanismMissingError(context.deps.target.id, 'hook');

    const matcher = item.trigger.on === 'tool' ? (item.trigger.match ?? undefined) : undefined;
    const timeout = timeoutSeconds(item);
    const draft: Hook = {
      id: `${event}:${item.id}`,
      event: event as Hook['event'],
      ...(matcher ? { matcher } : {}),
      // Путь скрипта — абсолютный и в написании, которое цель исполнит: скрипты
      // хуков не копируются, они зовутся по своему пути на этой же машине.
      command: hookCommandForTarget(item),
      ...(timeout === undefined ? {} : { timeout }),
      isEnabled: true,
      groupIds: [],
      source: 'settings',
    };

    // Тождество хука — событие, матчер и команда: в файле у записи ключа нет, и
    // повторный прогон обязан узнать свою же запись (инвариант 10).
    if (!hooks.some((existing) => sameHook(existing, draft))) hooks.push(draft);
    carried.push(item.id);
    result.entries.push(emitEntry(item, verdict, 'written', settingsPath));
  }

  if (hooks.length !== before) {
    result.writes.push({
      kind: 'hook',
      itemIds: carried,
      filePath: settingsPath,
      apply: (backupDir) => void writeHooks(settingsPath, hooks, backupDir),
      applyTo: (path) => void writeHooks(path, hooks, undefined),
    });
  }

  return result;
}

/**
 * MCP-серверы: тем же `saveMcpServer`, которым правит панель, и ОДНОЙ правкой
 * файла на все серверы.
 *
 * Правка на сервер давала несколько правок одного слоя с одним путём
 * (`.claude.json` у всех серверов один), а это план запрещает
 * (`assertNoSilentOverwrite`): отличить «перечитывает и дописывает» от
 * «затирает» он не может. Дом с двумя серверами и больше падал 500 на самом
 * построении плана — ровно как у остальных девяти целей.
 */
function emitClaudeMcp(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is McpServerItem => item.kind === 'mcpServer');
  if (items.length === 0) return result;

  const configPath = paths(context).mcpConfig;
  const existing = readServersFromConfig(configPath);
  /** Серверы, которые поедут, — все в одну правку конфига. */
  const carried: { itemId: string; name: string; draft: McpServerDraft; enabled: boolean }[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    if (item.transport === 'sdk') {
      // Сервер, который CLI поднимает сам внутри себя: файла, куда его записать,
      // не существует ни у одной цели — это не потеря переноса, а свойство
      // транспорта.
      result.entries.push(emitEntry(item, verdict, 'refused_by_target', configPath));
      continue;
    }

    const draft: McpServerDraft = {
      name: item.name,
      transport: item.transport,
      ...(item.command ? { command: item.command } : {}),
      args: [...item.args],
      // Значений переменных канон не носит (инвариант 5): ключи доедут
      // окружением запуска (П3.5), и круговая проверка держит эту потерю в
      // списке ОБЪЯВЛЕННЫХ деградаций, чтобы она не была молчаливой.
      env: {},
      ...(item.url ? { url: item.url } : {}),
      headers: {},
      groupIds: [],
    };

    // Годность решает ТОТ ЖЕ проверяющий, который стоит на входе записи:
    // собственный список правил разошёлся бы с ним молча, а перенос обязан
    // назвать отказ строкой плана, а не исключением при применении.
    try {
      assertMcpDraft(draft, { currentName: item.name });
    } catch {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target', configPath));
      continue;
    }

    const already = existing.get(item.name);
    if (already && !sameServer(already, draft) && !ownedByPanel(context, item)) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', configPath));
      continue;
    }

    carried.push({ itemId: item.id, name: item.name, draft, enabled: item.enabled });
    result.entries.push(emitEntry(item, verdict, 'written', configPath));
  }

  if (carried.length > 0) {
    // Серверы пишутся по очереди, и файл перечитывается перед каждым: второй
    // видит первого и дописывается к нему.
    //
    // Как и у скиллов, «создать или заменить» решается в момент записи: после
    // первого применения сервер в файле уже есть — свой собственный, — и
    // решённое заранее «создать» уронило бы второй прогон того же плана.
    const write = (path: string, backupDir: string | undefined): void => {
      for (const server of carried) {
        const lives = readServersFromConfig(path).has(server.name);
        void saveMcpServer(path, lives ? server.name : null, server.draft, backupDir, {
          allowOverwrite: lives,
        });
        // Выключенный сервер приезжает ВЫКЛЮЧЕННЫМ (П2.6): состояние у Claude
        // файловое — запись переезжает в служебный раздел того же файла, — и
        // переносится оно тем же переключателем, которым щёлкает панель.
        // Резервная копия здесь уже не нужна: её взяла запись выше, а вторая
        // вытеснила бы историю файла из ротации.
        if (!server.enabled) void setMcpServerEnabled(path, server.name, false);
      }
    };

    result.writes.push({
      kind: 'mcpServer',
      itemIds: carried.map((server) => server.itemId),
      filePath: configPath,
      apply: (backupDir) => write(configPath, backupDir),
      applyTo: (path) => write(path, undefined),
    });
  }

  return result;
}

/**
 * Переменные окружения: блок `env` в `settings.json`. Переменная с тем же именем
 * и ДРУГИМ значением не перезаписывается — чьё значение верное, решает человек.
 */
function emitClaudeEnvVars(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is EnvVarItem => item.kind === 'envVar');
  if (items.length === 0) return result;

  const { settings, secretsEnv } = paths(context);
  const current = readSettingsEnvBlock(settings);

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    const already = current[item.name];
    if (already !== undefined && already !== item.value && !ownedByPanel(context, item)) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', settings));
      continue;
    }

    const draft = {
      key: item.name,
      value: item.value,
      source: 'settings' as const,
      isSecret: false,
    };
    result.entries.push(emitEntry(item, verdict, 'written', settings));
    result.writes.push({
      kind: 'envVar',
      itemIds: [item.id],
      filePath: settings,
      apply: (backupDir) => void saveEnvVar(settings, secretsEnv, draft, backupDir),
      applyTo: (path) => void saveEnvVar(path, secretsEnv, draft, undefined),
    });
  }

  return result;
}

/**
 * Права: списки `permissions.allow|ask|deny` в settings.json.
 *
 * Грамматика Claude И ЕСТЬ каноническая, поэтому перевод здесь тождественный —
 * и всё-таки идёт через `translatePermission`: там живут проверка «решение не
 * ослаблено» и отказ режиму целого CLI, и вторая их копия разошлась бы с первой.
 *
 * ОДНА ПРАВКА НА ВЕСЬ СЛОЙ, хотя адаптер принимает по правилу за раз: две правки
 * одного файла одним слоем каркас плана запрещает (`assertNoSilentOverwrite`),
 * да и резервная копия нужна одна — та, что снята ДО первого правила.
 */
function emitClaudePermissions(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is PermissionItem => item.kind === 'permission');
  if (items.length === 0) return result;

  const { settings } = paths(context);
  const current = readSettingsPermissions(settings);
  const drafts: PermissionDraft[] = [];

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!verdict.decision)
      throw new EmitMechanismMissingError(context.deps.target.id, 'permission');

    if (!item.enabled) {
      // Выключенное правило Claude в `settings.json` не лежит вовсе — его
      // хранит состояние панели, а записанное правило действует. Перенести его
      // значило бы включить у цели то, что человек выключил сам (П2.6).
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', settings));
      continue;
    }

    const translated = translatePermission(item, verdict.decision, context.deps.target);
    if (translated.kind === 'refused') {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target', settings));
      continue;
    }

    const clash = [...current, ...drafts].find(
      (rule) => rule.pattern === translated.rule && rule.decision !== translated.decision,
    );
    if (clash && !ownedByPanel(context, item)) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', settings));
      continue;
    }

    // Повтор того же правила с тем же решением второй записи не создаёт:
    // `savePermission` вставляет шаблон, которого в списке нет (инвариант 10).
    // Групп панели у перенесённого правила нет: это её собственная конструкция,
    // и её переносом занимается П6.2.
    drafts.push({ pattern: translated.rule, decision: translated.decision, groupIds: [] });
    result.entries.push(emitEntry(item, verdict, 'written', settings));
  }

  if (drafts.length > 0) {
    const write = (path: string, backupDir: string | undefined): void => {
      let backup = backupDir;
      for (const draft of drafts) {
        savePermission(path, null, draft, backup);
        // Копия — состояние ДО переноса, а не до последнего правила.
        backup = undefined;
      }
    };
    result.writes.push({
      kind: 'permission',
      itemIds: items.map((item) => item.id),
      filePath: settings,
      apply: (backupDir) => write(settings, backupDir),
      applyTo: (path) => write(path, undefined),
    });
  }

  return result;
}

/**
 * Права из ФАЙЛА — без `readPermissions`: тот подмешивает отметки панели
 * (выключенные правила) и требует её состояния, которого в чужом доме нет.
 */
function readSettingsPermissions(settingsPath: string): PermissionDraft[] {
  const raw = readJsonObject(settingsPath).permissions;
  if (!raw || typeof raw !== 'object') return [];
  const rules: PermissionDraft[] = [];
  for (const decision of permissionDecisions) {
    const list = (raw as Record<string, unknown>)[decision];
    if (!Array.isArray(list)) continue;
    for (const pattern of list) {
      if (typeof pattern === 'string') rules.push({ pattern, decision, groupIds: [] });
    }
  }
  return rules;
}

/** Сервер, уже лежащий в конфиге, в объёме, который сравнивает перенос. */
interface ServerShape {
  readonly transport: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly url?: string;
}

/**
 * Серверы из файла конфигурации — БЕЗ `readMcpServers`: тот требует состояние
 * панели (итоги проверок связи, группы), а перенос обязан работать и в чужом
 * доме, где состояния панели нет вовсе.
 */
function readServersFromConfig(configPath: string): Map<string, ServerShape> {
  const servers = new Map<string, ServerShape>();
  const config = readJsonObject(configPath);
  // ОБА раздела: выключенный сервер лежит в `mcpServersDisabled` того же файла и
  // для вопроса «имя занято?» ничем не отличается от включённого. Читая только
  // действующие, второй прогон того же плана пытался бы СОЗДАТЬ сервер, который
  // сам же и выключил, и адаптер отказал бы «сервер уже есть» — то есть
  // идемпотентность (инвариант 10) держалась бы ровно до первого выключенного.
  const sections = [config.mcpServers, config[DISABLED_MCP_KEY]];
  const raw = Object.assign(
    {},
    ...sections.filter((section) => section && typeof section === 'object'),
  );

  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const server = value as Record<string, unknown>;
    const command = typeof server.command === 'string' ? server.command : undefined;
    const url = typeof server.url === 'string' ? server.url : undefined;
    // Ключ `type` в файле необязателен: запись с командой — stdio, запись с
    // адресом — сетевая, и так же её прочитает сам CLI.
    const transport =
      typeof server.type === 'string' ? server.type : command !== undefined ? 'stdio' : 'http';
    const args = Array.isArray(server.args) ? server.args.filter(isText) : [];
    servers.set(name, { transport, command, url, args });
  }
  return servers;
}

/** Блок `env` файла настроек как карта. */
function readSettingsEnvBlock(settingsPath: string): Record<string, string> {
  const env = readJsonObject(settingsPath).env;
  if (!env || typeof env !== 'object') return {};
  return Object.fromEntries(Object.entries(env).filter(hasTextValue));
}

/**
 * Разобрать файл JSON цели в объект. Испорченный файл — пустой объект, а не
 * падение: план обязан построиться и назвать исход каждой записи, а откажет по
 * настоящей причине адаптер записи, когда до него дойдёт.
 */
function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readTextFile(filePath));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string';
}

function hasTextValue(entry: [string, unknown]): entry is [string, string] {
  return typeof entry[1] === 'string';
}

/** Текст файла команды Claude: шапка с описанием плюс текст запроса. */
function commandMarkdown(item: CommandItem): string {
  if (!item.description) return `${item.prompt.trim()}\n`;
  return `---\ndescription: ${yamlScalar(item.description)}\n---\n\n${item.prompt.trim()}\n`;
}

/**
 * Текст файла субагента. Ключей ровно столько, сколько несёт канон: `tools`
 * пишется только когда он в записи есть (`null` = доступны все инструменты, и
 * выписать пустой список значило бы отобрать их все), `model` — только заданная.
 */
function subagentMarkdown(item: SubagentItem, body: string): string {
  const head = [`name: ${yamlScalar(item.name)}`, `description: ${yamlScalar(item.description)}`];
  if (item.tools) head.push(`tools: ${yamlScalar(item.tools.join(', '))}`);
  // ЗАПРЕЩЁННЫЕ инструменты канон не носит, а файл источника — да. Переписать
  // файл без них значило бы ВЕРНУТЬ субагенту доступ, который человек у него
  // отнял: из всех молчаливых потерь эта единственная расширяет права, поэтому
  // ключ берётся из `raw` — ровно тот, который читает разбор самой панели.
  const disallowed = disallowedToolsOf(item.raw);
  if (disallowed) head.push(`disallowedTools: ${yamlScalar(disallowed.join(', '))}`);
  if (item.model) head.push(`model: ${yamlScalar(item.model)}`);
  // Флаг пишется, только когда он поднят: субагент без проектных инструкций —
  // другое поведение, и потерять его нельзя, но и выписывать `false` в каждый
  // файл незачем — это умолчание самого CLI.
  if (item.omitInstructions) head.push('omitClaudeMd: true');
  return `---\n${head.join('\n')}\n---\n\n${body.trim()}\n`;
}

/**
 * Запрещённые инструменты из шапки исходного файла. Ключа нет или он пуст —
 * `null`: писать пустой список незачем, это умолчание.
 */
function disallowedToolsOf(raw: string): string[] | null {
  const value = splitFrontmatter(raw).frontmatter.disallowedTools;
  const list = Array.isArray(value)
    ? value.filter(isText)
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const tools = list.map((tool) => tool.trim()).filter(Boolean);
  return tools.length > 0 ? tools : null;
}

/**
 * Скаляр YAML-шапки. Кавычки ставятся всегда: описание — чужой текст, и
 * двоеточие в нём превратило бы строку в отображение.
 */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Таймаут хука в секундах — единица Claude. Канон носит единицу вместе со
 * значением, поэтому пересчёт обязателен: число без единицы превратило бы
 * шестьдесят секунд в шестьдесят миллисекунд.
 */
function timeoutSeconds(item: HookItem): number | undefined {
  if (!item.timeout) return undefined;
  return item.timeout.unit === 's' ? item.timeout.value : Math.ceil(item.timeout.value / 1000);
}

/** Тождество хука в файле: событие, матчер и команда. Ключа у записи там нет. */
function sameHook(left: Hook, right: Hook): boolean {
  return (
    left.event === right.event &&
    (left.matcher ?? null) === (right.matcher ?? null) &&
    left.command === right.command
  );
}

/** Совпадает ли сервер, уже лежащий у Claude, с тем, что мы собираемся записать. */
function sameServer(already: ServerShape, draft: McpServerDraft): boolean {
  return (
    already.transport === draft.transport &&
    (already.command ?? null) === (draft.command ?? null) &&
    (already.url ?? null) === (draft.url ?? null) &&
    already.args.length === draft.args.length &&
    already.args.every((value, index) => value === draft.args[index])
  );
}

/**
 * Отличается ли скилл, уже лежащий у Claude, от того, что мы собираемся
 * записать. Сравниваются РАЗОБРАННЫЕ поля: чужие ключи шапки (`allowed-tools`,
 * `model`, `license`) адаптер сохраняет, и посимвольное сравнение объявило бы
 * столкновением всякий файл с ними.
 */
function differsFromSkill(filePath: string, item: SkillItem): boolean {
  const raw = readTextFile(filePath);
  const { frontmatter } = splitFrontmatter(raw);
  const description = typeof frontmatter.description === 'string' ? frontmatter.description : '';
  if (description !== item.description) return true;
  return bodyAfterFrontmatter(raw) !== item.body.trim();
}
