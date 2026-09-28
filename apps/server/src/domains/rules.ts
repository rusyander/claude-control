import type { Rule, RuleDraft } from '@agentdeck/contracts';
import {
  RULE_HEADING,
  RULE_PREFIX,
  isDisabledSectionHeading,
} from '@agentdeck/contracts/rule-format';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { slugify } from '../lib/slug.ts';
import { coded } from '../lib/server-text.ts';
import type { AppStore, DisabledRuleSnapshot } from '../lib/app-store.ts';

/**
 * CLAUDE.md — обычный markdown, который читает сам Claude. Правила в нём —
 * разделы второго уровня. Разбираем файл на части, чтобы ими можно было
 * управлять поштучно, и собираем обратно так, чтобы файл остался нормальным
 * markdown: пользователь и Claude продолжают читать его как раньше.
 *
 * В файле лежат ТОЛЬКО включённые правила. Выключенное убирается из CLAUDE.md
 * целиком (решение владельца 27.09, F1): Claude Code читает файл полностью, и
 * текст «выключенного» правила стоил бы токенов на каждом ходе и всё равно
 * доходил бы до модели. Текст и место выключенного правила хранит состояние
 * панели (`AppStore.getDisabledRules`); включение возвращает правило на его
 * прежнее место (F2), а не в конец файла.
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
  /** Место выключенных правил из состояния панели: id правила → запись. */
  stored: Map<string, DisabledRuleSnapshot>;
  /** id правил из прежнего служебного раздела файла (до F1 выключенные жили там). */
  legacy: Set<string>;
}

/**
 * Разбор CLAUDE.md плюс выключенные правила из состояния панели (`stored`).
 *
 * Id выводится из заголовка в порядке «включённые из файла → прежний служебный
 * раздел → выключенные из состояния»; тот же порядок повторяет `migrateRuleIds`
 * после записи, иначе отметки уехали бы на чужое правило.
 */
export function parseRules(
  markdown: string,
  scope: string,
  store: AppStore,
  stored: readonly DisabledRuleSnapshot[] = [],
): ParsedFile {
  const lines = markdown.split(/\r?\n/);
  const rules: Rule[] = [];
  const preamble: string[] = [];
  const storedById = new Map<string, DisabledRuleSnapshot>();
  const legacy = new Set<string>();

  let current: { title: string; body: string[] } | null = null;
  let order = 0;
  let inDisabledSection = false;
  /** Разбирается ли сейчас правило из служебного раздела выключенных. */
  let isCurrentDisabled = false;
  const usedIds = new Set<string>();

  // Заголовки в файле повторяются — их пишет человек, а не программа.
  // Идентификатор при этом служит ключом для правки и удаления: с
  // одинаковыми id правка ушла бы в первое совпавшее правило, а удаление
  // вынесло бы разом все одноимённые. Поэтому повтор получает суффикс.
  const push = (title: string, body: string, isDisabled: boolean): Rule => {
    const base = slugify(title);
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}-${n}`;
    usedIds.add(id);
    const rule: Rule = {
      id,
      title,
      body,
      order: order++,
      isEnabled: !isDisabled && !store.isDisabled('rule', id),
      groupIds: store.getGroupIdsFor('rule', id),
      scope,
    };
    rules.push(rule);
    return rule;
  };

  const flush = (): void => {
    if (!current) return;
    // Правило из служебного раздела выключено по самому факту нахождения
    // там: отметка в состоянии панели могла и не сохраниться.
    const rule = push(current.title, current.body.join('\n').trim(), isCurrentDisabled);
    if (isCurrentDisabled) legacy.add(rule.id);
    current = null;
    isCurrentDisabled = false;
  };

  for (const line of lines) {
    // Служебный раздел выключенных (так их хранили до F1): его заголовок —
    // обычный h2, но правилом он не является. Внутри лежат правила `### …`.
    // Панель этот раздел больше не пишет, но читает: он есть в файлах людей,
    // и первая же запись переносит его правила в состояние панели.
    if (isDisabledSectionHeading(line.trim())) {
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
     * пропадало из списка, а следующая перезапись файла стирала его текст
     * навсегда. Потеря обнаружена на живом CLAUDE.md.
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

  // Правило, которое снова лежит в файле с тем же текстом (файл вернули из
  // «Истории», вставили руками), — уже не выключенное: второй экземпляр из
  // состояния дал бы тёзку-призрака. Такая запись пропускается и исчезает из
  // состояния при следующей записи. Правило прежнего служебного раздела тоже
  // лежит в файле: старая копия из «Истории» несёт выключенное именно там.
  const inFile = new Set(rules.map((rule) => `${rule.title}\n${rule.body}`));
  for (const snapshot of stored) {
    if (inFile.has(`${snapshot.title}\n${snapshot.body.trim()}`)) continue;
    const rule = push(snapshot.title, snapshot.body.trim(), true);
    storedById.set(rule.id, snapshot);
  }

  return { preamble: preamble.join('\n').trimEnd(), rules, stored: storedById, legacy };
}

/** Текст CLAUDE.md: шапка и включённые правила. Выключенных в файле нет (F1). */
export function serializeRules(preamble: string, rules: readonly Rule[]): string {
  const blocks = rules
    .filter((rule) => rule.isEnabled)
    .map((rule) => `## ПРАВИЛО: ${rule.title}\n\n${rule.body}`.trimEnd());
  const parts = [preamble.trimEnd(), ...blocks];
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

/**
 * Полный порядок правил: включённые в порядке файла, выключенные — на своих
 * местах (F2).
 *
 * Место выключенного записано соседями в ПОЛНОМ порядке, а не только среди
 * включённых: иначе два подряд выключенных правила (B, затем C из «A B C D»)
 * оба запомнили бы «после A» и вернулись бы переставленными. Сосед может сам
 * быть выключенным — тогда правило ждёт, пока место соседа определится.
 * Соседа нет вовсе (удалён, переименован руками в файле) — пробуем второго,
 * затем позицию; правило из прежнего служебного раздела места не знает и
 * встаёт в конец, как и лежало.
 */
export function arrangeRules(parsed: Pick<ParsedFile, 'rules' | 'stored'>): Rule[] {
  const order = parsed.rules.filter((rule) => !parsed.stored.has(rule.id));
  // Правила прежнего служебного раздела уже в `order` — в конце, за включёнными.
  let pending = parsed.rules.filter((rule) => parsed.stored.has(rule.id));
  // Сосед по заголовку — ближайший к прежней позиции: тёзки с диска разрешены
  // (D-A), и первое вхождение ставило правило за чужим тёзкой (F-166).
  const nearest = (title: string, target: number): number => {
    let best = -1;
    order.forEach((rule, at) => {
      if (rule.title !== title) return;
      if (best < 0 || Math.abs(at - target) < Math.abs(best - target)) best = at;
    });
    return best;
  };

  const placeOf = (snapshot: DisabledRuleSnapshot, strict: boolean): number | undefined => {
    const waiting = (title: string): boolean => pending.some((rule) => rule.title === title);
    if (snapshot.after === null) return strict ? 0 : undefined;
    const afterAt = nearest(snapshot.after, snapshot.index - 1);
    if (afterAt >= 0) return afterAt + 1;
    if (strict && waiting(snapshot.after)) return undefined;
    if (snapshot.before === null) return strict ? undefined : order.length;
    const beforeAt = nearest(snapshot.before, snapshot.index);
    if (beforeAt >= 0) return beforeAt;
    if (strict) return undefined;
    return Math.min(Math.max(snapshot.index, 0), order.length);
  };

  for (const strict of [true, false]) {
    let moved = true;
    while (moved && pending.length > 0) {
      moved = false;
      for (const rule of [...pending]) {
        const snapshot = parsed.stored.get(rule.id);
        const at = snapshot ? placeOf(snapshot, strict) : order.length;
        if (at === undefined) continue;
        order.splice(at, 0, rule);
        pending = pending.filter((item) => item !== rule);
        moved = true;
      }
    }
  }
  return order;
}

export function readRules(claudeMdPath: string, store: AppStore): Rule[] {
  return loadRules(claudeMdPath, store).rules;
}

interface LoadedRules extends ParsedFile {
  markdown: string;
}

function loadRules(claudeMdPath: string, store: AppStore): LoadedRules {
  const markdown = readTextFile(claudeMdPath);
  return { markdown, ...parseRules(markdown, 'global', store, store.getDisabledRules()) };
}

/**
 * Заголовок уже занят другим правилом — отказ (решение владельца 27.09, D-A).
 *
 * Два правила с одним заголовком читаются моделью как одно правило в двух
 * редакциях, а в панели различаются только суффиксом id. Отказ жёсткий на
 * создании и переименовании; тёзки, уже лежащие в файле, читаются и правятся
 * как прежде (иначе новый валидатор отказал бы тому, что уже на диске).
 */
export class RuleTitleTakenError extends Error {
  readonly statusCode = 409;
  readonly code = 'rule_title_taken';

  constructor(title: string) {
    super(`Правило «${title}» уже есть — выберите другой заголовок`);
    coded(this, 'rule-title-taken', { title });
  }
}

/** Сравнение заголовков: без регистра и лишних пробелов — «Тест» и «тест » одно имя. */
function sameTitle(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return norm(a) === norm(b);
}

/**
 * Проверка D-A для создания (`ruleId` пустой) и правки. Правка без смены
 * заголовка проходит всегда — даже у тёзки, который уже лежал в файле.
 */
export function assertRuleTitleFree(rules: readonly Rule[], ruleId: string, title: string): void {
  const current = rules.find((rule) => rule.id === ruleId);
  if (current && sameTitle(current.title, title)) return;
  const taken = rules.find((rule) => rule.id !== ruleId && sameTitle(rule.title, title));
  if (taken) throw new RuleTitleTakenError(taken.title);
}

/**
 * Свободный заголовок для правила, которое панель пишет сама (копия группы):
 * занятый получает суффикс «Название (2)», «(3)» — решение владельца 27.09.
 * Тёзка в файле сдвигает id соседей при каждом разборе, поэтому дубль не пишем.
 */
export function freeRuleTitle(rules: readonly Rule[], title: string): string {
  const taken = (candidate: string): boolean =>
    rules.some((rule) => sameTitle(rule.title, candidate));
  if (!taken(title)) return title;
  let index = 2;
  while (taken(`${title} (${index})`)) index += 1;
  return `${title} (${index})`;
}

/** Правило с этим заголовком (без регистра и лишних пробелов). */
export function ruleByTitle(rules: readonly Rule[], title: string): Rule | undefined {
  return rules.find((rule) => sameTitle(rule.title, title));
}

export function saveRule(
  claudeMdPath: string,
  ruleId: string,
  draft: RuleDraft,
  store: AppStore,
  backupDir?: string,
): string | undefined {
  const loaded = loadRules(claudeMdPath, store);
  const order = arrangeRules(loaded);

  const index = order.findIndex((rule) => rule.id === ruleId);
  const updated: Rule = {
    id: index >= 0 ? ruleId : freeId(slugify(draft.title), order),
    title: draft.title,
    body: draft.body,
    order: index >= 0 ? (order[index]?.order ?? order.length) : order.length,
    isEnabled: draft.isEnabled,
    groupIds: draft.groupIds,
    scope: 'global',
  };

  // Правка — на своём месте: включение выключенного правила возвращает его
  // туда, где оно стояло (F2). Новое правило — в конец.
  if (index >= 0) order[index] = updated;
  else order.push(updated);

  return writeRules(claudeMdPath, loaded, order, store, backupDir, 'always');
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
  const loaded = loadRules(claudeMdPath, store);
  const updated = arrangeRules(loaded).map((rule) => {
    const isEnabled = states.get(rule.id);
    return isEnabled === undefined ? rule : { ...rule, isEnabled };
  });

  // Сравниваем итоговый ТЕКСТ, а не флаги: `parseRules` отдаёт `isEnabled` уже с
  // учётом отметки в состоянии панели, а её вызывающий ставит ДО применения —
  // по флагу выходило бы «ничего не изменилось» ровно тогда, когда правило и
  // надо перенести. Текст же врать не может: совпал — писать нечего.
  return writeRules(claudeMdPath, loaded, updated, store, backupDir, 'if-changed');
}

/**
 * Записать полный порядок: включённые — в CLAUDE.md, выключенные — в
 * состояние панели вместе с их местом.
 *
 * Состояние пишется ДО файла и откатывается, если файл записать не вышло: в
 * обратном порядке сбой между двумя записями оставил бы правило ни там, ни
 * там — выключение стало бы удалением.
 *
 * Файл пишется, только когда его текст другой: правка выключенного правила
 * CLAUDE.md не меняет вовсе, и копия того же текста в «Истории» была бы шумом.
 * `if-changed` (пакетный тумблер) вдобавок не трогает ни отметки, ни состояние,
 * если не сдвинулось ничего.
 */
function writeRules(
  claudeMdPath: string,
  loaded: LoadedRules,
  order: readonly Rule[],
  store: AppStore,
  backupDir: string | undefined,
  mode: 'always' | 'if-changed',
): string | undefined {
  const serialized = serializeRules(loaded.preamble, order);
  const snapshots = snapshotsOf(order);
  const previous = store.getDisabledRules();
  const stateChanged = JSON.stringify(previous) !== JSON.stringify(snapshots);
  const fileChanged = serialized !== loaded.markdown;
  if (!fileChanged && !stateChanged && mode === 'if-changed') return undefined;

  if (stateChanged) store.setDisabledRules(snapshots);
  let backupPath: string | undefined;
  if (fileChanged) {
    try {
      backupPath = writeTextFile(claudeMdPath, serialized, { backupDir });
    } catch (error) {
      if (stateChanged) store.setDisabledRules(previous);
      throw error;
    }
  }

  // Отметки переносим ПОСЛЕ успешной записи: не записалось — состояние панели
  // должно остаться от прежнего файла.
  migrateRuleIds(
    [...order.filter((rule) => rule.isEnabled), ...order.filter((rule) => !rule.isEnabled)],
    store,
  );
  return backupPath;
}

/** Выключенные правила с их местом в полном порядке — в порядке этого порядка. */
function snapshotsOf(order: readonly Rule[]): DisabledRuleSnapshot[] {
  return order.flatMap((rule, index) =>
    rule.isEnabled
      ? []
      : [
          {
            title: rule.title,
            body: rule.body,
            after: order[index - 1]?.title ?? null,
            before: order[index + 1]?.title ?? null,
            index,
          },
        ],
  );
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
 * том же порядке, в каком их выдаст следующий разбор, — `emitted`: сперва
 * включённые в порядке файла, потом выключенные в порядке состояния. Прежний
 * вариант сверял свой список с повторным разбором записанного текста и молча
 * отказывался при расхождении длин: тело правила с собственной строкой
 * «## ПРАВИЛО:» дробится при разборе на два — и отметки оставались висеть на
 * несуществующем id.
 *
 * Переносим в два прохода через временные id. Переименования могут меняться
 * местами (два правила с заголовком «Тест»: `тест` ↔ `тест-2`), и
 * последовательный перенос затёр бы отметки первого вторым — временный id
 * разводит их во времени.
 */
function migrateRuleIds(emitted: readonly Rule[], store: AppStore): void {
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
  const loaded = loadRules(claudeMdPath, store);
  // Удаление тоже сдвигает id: из двух тёзок («foo», «foo-2») уцелевший станет
  // «foo». Без переноса (`writeRules`) его отметки остались бы на «foo-2».
  const remaining = arrangeRules(loaded).filter((rule) => rule.id !== ruleId);
  return writeRules(claudeMdPath, loaded, remaining, store, backupDir, 'always');
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
