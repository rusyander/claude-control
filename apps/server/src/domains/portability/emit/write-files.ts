import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import type { CommandItem, SkillItem } from '@agentdeck/contracts/portable-env';
import { providerBackupName, readTextFile, writeTextFile } from '../../../lib/safe-io.ts';
import { bodyAfterFrontmatter } from '../markdown.ts';
import { readProviderSkillsInfo } from '../../provider-skills/read.ts';
import { saveProviderSkill } from '../../provider-skills/write.ts';
import { attachmentWrites } from './write-attachments.ts';
import {
  claimTargetFile,
  EmitMechanismMissingError,
  emitEntry,
  isSafeSegment,
  sharesLocation,
  verdictOf,
  type EmitContext,
  type StageResult,
} from './context.ts';

/**
 * Слои, которые у цели лежат ФАЙЛАМИ в каталоге: скиллы и слэш-команды.
 *
 * Общее правило обоих и всех прочих слоёв: запись с этим именем у цели уже
 * есть и она ДРУГАЯ — эмиттер её не перезаписывает, а возвращает человеку
 * выбором (`collision_needs_choice`). Инвариант 10 разрешает повтор ровно того
 * же самого, а не затирание чужой версии.
 */
export function emitFileLayers(context: EmitContext): StageResult {
  const skills = emitSkills(context);
  const commands = emitCommands(context);
  return {
    entries: [...skills.entries, ...commands.entries],
    writes: [...skills.writes, ...commands.writes],
  };
}

/** Скиллы: каталог на скилл, внутри `SKILL.md` с шапкой. */
function emitSkills(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is SkillItem => item.kind === 'skill');
  if (items.length === 0) return result;

  const target = context.targets.skills;
  const existing = target ? readProviderSkillsInfo(target) : undefined;

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;

    // Цель читает тот самый каталог, где скилл уже лежит: копия создала бы
    // второй экземпляр, который дальше разойдётся с первым правками.
    if (sharesLocation(verdict)) {
      result.entries.push(emitEntry(item, verdict, 'already_available', item.dir));
      continue;
    }
    if (!target) throw new EmitMechanismMissingError(context.deps.target.id, 'skill');

    if (!item.enabled) {
      // Формат `skill-md-dir` выключателя не имеет: записанный скилл действует.
      result.entries.push(emitEntry(item, verdict, 'disabled_at_source'));
      continue;
    }

    const dirName = item.name;
    if (!isSafeSegment(dirName)) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    const max = target.descriptionMax ?? SKILL_DESCRIPTION_LIMIT;
    if (item.description.length > max) {
      // Подрезать описание — решить за человека, что из его фразы лишнее.
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    const relative = `${dirName}/SKILL.md`;
    const filePath = join(target.skillsDir, dirName, 'SKILL.md');
    const already = existing?.skills.find((skill) => skill.name === item.name);
    // Столкновение бывает и с тем, что лежит у цели, и с записью ЭТОГО ЖЕ
    // паспорта: свой скилл и скилл из плагина носят одно имя (П2.6).
    if (
      (already && differsFromSkill(already, item)) ||
      !claimTargetFile(context, 'skill', filePath)
    ) {
      result.entries.push(emitEntry(item, verdict, 'collision_needs_choice', filePath));
      continue;
    }

    const draft = {
      path: relative,
      name: item.name,
      description: item.description,
      body: item.body,
    };
    result.entries.push(emitEntry(item, verdict, 'written', filePath));
    result.writes.push({
      kind: 'skill',
      itemIds: [item.id],
      filePath,
      // Песочница обязана сохранить `<имя скилла>/SKILL.md`: адаптер сверяет
      // имя скилла с именем его папки, и плоской копии он откажет.
      sandboxSegments: 2,
      apply: (backupDir) => void saveProviderSkill(target, draft, backupDir),
      applyTo: (path) =>
        void saveProviderSkill(
          { ...target, skillsDir: sandboxSkillsDir(path) },
          { ...draft, path: sandboxSkillPath(path) },
          undefined,
        ),
    });
    // Вложения едут ОТДЕЛЬНЫМИ правками — по файлу на дифф и по файлу на откат —
    // и ПОСЛЕ самого скилла: адаптер скилла отказывается создавать скилл в
    // каталоге, который уже существует, а первое же вложение его и создаёт.
    result.writes.push(
      ...attachmentWrites({
        item,
        targetDir: join(target.skillsDir, dirName),
        targetId: context.deps.target.id,
      }),
    );
  }

  return result;
}

/**
 * Слэш-команды: файл на команду, подкаталог даёт пространство имён.
 *
 * Адаптера записи у раздела нет — панель эти файлы сегодня только читает
 * (`domains/commands/`), — поэтому запись идёт через `lib/safe-io.ts`: бэкап,
 * атомарная запись, создание каталога при явном сохранении. Прямого
 * `writeFileSync` здесь нет и быть не может (§5.3).
 */
function emitCommands(context: EmitContext): StageResult {
  const result: StageResult = { entries: [], writes: [] };
  const items = context.items.filter((item): item is CommandItem => item.kind === 'command');
  if (items.length === 0) return result;

  const commands = context.targets.commands;

  for (const item of items) {
    const verdict = verdictOf(context, item);
    if (verdict.level !== 'native') continue;
    if (!commands) throw new EmitMechanismMissingError(context.deps.target.id, 'command');
    const config = commands.config;

    const segments = commandSegments(item, config.namespaceSeparator);
    if (!segments) {
      result.entries.push(emitEntry(item, verdict, 'refused_by_target'));
      continue;
    }

    const extension = config.format === 'toml-prompt' ? '.toml' : '.md';
    const filePath = join(commands.dir, ...segments) + extension;
    const text = config.format === 'toml-prompt' ? commandToml(item) : commandMarkdown(item);

    if (
      (existsSync(filePath) && readTextFile(filePath) !== text) ||
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
      apply: (backupDir) =>
        void writeTextFile(filePath, text, {
          backupDir,
          backupName: providerBackupName(context.deps.target.id, filePath),
        }),
      applyTo: (path) => void writeTextFile(path, text, {}),
    });
  }

  return result;
}

/**
 * Потолок описания скилла там, где документация CLI его не называет. То же
 * значение, что у раздела скиллов (`provider-skills/write.ts`): вторая копия
 * числа разошлась бы с первой молча, поэтому здесь оно названо ссылкой на ту же
 * причину, а не подобрано заново.
 */
const SKILL_DESCRIPTION_LIMIT = 1024;

/**
 * Текст команды в формате `toml-prompt` (Gemini, Qwen). Ключи — только те два,
 * что названы документацией: `description` и `prompt`.
 */
function commandToml(item: CommandItem): string {
  const table: Record<string, string> = { prompt: item.prompt };
  if (item.description) table.description = item.description;
  return `${stringifyToml(table)}\n`;
}

/** Текст команды в формате `md-frontmatter` (OpenCode). */
function commandMarkdown(item: CommandItem): string {
  if (!item.description) return `${item.prompt.trim()}\n`;
  return `---\ndescription: ${yamlScalar(item.description)}\n---\n\n${item.prompt.trim()}\n`;
}

/**
 * Скаляр YAML-шапки. Кавычки ставятся всегда: описание — чужой текст, и
 * двоеточие в нём превратило бы строку в отображение.
 */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Путь команды внутри каталога: пространство имён разворачивается в подкаталоги
 * ТОЛЬКО там, где разделитель задокументирован. Не задан → вложенность CLI не
 * разбирает, и класть файл в подкаталог значило бы придумать ему вызов.
 */
function commandSegments(item: CommandItem, separator: string | undefined): string[] | undefined {
  const names = item.namespace && separator ? item.namespace.split(separator) : [];
  const segments = [...names, item.name];
  return segments.every(isSafeSegment) ? segments : undefined;
}

/**
 * Отличается ли скилл, который уже лежит у цели, от того, что мы собираемся
 * записать. Сравниваются РАЗОБРАННЫЕ поля, а не текст файла: чужие ключи шапки
 * адаптер сохраняет, и посимвольное сравнение объявило бы столкновением всякий
 * файл с `license` или комментарием.
 */
function differsFromSkill(
  already: { fullPath: string; description?: string | undefined },
  item: SkillItem,
): boolean {
  if ((already.description ?? '') !== item.description) return true;
  return bodyAfterFrontmatter(readTextFile(already.fullPath)) !== item.body.trim();
}

/** Каталог скиллов в песочнице: копия файла лежит как `<dir>/<имя>/SKILL.md`. */
function sandboxSkillsDir(path: string): string {
  return join(path, '..', '..');
}

/** Путь скилла относительно каталога-песочницы. */
function sandboxSkillPath(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts.slice(-2).join('/');
}
