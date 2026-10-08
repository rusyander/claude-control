import type { Automation, Group, GroupMember, Hook, HookEvent } from '@agentdeck/contracts';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { hookContentId } from '../../lib/hook-id.ts';
import { hasAutomationMarker } from '../compiled-markers.ts';
import { applyEntityStates, rewriteHooks, type EntityToggleDeps } from '../entity-toggle.ts';
import { readHooks, writeHooks } from '../hooks/hooks.ts';
import { migrateGroupRecord } from './path-migration.ts';

/**
 * Разовый перенос автоматизаций групп в обычные хуки (решение владельца 27.09).
 *
 * Редактора автоматизаций больше нет: то, что они умели (событие + matcher +
 * команда), умеет шаг «Хук» пути группы. Сервер же продолжал собирать их в
 * settings.json хуками с меткой `# agentdeck:automation:<id>` — видными только
 * сырыми, без способа их поправить. Поэтому при старте каждая автоматизация:
 *
 * - становится обычным хуком без метки (выключенная — выключенным хуком со
 *   снимком у панели, как при любом выключении);
 * - входит участником в каждую свою группу и шагом «Хук» после стадии работы
 *   (текст шага — имя и описание, одна сторона на оба языка, «нужен перевод»);
 * - удаляется из состояния панели: сборки больше нет.
 *
 * Идемпотентно: без автоматизаций не пишется ни один файл.
 */

export interface AutomationMigrationReport {
  /** Перенесённые автоматизации. */
  migrated: string[];
  /** Группы, получившие участника и шаг. */
  groups: string[];
}

function hookOf(automation: Automation): Hook {
  const event = automation.trigger.event as HookEvent;
  const matcher = automation.trigger.matcher || undefined;
  return {
    id: hookContentId(event, matcher, automation.action.command),
    event,
    ...(matcher ? { matcher } : {}),
    command: automation.action.command,
    ...(automation.action.timeout !== undefined ? { timeout: automation.action.timeout } : {}),
    isEnabled: true,
    groupIds: [],
    source: 'settings',
  } as Hook;
}

function stepOf(automation: Automation, hookId: string, order: number, now: string): PathStep {
  const title = automation.name.trim() || automation.action.command;
  return {
    id: `automation-${automation.id}`,
    anchor: 'work',
    order,
    kind: 'resource',
    title: { ru: title, en: title },
    prompt: { ru: automation.description, en: automation.description },
    source: 'ru',
    resource: { type: 'hook', id: hookId },
    needsTranslation: true,
    createdAt: now,
  };
}

function withAutomation(group: Group, automation: Automation, hookId: string, now: string): Group {
  // Хуки автоматизаций жили в основном settings.json: у проектной группы
  // участник без области искался бы в .claude проекта.
  const member: GroupMember =
    group.scope?.kind === 'project'
      ? { kind: 'hook', id: hookId, scope: { kind: 'global' } }
      : { kind: 'hook', id: hookId };
  const members = group.members.some((item) => item.kind === 'hook' && item.id === hookId)
    ? group.members
    : [...group.members, member];
  // Путь ещё не заведён (перенос сценария не прошёл) — заводим его тем же
  // переносом, иначе шаги старого «Порядка работы» потерялись бы.
  const path = group.path ?? migrateGroupRecord(group, now)?.group.path ?? { steps: [] };
  const stepId = `automation-${automation.id}`;
  if (path.steps.some((step) => step.id === stepId)) return { ...group, members, path };
  const order =
    Math.max(-1, ...path.steps.filter((step) => step.anchor === 'work').map((step) => step.order)) +
    1;
  return {
    ...group,
    members,
    path: { ...path, steps: [...path.steps, stepOf(automation, hookId, order, now)] },
  };
}

export function migrateAutomations(
  deps: EntityToggleDeps,
  now = new Date().toISOString(),
): AutomationMigrationReport {
  const report: AutomationMigrationReport = { migrated: [], groups: [] };
  const automations = [...deps.store.getAutomations()];
  if (automations.length === 0) return report;

  const { settings } = deps.paths;
  const current = readHooks(settings, deps.store).filter(
    (hook) => !hasAutomationMarker(hook.command),
  );
  const present = new Set(current.map((hook) => hook.id));
  const converted = automations.map((automation) => ({ automation, hook: hookOf(automation) }));
  const added = converted
    .map(({ hook }) => hook)
    .filter((hook) => !present.has(hook.id) && present.add(hook.id));
  // Одна перезапись: метки сняты, хуки встали обычными записями.
  writeHooks(settings, [...current, ...added], deps.backupDir);

  const disabled = converted
    .filter(({ automation }) => !automation.isEnabled)
    .map(({ hook }) => ({ kind: 'hook' as const, id: hook.id, isEnabled: false }));
  // Как маршрут переключения: отметка, снимок команды, перезапись файла.
  for (const state of disabled) deps.store.setEnabled('hook', state.id, false);
  if (disabled.length > 0 && applyEntityStates(deps, disabled).needsHookRewrite) {
    rewriteHooks(deps);
  }

  const touched = new Map<string, Group>();
  for (const { automation, hook } of converted) {
    for (const groupId of automation.groupIds) {
      const group =
        touched.get(groupId) ?? deps.store.getGroups().find((item) => item.id === groupId);
      if (group) touched.set(groupId, withAutomation(group, automation, hook.id, now));
    }
  }
  for (const group of touched.values()) deps.store.saveGroup(group);
  report.groups = [...touched.keys()];

  for (const automation of automations) deps.store.deleteAutomation(automation.id);
  report.migrated = automations.map((automation) => automation.id);
  return report;
}
