import { join } from 'node:path';
import type { Group, GroupMember, Hook } from '@agentdeck/contracts';
import type { MemberAdvice } from '@agentdeck/contracts/group-sources';
import { memberAdviceSchema } from '@agentdeck/contracts/group-sources';
import {
  readGroupSources,
  updateGroupSources,
  type PendingAdvice,
} from '../../lib/app-store/group-sources.ts';
import { hookContentId } from '../../lib/hook-id.ts';
import { writeTextFile } from '../../lib/safe-io.ts';
import { maskSecretsInText, restoreMaskedSecrets } from '../../lib/secret-mask.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { readHooks, writeHooks } from '../hooks.ts';
import { deleteMcpServer, saveMcpServer } from '../mcp.ts';
import { readRules, deleteRule, freeRuleTitle, ruleByTitle, saveRule } from '../rules.ts';
import { readSkills } from '../skills/read.ts';
import { deleteSkill } from '../skills/lifecycle.ts';
import { readJsonBlock } from './answer-block.ts';
import { ruleDraftOf } from './copy.ts';
import { GroupRequestError } from './errors.ts';
import { memberContent, memberKey, parseMemberKey, skillDirFor } from './members.ts';
import { singleTurn, type GroupAsk } from './model.ts';
import { originChangedOf, originText } from './views.ts';

/**
 * Советы агента по участникам глобальной копии — после копирования («взять
 * наш / улучшить / оставить») и при слиянии с ушедшим вперёд оригиналом.
 * Модель только предлагает: ничего не пишется, пока человек не отметил пункты
 * и не нажал «Применить», и правки ложатся ТОЛЬКО в глобальную копию.
 */

export const ADVICE_BLOCK_KIND = 'group-advice';
export const MERGE_BLOCK_KIND = 'group-merge';

type Copied = { kind: GroupMember['kind']; id: string; text: string };

/** Общие ресурсы одной строкой — модель выбирает «наш» только из них. */
export function globalCatalog(deps: EntityToggleDeps, exclude: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const skill of readSkills(deps.paths.skills, deps.store)) {
    if (!exclude.has(`skill:${skill.id}`)) lines.push(`- skill ${skill.id}: ${skill.description}`);
  }
  for (const rule of readRules(deps.paths.claudeMd, deps.store)) {
    if (!exclude.has(`rule:${rule.id}`)) lines.push(`- rule ${rule.id}: ${rule.title}`);
  }
  for (const hook of readHooks(deps.paths.settings, deps.store)) {
    if (!exclude.has(`hook:${hook.id}`)) {
      lines.push(
        maskSecretsInText(`- hook ${hook.id}: ${hook.event} ${hook.command}`).slice(0, 200),
      );
    }
  }
  return lines.join('\n') || '(none)';
}

/**
 * Ответ модели → советы: только по названным участникам, `ours` — только на
 * существующий общий ресурс того же вида, `improve` — только с текстом.
 */
export function parseAdvice(
  reply: string,
  kind: string,
  allowed: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): MemberAdvice[] | undefined {
  const parsed = readJsonBlock(reply, kind) as { advice?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.advice)) return undefined;
  const seen = new Set<string>();
  const items: MemberAdvice[] = [];
  for (const raw of parsed.advice) {
    const result = memberAdviceSchema.safeParse(raw);
    if (!result.success) continue;
    const item = result.data;
    const key = memberKey(item);
    if (!allowed.has(key) || seen.has(key)) continue;
    if (item.verdict === 'ours' && !existing.has(`${item.kind}:${item.replacement ?? ''}`))
      continue;
    if (item.verdict === 'improve' && !item.replacement?.trim()) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

function existingKeys(deps: EntityToggleDeps): Set<string> {
  return new Set([
    ...readSkills(deps.paths.skills, deps.store).map((skill) => `skill:${skill.id}`),
    ...readRules(deps.paths.claudeMd, deps.store).map((rule) => `rule:${rule.id}`),
    ...readHooks(deps.paths.settings, deps.store).map((hook) => `hook:${hook.id}`),
  ]);
}

function savePending(appData: string, groupId: string, pending: PendingAdvice): void {
  updateGroupSources(appData, (state) => {
    if (pending.items.length === 0) delete state.advice[groupId];
    else state.advice[groupId] = pending;
  });
}

/**
 * Советы после копирования. Модель не ответила или ответила нечитаемо — советов
 * нет, копия уже готова, но `failed` говорит об этом: пустой список без него
 * читался как «модель посмотрела, советовать нечего».
 */
export async function adviseCopy(
  deps: EntityToggleDeps,
  ask: GroupAsk,
  prompt: string,
  group: Group,
  copied: readonly Copied[],
): Promise<{ items: MemberAdvice[]; failed: boolean }> {
  if (copied.length === 0) return { items: [], failed: false };
  const own = new Set(copied.map((item) => memberKey(item)));
  const data = [
    'Copied members:',
    ...copied.map(
      (item) => `### ${item.kind} ${item.id}\n${maskSecretsInText(item.text).slice(0, 12_000)}`,
    ),
    '',
    'Existing global resources:',
    globalCatalog(deps, own),
  ].join('\n');
  let parsed: MemberAdvice[] | undefined;
  try {
    const reply = await ask(singleTurn(prompt, data), 'default');
    const existing = existingKeys(deps);
    for (const key of own) existing.delete(key);
    parsed = parseAdvice(reply, ADVICE_BLOCK_KIND, own, existing);
  } catch {
    parsed = undefined;
  }
  const items = parsed ?? [];
  const actionable = items.filter((item) => item.verdict !== 'keep');
  savePending(deps.paths.appData, group.id, {
    mode: 'copy',
    items: actionable,
    at: new Date().toISOString(),
  });
  return { items, failed: parsed === undefined };
}

/**
 * Предложение слияния: по каждому ушедшему вперёд участнику — BASE (оригинал
 * при копировании), OURS (копия сейчас), THEIRS (проект сейчас).
 */
export async function adviseMerge(
  deps: EntityToggleDeps,
  ask: GroupAsk,
  prompt: string,
  group: Group,
): Promise<MemberAdvice[]> {
  if (!group.origin) {
    throw new GroupRequestError(409, 'group_origin_missing', 'group-origin-missing');
  }
  const bases = readGroupSources(deps.paths.appData).bases[group.id] ?? {};
  const changed = originChangedOf(deps, deps.store.getGroups(), group);
  const theirs: NonNullable<PendingAdvice['theirs']> = {};
  const sections: string[] = [];
  for (const fromKey of changed) {
    const toKey = bases[fromKey]?.to ?? fromKey;
    const to = parseMemberKey(toKey);
    const ours = to ? memberContent(deps, { kind: 'global' }, to) : undefined;
    const current = originText(deps, group, fromKey);
    if (!to || !ours || current === undefined) continue;
    const content = memberContent(deps, group.origin.scope, parseMemberKey(fromKey)!);
    // Текст ждёт в файле состояния и уходит модели основой следующего слияния:
    // значения env/заголовков MCP и токены команд туда не попадают.
    theirs[toKey] = { hash: content?.hash ?? '', text: maskSecretsInText(current), from: fromKey };
    sections.push(
      [
        `### ${to.kind} ${to.id}`,
        `BASE:\n${maskSecretsInText(bases[fromKey]?.text ?? '(missing)')}`,
        `OURS:\n${maskSecretsInText(ours.text)}`,
        `THEIRS:\n${maskSecretsInText(current)}`,
      ].join('\n\n'),
    );
  }
  if (sections.length === 0) return [];

  const reply = await ask(singleTurn(prompt, sections.join('\n\n')), 'default');
  const items = parseAdvice(reply, MERGE_BLOCK_KIND, new Set(Object.keys(theirs)), new Set());
  if (!items) throw new GroupRequestError(502, 'model_unreadable', 'group-model-unreadable');
  savePending(deps.paths.appData, group.id, {
    mode: 'merge',
    items: items.filter((item) => item.verdict === 'improve'),
    theirs,
    at: new Date().toISOString(),
  });
  return items;
}

/** Переписать ресурс копии новым текстом; вернуть его id (у хука он из содержимого). */
function rewrite(deps: EntityToggleDeps, kind: string, id: string, text: string): string {
  if (kind === 'skill') {
    // Туда, где скилл лежит: у выключенного это `skills-disabled/`. Запись в
    // `skills/` дала бы вторую, включённую копию — Claude её видит, а включение
    // группы падает на переносе папки поверх (как `saveSkill`).
    const dir = skillDirFor(deps.paths, { kind: 'global' }, id) ?? join(deps.paths.skills, id);
    writeTextFile(join(dir, 'SKILL.md'), text, { backupDir: deps.backupDir });
    return id;
  }
  if (kind === 'rule') {
    const draft = ruleDraftOf(id, text);
    // Заголовок пишет модель: занятый другим правилом оставляет прежний — тёзка
    // сдвигал id соседей, и участник группы уезжал на чужое правило.
    const rules = readRules(deps.paths.claudeMd, deps.store);
    const own = rules.find((rule) => rule.id === id);
    const taken = ruleByTitle(rules, draft.title);
    const title =
      !taken || taken.id === id ? draft.title : (own?.title ?? freeRuleTitle(rules, draft.title));
    saveRule(
      deps.paths.claudeMd,
      id,
      { title, body: draft.body, isEnabled: true, groupIds: [] },
      deps.store,
      deps.backupDir,
    );
    return ruleByTitle(readRules(deps.paths.claudeMd, deps.store), title)?.id ?? id;
  }
  if (kind === 'hook') {
    const raw = JSON.parse(text) as { event: Hook['event']; matcher?: string; command: string };
    const next = hookContentId(raw.event, raw.matcher, raw.command);
    // Только три поля: `source`, `isEnabled`, `groupIds`, `id` модели не принадлежат.
    const rewritten = (hook: Hook): Hook => ({
      ...hook,
      event: raw.event,
      command: raw.command,
      ...(raw.matcher === undefined ? { matcher: undefined } : { matcher: raw.matcher }),
      id: next,
    });
    const hooks = readHooks(deps.paths.settings, deps.store);
    const own = hooks.find((hook) => hook.id === id);
    if (own && !own.isEnabled) {
      // Выключенного хука в settings.json нет, а `writeHooks` выключенные не
      // пишет: новая команда не легла бы никуда. Меняем снимок — с ним хук и
      // вернётся в файл при включении.
      deps.store.pruneDisabledHooks([id]);
      deps.store.rememberDisabledHook(rewritten(own));
    } else {
      writeHooks(
        deps.paths.settings,
        hooks.map((hook) => (hook.id === id ? rewritten(hook) : hook)),
        deps.backupDir,
      );
    }
    // id хука — из содержимого: отметки выключения и состав всех групп уезжают
    // на новый, иначе висели бы на id, которого больше нет нигде.
    deps.store.renameEntity('hook', id, next);
    return next;
  }
  if (kind === 'mcp') {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const draft = {
      name: id,
      transport: (raw.type as 'stdio' | 'sse' | 'http' | undefined) ?? (raw.url ? 'http' : 'stdio'),
      ...(typeof raw.command === 'string' ? { command: raw.command } : {}),
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
      env: (raw.env as Record<string, string>) ?? {},
      headers: (raw.headers as Record<string, string>) ?? {},
      groupIds: [],
    };
    saveMcpServer(deps.paths.mcpConfig, id, draft, deps.backupDir, { allowOverwrite: true });
    return id;
  }
  return id;
}

/** Снять скопированный ресурс (с копией): его место занимает «наш». */
function removeCopied(deps: EntityToggleDeps, kind: string, id: string): void {
  if (kind === 'skill') deleteSkill(deps.paths.skills, id, deps.backupDir);
  else if (kind === 'rule') deleteRule(deps.paths.claudeMd, id, deps.store, deps.backupDir);
  else if (kind === 'hook') {
    const hooks = readHooks(deps.paths.settings, deps.store).filter((hook) => hook.id !== id);
    // Хук выключенной группы лежит снимком, а `removeEntity` ниже стирает его
    // отметку выключения: без чистки снимка он читался бы ВКЛЮЧЁННЫМ призраком
    // и вернулся бы в файл со следующей записью хуков (F-114, как `deleteHook`).
    deps.store.pruneDisabledHooks([id]);
    writeHooks(deps.paths.settings, hooks, deps.backupDir);
  } else if (kind === 'mcp') deleteMcpServer(deps.paths.mcpConfig, id, deps.backupDir);
  deps.store.removeEntity(kind as never, id);
}

/**
 * Замена от модели в форме, которую `rewrite` запишет: хук — объект с `event` и
 * `command` (плюс необязательный `matcher`), MCP — объект с `command` или `url`,
 * скилл и правило — непустой текст. `undefined` — читать нечего.
 */
function readableReplacement(kind: string, text: string): string | undefined {
  if (kind === 'skill' || kind === 'rule') return text.trim() ? text : undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const filled = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== '';
  if (kind === 'hook') {
    if (!filled(record.event) || !filled(record.command)) return undefined;
    if (record.matcher !== undefined && typeof record.matcher !== 'string') return undefined;
    return JSON.stringify({
      event: record.event,
      ...(record.matcher === undefined ? {} : { matcher: record.matcher }),
      command: record.command,
    });
  }
  if (kind === 'mcp') return filled(record.command) || filled(record.url) ? text : undefined;
  return undefined;
}

/**
 * Замена от модели с настоящими значениями вместо масок. Источники — то, что
 * модель видела: копия сейчас, а при слиянии ещё оригинал (секрет мог прийти из
 * любого) и оба вместе. `undefined` — маску не с чем сопоставить.
 */
function unmaskedReplacement(
  deps: EntityToggleDeps,
  group: Group,
  pending: PendingAdvice,
  item: { kind: string; id: string },
  replacement: string,
): string | undefined {
  const member = parseMemberKey(memberKey(item));
  const ours = member ? (memberContent(deps, { kind: 'global' }, member)?.text ?? '') : '';
  const from = pending.theirs?.[memberKey(item)]?.from;
  const theirs = pending.mode === 'merge' && from ? originText(deps, group, from) : undefined;
  const sources = theirs === undefined ? [ours] : [ours, theirs, `${ours}\n${theirs}`];
  for (const source of sources) {
    const text = restoreMaskedSecrets(source, replacement);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Применить отмеченные советы. Каждый пункт правит ТОЛЬКО глобальную копию;
 * применённые уходят из ожидающих, неотмеченные остаются.
 */
export function applyAdvice(
  deps: EntityToggleDeps,
  group: Group,
  picked: readonly { kind: string; id: string }[],
): Group {
  const pending = readGroupSources(deps.paths.appData).advice[group.id];
  if (!pending || pending.items.length === 0) {
    throw new GroupRequestError(409, 'advice_empty', 'group-advice-empty');
  }
  const wanted = new Set(picked.map((item) => memberKey(item)));
  // Ни один отмеченный не ждёт применения — отказ, а не 200 с пересохранением
  // группы без единой правки (F-221).
  if (!pending.items.some((item) => wanted.has(memberKey(item)))) {
    throw new GroupRequestError(409, 'advice_empty', 'group-advice-empty');
  }
  let members = [...group.members];
  let origin = group.origin;
  const applied = new Set<string>();
  const reused = new Set(
    Object.values(readGroupSources(deps.paths.appData).bases[group.id] ?? {})
      .filter((base) => base.reused)
      .map((base) => base.to),
  );
  // Модель видела текст с маской — замена возвращается к настоящим значениям по
  // тексту, который она видела. Не выходит — отказ ДО первой записи: маска в
  // хуке или MCP вместо токена сломала бы ресурс молча.
  const restored = new Map<string, string>();
  for (const item of pending.items) {
    const key = memberKey(item);
    if (!wanted.has(key) || item.verdict !== 'improve' || !item.replacement) continue;
    const text = unmaskedReplacement(deps, group, pending, item, item.replacement);
    if (text === undefined) {
      throw new GroupRequestError(409, 'advice_masked', 'group-advice-masked');
    }
    // Разбор тоже до первой записи: SyntaxError посреди прохода оставлял копию
    // наполовину применённой (скилл уже удалён, замены нет).
    const checked = readableReplacement(item.kind, text);
    if (checked === undefined) {
      throw new GroupRequestError(502, 'model_unreadable', 'group-model-unreadable');
    }
    restored.set(key, checked);
  }

  for (const item of pending.items) {
    const key = memberKey(item);
    if (!wanted.has(key)) continue;
    const at = members.findIndex((member) => memberKey(member) === key);
    if (item.verdict === 'ours' && item.replacement) {
      // Удаляется только созданное копией: переиспользованный общий ресурс жил до
      // неё — группа просто перестаёт на него ссылаться.
      if (!reused.has(key)) removeCopied(deps, item.kind, item.id);
      const replacement = { kind: item.kind as GroupMember['kind'], id: item.replacement };
      members = members.filter((member) => memberKey(member) !== key);
      if (!members.some((member) => memberKey(member) === memberKey(replacement))) {
        members.splice(at < 0 ? members.length : at, 0, replacement);
      }
    } else if (item.verdict === 'improve' && item.replacement) {
      const nextId = rewrite(deps, item.kind, item.id, restored.get(key) ?? item.replacement);
      if (at >= 0) members[at] = { ...members[at]!, id: nextId };
      const their = pending.theirs?.[key];
      if (pending.mode === 'merge' && their && origin) {
        // Слито — новая точка отсчёта: «изменилось» гаснет, основа слияния — оригинал сейчас.
        origin = { ...origin, memberHashes: { ...origin.memberHashes, [their.from]: their.hash } };
        updateGroupSources(deps.paths.appData, (state) => {
          const bases = (state.bases[group.id] ??= {});
          bases[their.from] = { to: `${item.kind}:${nextId}`, text: their.text };
        });
      }
    }
    applied.add(key);
  }

  const saved = deps.store.saveGroup({ ...group, members, ...(origin ? { origin } : {}) });
  savePending(deps.paths.appData, group.id, {
    ...pending,
    items: pending.items.filter((item) => !applied.has(memberKey(item))),
  });
  return saved;
}
