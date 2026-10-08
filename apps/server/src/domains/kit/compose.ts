import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { copyRecursive, removeEntry, renameWithRetry } from '../../lib/safe-io/safe-io.ts';
import { kitFiles, listFiles, type KitFile } from './items.ts';

/**
 * Сборка набора, который получает прогон: встроенный набор → поверх копии
 * «моё» → минус выключенные элементы → минус проигравшие в конфликте имён.
 *
 * Собирается в данных панели, а не в приложении и не в `~/.claude`: каталог
 * приложения обновляется вместе с версией, а файлы человека набор не трогает
 * вовсе. Пересборка — только когда что-то из входа поменялось (отпечаток в
 * `.stamp`), иначе каждый ход копировал бы набор заново.
 */

export interface ComposeInput {
  builtinDir: string;
  mineDir: string;
  disabled: readonly string[];
  /** Элементы, которые в этом режиме уступают одноимённым у человека. */
  yielded: readonly string[];
  /** Готовый каталог плагина. */
  target: string;
}

/**
 * Что из «моё» попадает в сборку и без встроенного двойника: навыки (со всеми
 * соседними файлами), команды, субагенты и правила — в том числе взятые человеком
 * из глобального слоя. Хук и манифест — только поверх встроенных: новый хук без
 * записи в `hooks.json` не сработал бы, а чужой манифест ломал бы подключение.
 */
const MINE_ROOTS = /^(?:skills|commands|agents|rules)\//;

function stampOf(input: ComposeInput): string {
  const hash = createHash('sha256');
  for (const root of [input.builtinDir, input.mineDir]) {
    for (const rel of listFiles(root)) {
      const stat = statSync(join(root, rel));
      hash.update(`${root}|${rel}|${stat.size}|${stat.mtimeMs}\n`);
    }
  }
  hash.update(JSON.stringify([[...input.disabled].sort(), [...input.yielded].sort()]));
  return hash.digest('hex');
}

/** Убрать элемент из собранного каталога: навык — папкой, остальное — файлом. */
function drop(target: string, file: KitFile): void {
  removeEntry(file.kind === 'skill' ? join(target, 'skills', file.name) : join(target, file.id));
}

/**
 * Хук, снятый человеком, должен пропасть и из `hooks.json`: иначе CLI звал бы
 * отсутствующий скрипт и сыпал ошибкой на каждом вызове инструмента.
 */
function pruneHooksJson(target: string, droppedScripts: readonly string[]): void {
  const path = join(target, 'hooks', 'hooks.json');
  if (!droppedScripts.length || !existsSync(path)) return;
  let config: { hooks?: Record<string, { hooks?: { command?: string }[] }[]> };
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as typeof config;
  } catch {
    return;
  }
  const mentions = (command = ''): boolean =>
    droppedScripts.some((script) => command.includes(`/hooks/${script}`));
  for (const [event, groups] of Object.entries(config.hooks ?? {})) {
    const kept = groups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((h) => !mentions(h.command)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) config.hooks![event] = kept;
    else delete config.hooks![event];
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function composeKit(input: ComposeInput): string {
  const stamp = stampOf(input);
  const stampPath = join(input.target, '.stamp');
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === stamp) return input.target;

  // Собираем рядом и подменяем целиком: прогон, читающий набор прямо сейчас,
  // не должен увидеть полупустой каталог. Обход поштучный, не `cpSync`/`rmSync`:
  // данные панели лежат в профиле человека, а на пути с кириллицей рекурсивные
  // операции Node 24 под Windows молча ничего не делают (`safe-io/fs-entry.ts`) —
  // и каждый прогон Claude падал бы на сборке набора.
  const staging = `${input.target}.staging`;
  removeEntry(staging);
  mkdirSync(dirname(staging), { recursive: true });
  copyRecursive(input.builtinDir, staging);
  for (const rel of listFiles(input.mineDir)) {
    if (!MINE_ROOTS.test(rel) && !existsSync(join(input.builtinDir, rel))) continue;
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    copyFileSync(join(input.mineDir, rel), join(staging, rel));
  }
  // Снимаются только настоящие элементы набора: id из `state.json`, поправленного
  // руками (`skills/..`), иначе стёр бы весь каталог сборки.
  const wanted = new Set([...input.disabled, ...input.yielded]);
  const known = new Map(
    [...kitFiles(input.builtinDir), ...kitFiles(input.mineDir)].map((file) => [file.id, file]),
  );
  const removed = [...known.values()].filter((file) => wanted.has(file.id));
  for (const file of removed) drop(staging, file);
  pruneHooksJson(
    staging,
    removed.filter((file) => file.kind === 'hook').map((file) => file.name),
  );
  writeFileSync(join(staging, '.stamp'), stamp);
  removeEntry(input.target);
  renameWithRetry(staging, input.target);
  return input.target;
}

/**
 * Правила набора одним текстом: всё из `rules/`, `local.md` — только варианту
 * локальной модели и последним, как у хука `session-rules.mjs`: он сужает общие
 * правила, а не заменяет их.
 */
export function composedRules(kitDir: string, local: boolean): string {
  return listFiles(join(kitDir, 'rules'))
    .filter((name) => name.endsWith('.md') && (local || name !== 'local.md'))
    .sort((a, b) => Number(a === 'local.md') - Number(b === 'local.md') || a.localeCompare(b))
    .map((name) => readFileSync(join(kitDir, 'rules', name), 'utf8').trim())
    .filter(Boolean)
    .join('\n\n');
}

/** Имя расширения Qwen — оно же имя набора в `qwen-extension.json`. */
export const QWEN_EXTENSION = 'agentdeck-kit';

/** Что из собранного набора в расширение Qwen не едет (см. `composeQwenHome`). */
const QWEN_SKIPPED = /^(?:rules\/|\.stamp$)/;

/**
 * Команда Markdown для Qwen: `$ARGUMENTS` он оставляет как есть, аргументы
 * подставляет только в `{{args}}` — то же правило, по которому собран
 * `variants/qwen/commands` (сверено тестом, чтобы вариант и сборка не разошлись).
 */
export function qwenCommandText(text: string): string {
  return text.split('$ARGUMENTS').join('{{args}}');
}

/**
 * Каталог конфигурации Qwen Code «только набор панели»: у него нет слоя на один
 * прогон, поэтому правила — в `QWEN.md` своего `QWEN_HOME`, а навыки, команды,
 * субагенты, хуки и их инструменты — расширением `extensions/agentdeck-kit/` в
 * том же каталоге: ровно то, что кладёт туда `qwen extensions install --consent`
 * (сверено на qwen-code 0.25.0), только без вызова CLI на каждый прогон. Навыки
 * живут в расширении, а не в `skills/` дома: хуки ищут справочники правил в
 * `skills/` рядом с собой (корень набора — каталог расширения).
 *
 * `rules/` в расширение не едет: Qwen считает его условными правилами и на
 * каждом запуске ругается на правило без `paths:`; правила уже в `QWEN.md`, а
 * хук SessionStart без `rules/` отдаёт только строку с корнем набора — без
 * повтора правил. `hooks/hooks.json` берётся из собранного набора — снятый хук
 * из него уже вычищен; `${CLAUDE_PLUGIN_ROOT}` Qwen сам подставляет путём
 * расширения при загрузке.
 */
export function composeQwenHome(
  kitDir: string,
  home: string,
  local: boolean,
  variantDir: string,
): string {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'QWEN.md'), `${composedRules(kitDir, local)}\n`);
  // Прежняя раскладка клала навыки в `skills/` дома — рядом с расширением они
  // загрузились бы дважды.
  removeEntry(join(home, 'skills'));

  // Собираем рядом и подменяем целиком, как и сам набор: идущий прогон Qwen не
  // должен увидеть расширение без манифеста или с половиной хуков.
  const extension = join(home, 'extensions', QWEN_EXTENSION);
  const staging = `${extension}.staging`;
  removeEntry(staging);
  mkdirSync(staging, { recursive: true });
  for (const rel of listFiles(kitDir)) {
    if (QWEN_SKIPPED.test(rel)) continue;
    const text = rel.startsWith('commands/') && rel.endsWith('.md');
    mkdirSync(dirname(join(staging, rel)), { recursive: true });
    // Команды — из собранного набора, а не копией варианта: иначе «моё» и
    // снятая команда проиграли бы встроенному тексту варианта.
    if (text)
      writeFileSync(join(staging, rel), qwenCommandText(readFileSync(join(kitDir, rel), 'utf8')));
    else copyFileSync(join(kitDir, rel), join(staging, rel));
  }
  copyFileSync(join(variantDir, 'qwen-extension.json'), join(staging, 'qwen-extension.json'));
  removeEntry(extension);
  renameWithRetry(staging, extension);
  return home;
}
