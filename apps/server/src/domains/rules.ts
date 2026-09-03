import type { Rule, RuleDraft } from '@claude-control/contracts';
import { RULE_HEADING, RULE_PREFIX, DISABLED_SECTION } from '@claude-control/contracts/rule-format';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { slugify } from '../lib/slug.ts';
import type { AppStore } from '../lib/app-store.ts';

/**
 * CLAUDE.md — обычный markdown, который читает сам Claude. Правила в нём —
 * разделы второго уровня. Разбираем файл на части, чтобы ими можно было
 * управлять поштучно, и собираем обратно так, чтобы файл остался нормальным
 * markdown: пользователь и Claude продолжают читать его как раньше.
 */

/**
 * Заголовок правила — только «## ПРАВИЛО: …» (`RULE_HEADING`). Прочие h2
 * (`## Обзор`) и любые под-заголовки (`##`/`###`) внутри тела правилами НЕ
 * считаются: иначе сборка навесила бы им префикс «ПРАВИЛО:» и молча испортила
 * соседний markdown, а граница правила рвалась бы о разметку в его же теле.
 * Сами выражения лежат в `contracts/rule-format`: той же линейкой клиент
 * считает обычные разделы, объясняя «0 правил» в непустом файле.
 */
/** Заголовок выключенного правила внутри служебного раздела — на уровень глубже. */
const DISABLED_HEADING = /^###\s+(.+)$/;

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
  /** Разбирается ли сейчас правило из служебного раздела выключенных. */
  let isCurrentDisabled = false;
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
      // Правило из служебного раздела выключено по самому факту нахождения
      // там: отметка в состоянии панели могла и не сохраниться.
      isEnabled: !isCurrentDisabled && !store.isDisabled('rule', id),
      groupIds: store.getGroupIdsFor('rule', id),
      scope,
    });
    current = null;
    isCurrentDisabled = false;
  };

  for (const line of lines) {
    // Служебный раздел выключенных: его заголовок — обычный h2, но правилом он
    // не является. Внутри лежат правила, помеченные `### …`.
    if (line.trim() === DISABLED_SECTION) {
      flush();
      inDisabledSection = true;
      continue;
    }

    // Новое правило начинается ТОЛЬКО с «## ПРАВИЛО:». Любой другой заголовок
    // (обычная секция или разметка внутри тела) правилом не считается и потому
    // не рвёт текущее правило и не обрастёт префиксом при сборке.
    const ruleHeading = RULE_HEADING.exec(line);
    if (ruleHeading) {
      flush();
      inDisabledSection = false;
      current = { title: ruleHeading[1]?.trim() ?? '', body: [] };
      continue;
    }

    /**
     * Правила внутри служебного раздела тоже разбираем.
     *
     * Раньше содержимое раздела пропускалось целиком, и выключенное правило
     * пропадало из списка. А `serializeRules` пересобирает раздел заново из
     * того же списка — значит следующая же перезапись файла стирала текст
     * правила навсегда, хотя выключение обещает обратное. Потеря обнаружена
     * на живом CLAUDE.md.
     */
    if (inDisabledSection) {
      const subHeading = DISABLED_HEADING.exec(line);
      if (subHeading) {
        flush();
        current = { title: (subHeading[1]?.trim() ?? '').replace(RULE_PREFIX, ''), body: [] };
        isCurrentDisabled = true;
        continue;
      }
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

  const serialized = serializeRules(preamble, rules);
  const backupPath = writeTextFile(claudeMdPath, serialized, { backupDir });

  // Отметки переносим ПОСЛЕ успешной записи: не записалось — состояние панели
  // должно остаться от прежнего файла.
  migrateRuleIds(rules, store);

  return backupPath;
}

/**
 * Пакетное переключение правил: `CLAUDE.md` читается ОДИН раз и переписывается
 * ОДИН раз, сколько бы правил ни переключали. Нужно групповому тумблеру: раньше
 * группа из двадцати правил давала двадцать чтений и двадцать перезаписей файла
 * с ротацией резервной копии на каждой.
 *
 * И дело не только в лишней работе. Id правила выводится из его заголовка при
 * КАЖДОМ разборе файла, а порядок вывода — сперва включённые, потом выключенные
 * (см. `migrateRuleIds`). Поэтому у двух правил с ОДИНАКОВЫМ заголовком гашение
 * первого меняло местами id обоих: `тест` ↔ `тест-2`. Поштучный проход брал
 * следующий id из списка, составленного ДО перезаписи, и попадал уже в другое
 * правило — второе одноимённое правило группа не гасила. Один разбор на всю
 * пачку эту гонку убирает: идентификаторы разрешаются один раз, до записи.
 *
 * Правила, которых нет в файле, молча пропускаются: состав группы мог отстать
 * от диска. Ничего не изменилось — файл не трогаем вовсе.
 */
export function setRulesEnabled(
  claudeMdPath: string,
  states: ReadonlyMap<string, boolean>,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const markdown = readTextFile(claudeMdPath);
  const { preamble, rules } = parseRules(markdown, 'global', store);

  const updated = rules.map((rule) => {
    const isEnabled = states.get(rule.id);
    return isEnabled === undefined ? rule : { ...rule, isEnabled };
  });

  // Сравниваем итоговый ТЕКСТ, а не флаги: `parseRules` отдаёт `isEnabled` уже с
  // учётом отметки в состоянии панели, а её вызывающий ставит ДО применения —
  // по флагу выходило бы «ничего не изменилось» ровно тогда, когда правило и
  // надо перенести. Текст же врать не может: совпал — писать нечего.
  const serialized = serializeRules(preamble, updated);
  if (serialized === markdown) return undefined;

  const backupPath = writeTextFile(claudeMdPath, serialized, { backupDir });

  // Отметки переносим ПОСЛЕ успешной записи — как и в `saveRule`.
  migrateRuleIds(updated, store);

  return backupPath;
}

/**
 * Перенос отметок правил на идентификаторы, которые получатся при следующем
 * чтении файла.
 *
 * У правила нет собственного ключа на диске: id выводится из заголовка при
 * каждом разборе CLAUDE.md. Значит правка заголовка меняет id, и всё, что
 * записано по старому (ручное выключение, гашение группой, состав групп),
 * осталось бы висеть на несуществующем правиле: правило теряло значок группы,
 * групповой переключатель переставал его находить, а мусор в state.json жил бы
 * вечно. Скиллы этот перенос делают явно (`renameSkill` → `store.renameEntity`),
 * правилам он был нужен не меньше.
 *
 * Новые id не угадываем и не вычитываем обратно из файла: считаем их тем же
 * правилом, что и разборщик (slugify заголовка + суффикс `-2` при повторе) в
 * том же порядке, в каком их пишет сборка — сперва включённые, потом
 * выключенные. Прежний вариант сверял свой список с повторным разбором
 * записанного текста и молча отказывался при расхождении длин: тело правила с
 * собственной строкой «## ПРАВИЛО:» дробится при разборе на два — и отметки
 * оставались висеть на несуществующем id.
 *
 * Переносим в два прохода через временные id. Переименования могут меняться
 * местами (два правила с заголовком «Тест»: `тест` ↔ `тест-2`), и
 * последовательный перенос затёр бы отметки первого вторым — временный id
 * разводит их во времени.
 */
function migrateRuleIds(written: readonly Rule[], store: AppStore): void {
  const emitted = [
    ...written.filter((rule) => rule.isEnabled),
    ...written.filter((rule) => !rule.isEnabled),
  ];

  const used = new Set<string>();
  const pairs: Array<{ oldId: string; newId: string }> = [];
  for (const rule of emitted) {
    const base = slugify(rule.title);
    let newId = base;
    for (let n = 2; used.has(newId); n += 1) newId = `${base}-${n}`;
    used.add(newId);
    if (rule.id !== newId) pairs.push({ oldId: rule.id, newId });
  }
  if (pairs.length === 0) return;

  // Временное имя нарочно не похоже на slug правила: пересечься с настоящим id
  // оно не может, а значит и затереть чужие отметки на промежуточном шаге.
  const stamp = `~migrate-${process.pid}`;
  pairs.forEach((pair, at) => store.renameEntity('rule', pair.oldId, `${stamp}-${at}`));
  pairs.forEach((pair, at) => store.renameEntity('rule', `${stamp}-${at}`, pair.newId));
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

  const serialized = serializeRules(preamble, remaining);
  const backupPath = writeTextFile(claudeMdPath, serialized, { backupDir });

  // Удаление тоже сдвигает id: из двух тёзок («foo», «foo-2») уцелевший станет
  // «foo». Без переноса его отметки остались бы на «foo-2».
  migrateRuleIds(remaining, store);

  return backupPath;
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
