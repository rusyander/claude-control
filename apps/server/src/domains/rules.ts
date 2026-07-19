import type { Rule, RuleDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * CLAUDE.md — обычный markdown, который читает сам Claude. Правила в нём —
 * разделы второго уровня. Разбираем файл на части, чтобы ими можно было
 * управлять поштучно, и собираем обратно так, чтобы файл остался нормальным
 * markdown: пользователь и Claude продолжают читать его как раньше.
 */

const HEADING = /^##\s+(.+)$/;
const RULE_PREFIX = /^ПРАВИЛО:\s*/i;
/** Раздел, куда складываются выключенные правила, чтобы не терять их текст. */
const DISABLED_SECTION = '## Отключённые правила (Claude Control)';

interface ParsedFile {
  preamble: string;
  rules: Rule[];
}

export function parseRules(markdown: string, scope: string, store: AppStore): ParsedFile {
  const lines = markdown.split(/\r?\n/);
  const rules: Rule[] = [];
  const preamble: string[] = [];

  let current: { title: string; body: string[] } | null = null;
  let order = 0;
  let inDisabledSection = false;
  const usedIds = new Set<string>();

  const flush = (): void => {
    if (!current) return;
    // Заголовки в файле повторяются — их пишет человек, а не программа.
    // Идентификатор при этом служит ключом для правки и удаления: с
    // одинаковыми id правка ушла бы в первое совпавшее правило, а удаление
    // вынесло бы разом все одноимённые. Поэтому повтор получает суффикс.
    const base = slugify(current.title);
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);

    rules.push({
      id,
      title: current.title,
      body: current.body.join('\n').trim(),
      order: order++,
      isEnabled: !store.isDisabled('rule', id),
      groupIds: store.getGroupIdsFor('rule', id),
      scope,
    });
    current = null;
  };

  for (const line of lines) {
    const heading = HEADING.exec(line);

    if (heading) {
      flush();
      const title = heading[1]?.trim() ?? '';
      // Служебный раздел не показываем как правило: его содержимое —
      // это правила, помеченные выключенными.
      if (line.trim() === DISABLED_SECTION) {
        inDisabledSection = true;
        continue;
      }
      inDisabledSection = false;
      current = { title: title.replace(RULE_PREFIX, ''), body: [] };
      continue;
    }

    if (current) current.body.push(line);
    else if (!inDisabledSection) preamble.push(line);
  }

  flush();

  return { preamble: preamble.join('\n').trimEnd(), rules };
}

export function serializeRules(preamble: string, rules: Rule[]): string {
  const enabled = rules.filter((rule) => rule.isEnabled);
  const disabled = rules.filter((rule) => !rule.isEnabled);

  const blocks = enabled.map((rule) => `## ПРАВИЛО: ${rule.title}\n\n${rule.body}`.trimEnd());
  const parts = [preamble.trimEnd(), ...blocks];

  if (disabled.length > 0) {
    const note =
      'Правила ниже выключены в приложении Claude Control и не действуют.\n' +
      'Включить их обратно можно там же — текст сохранён.';
    const disabledBlocks = disabled.map((rule) => `### ${rule.title}\n\n${rule.body}`.trimEnd());
    parts.push([DISABLED_SECTION, '', note, '', ...disabledBlocks].join('\n'));
  }

  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

export function readRules(claudeMdPath: string, store: AppStore): Rule[] {
  const markdown = readTextFile(claudeMdPath);
  return parseRules(markdown, 'global', store).rules;
}

export function saveRule(
  claudeMdPath: string,
  ruleId: string,
  draft: RuleDraft,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const markdown = readTextFile(claudeMdPath);
  const { preamble, rules } = parseRules(markdown, 'global', store);

  const index = rules.findIndex((rule) => rule.id === ruleId);
  const updated: Rule = {
    id: index >= 0 ? ruleId : freeId(slugify(draft.title), rules),
    title: draft.title,
    body: draft.body,
    order: index >= 0 ? (rules[index]?.order ?? rules.length) : rules.length,
    isEnabled: draft.isEnabled,
    groupIds: draft.groupIds,
    scope: 'global',
  };

  if (index >= 0) rules[index] = updated;
  else rules.push(updated);

  return writeTextFile(claudeMdPath, serializeRules(preamble, rules), { backupDir });
}

export function deleteRule(
  claudeMdPath: string,
  ruleId: string,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const markdown = readTextFile(claudeMdPath);
  const { preamble, rules } = parseRules(markdown, 'global', store);
  const remaining = rules.filter((rule) => rule.id !== ruleId);
  return writeTextFile(claudeMdPath, serializeRules(preamble, remaining), { backupDir });
}

/**
 * Свободный идентификатор: новое правило может называться так же, как уже
 * существующее, и без проверки заняло бы его ключ.
 */
function freeId(base: string, rules: readonly Rule[]): string {
  const taken = new Set(rules.map((rule) => rule.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * Слаг из заголовка. Кириллица транслитерируется — иначе id получится пустым
 * и правила перестанут различаться.
 */
function slugify(title: string): string {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'c',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };

  return title
    .toLowerCase()
    .split('')
    .map((char) => map[char] ?? char)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
