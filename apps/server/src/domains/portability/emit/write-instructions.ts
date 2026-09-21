import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { EnvItem } from '@agentdeck/contracts/portable-env';
import { providerBackupName, readTextFile, writeTextFile } from '../../../lib/safe-io.ts';
import {
  readProviderInstructionsEntries,
  saveProviderInstructionsEntries,
} from '../../provider-instructions.ts';
import { readProviderRulesInfo } from '../../provider-rules/read.ts';
import { saveProviderRule } from '../../provider-rules/write.ts';
import { bodyAfterFrontmatter } from '../markdown.ts';
import {
  EmitMechanismMissingError,
  emitEntry,
  isSafeSegment,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';
import { blockOf, isEnabled, spliceBlock, textOf } from './text-block.ts';

/**
 * Слой инструкций — и он же единственный приёмник уровня «текстом».
 *
 * Уровень Т означает соблюдение вместо вызова: механизма у цели нет, и запись
 * превращается в инструкцию модели. Поэтому скилл, команда и хук, которым
 * приговор вынес `text`, приезжают сюда же, а не теряются между слоями: это
 * ровно то, о чём говорит §2 плана, и записывается оно в тот же файл, который
 * цель читает как свои инструкции.
 *
 * Моделей приёмника три, и различает их каталог, а не идентификатор CLI: один
 * файл (`instructionsFile`), каталог правил (`instructionsRules`) или список
 * ссылок в конфиге (`instructionsList`).
 */
export function emitInstructionsLayer(context: EmitContext): StageResult {
  const carried = context.items.filter((item) => {
    const verdict = verdictOf(context, item);
    if (verdict.level === 'text') return true;
    return item.kind === 'instructions' && verdict.level === 'native';
  });
  if (carried.length === 0) return { entries: [], writes: [] };

  const { target } = context.deps;
  if (context.targets.instructionsRules) return asRules(context, carried);
  if (context.targets.instructionsFile) return asSingleFile(context, carried);
  if (context.targets.instructionsList) return asListedFile(context, carried);
  throw new EmitMechanismMissingError(target.id, 'instructions');
}

/**
 * Каталог правил (Cursor, Continue): каждая запись — свой файл `.mdc`. Тело
 * пишет адаптер раздела, он же хранит чужие ключи шапки и отказывается
 * переписывать файл, который не разобрал.
 */
function asRules(context: EmitContext, items: readonly EnvItem[]): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const target = context.targets.instructionsRules;
  if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'instructions');

  const info = readProviderRulesInfo(target);
  const used = new Set<string>();

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (!isEnabled(item)) {
      // Выключенное правило приехало бы действующим: у `.mdc` выключателя нет.
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source'));
      continue;
    }

    const name = ruleFileName(item);
    if (!name) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }
    if (used.has(name)) {
      // Два правила с одним именем файла — столкновение, и решает его человек.
      // Молча записать оба значило бы отчитаться, что доехали оба, оставив у
      // цели только последнее.
      result.entries.push(
        emitEntry(item, verdict, 'collision_needs_choice', join(target.rulesDir, `${name}.mdc`)),
      );
      continue;
    }
    used.add(name);

    const relativePath = `${name}.mdc`;
    const fullPath = join(target.rulesDir, relativePath);
    const body = textOf(item);
    const already = info.rules.find((rule) => rule.path === relativePath);
    if (already && bodyAfterFrontmatter(readTextFile(already.fullPath)) !== body.trim()) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', fullPath));
      continue;
    }

    const draft = { path: relativePath, description: item.intent, body };
    result.entries.push(emitEntry(item, verdict, 'written', fullPath));
    result.writes.push({
      kind: 'instructions',
      itemIds: [item.id],
      filePath: fullPath,
      apply: (backupDir) => void saveProviderRule(target, draft, backupDir),
      applyTo: (path) =>
        void saveProviderRule(
          { ...target, rulesDir: join(path, '..') },
          { ...draft, path: basename(path) },
          undefined,
        ),
    });
  }

  return result;
}

/**
 * Один файл инструкций (`AGENTS.md`, `GEMINI.md`, …).
 *
 * Файл чужой и написан человеком, поэтому панель занимает в нём ОБЛАСТЬ между
 * метками и не трогает ничего снаружи: перезапись файла целиком стёрла бы его
 * собственный текст, а дописывание в конец на каждом применении плана
 * наращивало бы копии (инвариант 10 требует обратного).
 */
function asSingleFile(context: EmitContext, items: readonly EnvItem[]): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const target = context.deps.target;
  const filePath = context.targets.instructionsFile;
  if (!filePath) throw new EmitMechanismMissingError(target.id, 'instructions');

  const carried = collect(context, items, result, filePath);
  if (carried.length === 0) return result;

  const block = blockOf(carried.map((item) => textOf(item)));
  const write = (path: string, backupDir: string | undefined): void => {
    const original = existsSync(path) ? readTextFile(path) : '';
    void writeTextFile(path, spliceBlock(original, block), {
      backupDir,
      backupName: providerBackupName(target.id, path),
    });
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

/**
 * Список ссылок в конфиге (Aider `~/.aider.conf.yml`): панель кладёт СВОЙ файл
 * рядом с конфигом и добавляет ссылку на него. Чужие записи списка остаются на
 * месте — их ведёт человек.
 */
function asListedFile(context: EmitContext, items: readonly EnvItem[]): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const target = context.targets.instructionsList;
  if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'instructions');

  const filePath = join(target.baseDir, CARRIED_FILE_NAME);
  const carried = collect(context, items, result, filePath);
  if (carried.length === 0) return result;

  const block = blockOf(carried.map((item) => textOf(item)));
  const entries = readProviderInstructionsEntries(target).map((entry) => entry.raw);
  const reference = relative(target.baseDir, filePath).replace(/\\/g, '/');
  const nextEntries = entries.includes(reference) ? entries : [...entries, reference];

  // ДВЕ правки, а не одна на два файла: своим файлом запись не действует, пока
  // на него нет ссылки, и соблазн записать оба из одного места велик. Но правка
  // плана — это ОДИН файл: правка, тронувшая второй, не попадает ни в дифф
  // предпросмотра (человек не видит, что панель правит его конфиг), ни в след
  // отмены (возвращать этот файл будет нечем). Ровно так ссылка на наш файл
  // оставалась в `~/.aider.conf.yml` после отмены переноса.
  result.writes.push({
    kind: 'instructions',
    itemIds: carried.map((item) => item.id),
    filePath,
    apply: (backupDir) => {
      const original = existsSync(filePath) ? readTextFile(filePath) : '';
      void writeTextFile(filePath, spliceBlock(original, block), {
        backupDir,
        backupName: providerBackupName(target.provider.id, filePath),
      });
    },
    applyTo: (path) => {
      const original = existsSync(path) ? readTextFile(path) : '';
      void writeTextFile(path, spliceBlock(original, block), {});
    },
  });
  result.writes.push({
    // Тот же вид: ссылка — часть той же записи инструкций, просто в другом
    // файле. Проверка «один слой пишет в один файл один раз» считает пару
    // «вид + путь», и два разных файла ей не мешают.
    kind: 'instructions',
    itemIds: carried.map((item) => item.id),
    filePath: target.configPath,
    apply: (backupDir) => saveProviderInstructionsEntries(target, nextEntries, backupDir),
    applyTo: (path) =>
      saveProviderInstructionsEntries(
        { ...target, configPath: path, backupName: undefined },
        nextEntries,
        undefined,
      ),
  });
  return result;
}

/** Имя файла, который панель кладёт рядом с конфигом цели со списком ссылок. */
const CARRIED_FILE_NAME = 'agentdeck-portability.md';

/**
 * Отобрать записи, которые действительно лягут в файл, и сразу назвать исход
 * остальных. Выключенная запись не едет: у плоского текста выключателя нет, и
 * приехав, она стала бы действующей.
 */
function collect(
  context: EmitContext,
  items: readonly EnvItem[],
  result: StageResult,
  filePath: string,
): EnvItem[] {
  const carried: EnvItem[] = [];
  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (!isEnabled(item)) {
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source', filePath));
      continue;
    }
    carried.push(item);
    result.entries.push(emitEntry(item, verdict, 'written', filePath));
  }
  return carried;
}

/**
 * Имя файла правила из записи. Небезопасное имя — отказ, а не «поправленное»:
 * угадывать за человека, как назвать его правило, панель не станет.
 */
function ruleFileName(item: EnvItem): string | undefined {
  const raw =
    item.kind === 'instructions'
      ? instructionsRuleName(item.fileName)
      : 'name' in item
        ? item.name
        : item.id;
  const name = raw.trim();
  return isSafeSegment(name) ? name : undefined;
}

/**
 * Имя файла правила из имени файла инструкций: `CLAUDE.md` → `CLAUDE`, а
 * `CLAUDE.md#po-russki` → `CLAUDE-po-russki`.
 *
 * Раздел `## ПРАВИЛО:` — ОТДЕЛЬНАЯ запись канона, живущая в том же файле, что и
 * сам файл инструкций. Имя, собранное из одного расширения, делало их
 * тёзками: у цели оставалось последнее, а план отчитывался, что доехали оба.
 */
function instructionsRuleName(fileName: string): string {
  const [file = '', section] = fileName.split('#');
  const base = file.replace(/\.[^.]+$/, '');
  return section ? `${base}-${section}` : base;
}
