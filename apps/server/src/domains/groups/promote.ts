import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, GroupMember, GroupScope, Hook } from '@agentdeck/contracts';
import { scopeOf, scopeProvider } from '@agentdeck/contracts/group-sources';
import { CLAUDE_HOOK_EVENTS } from '@agentdeck/contracts/vocabulary';
import type { PathPromoteNamedRequest } from '@agentdeck/contracts/group-describe';
import type { PathStep } from '@agentdeck/contracts/group-path';
import { hookContentId } from '../../lib/hook-id.ts';
import { writeTextFile } from '../../lib/safe-io.ts';
import { slugify } from '../../lib/slug.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { reconcileMembers } from '../group-toggle.ts';
import { normalizeScriptName } from '../hook-scripts.ts';
import { readHooks, readHooksFromFiles, writeHooks } from '../hooks.ts';
import { assertRuleTitleFree, readRules, saveRule } from '../rules.ts';
import { createScript, ScriptExistsError, UnsafeScriptPathError } from '../scripts.ts';
import { splitFrontmatter } from '../skills/frontmatter.ts';
import { saveSkill, SkillExistsError } from '../skills/write.ts';
import { GroupRequestError } from './errors.ts';
import { projectClaudeDir } from './members.ts';

/**
 * «Сделать ресурсом»: шаг «Пути» становится настоящим ресурсом через обычные
 * писатели сущностей (с копией до записи), ресурс входит в группу участником,
 * а шаг — ссылкой на него (`kind: 'resource'`). Свой писатель здесь означал бы
 * файл, который страница скиллов или хуков читает не так, как пишет.
 *
 * Куда писать, решает область группы: у глобальной — общие каталоги, у
 * проектной — `.claude` её проекта (план: «проектная группа правит файлы своего
 * проекта»). Прежде проектная писала в общие: хук шага группы одного проекта
 * срабатывал во всех.
 */

/** Куда ложатся ресурсы шага: общие каталоги или `.claude` проекта группы. */
interface PromoteTargets {
  skills: string;
  hooksDir: string;
  /** Проектная — файлы её проекта; у общей — `undefined`. */
  project?: { root: string; settings: string; local: string; rules: string };
}

function targetsOf(deps: EntityToggleDeps, scope: GroupScope): PromoteTargets {
  if (scope.kind !== 'project') return { skills: deps.paths.skills, hooksDir: deps.paths.hooks };
  const dir = projectClaudeDir(scope.path);
  return {
    skills: join(dir, 'skills'),
    hooksDir: join(dir, 'hooks'),
    project: {
      root: scope.path,
      settings: join(dir, 'settings.json'),
      local: join(dir, 'settings.local.json'),
      rules: join(dir, 'rules'),
    },
  };
}

const invalid = (detail: string): GroupRequestError =>
  new GroupRequestError(400, 'promote_invalid', 'group-promote-invalid', { detail });

function promoteSkill(
  deps: EntityToggleDeps,
  targets: PromoteTargets,
  step: PathStep,
  draft: string,
): string {
  const { frontmatter, body } = splitFrontmatter(draft);
  const name =
    typeof frontmatter.name === 'string' && frontmatter.name.trim()
      ? frontmatter.name.trim()
      : slugify(step.title.en || step.title.ru) || step.id;
  const description =
    typeof frontmatter.description === 'string' && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : step.title.en || step.title.ru || name;
  try {
    saveSkill(
      targets.skills,
      null,
      { name, description, body: body.trim() || draft.trim(), groupIds: [] },
      deps.backupDir,
    );
  } catch (error) {
    if (error instanceof SkillExistsError) {
      throw new GroupRequestError(409, 'resource_exists', 'group-promote-invalid', {
        detail: error.skillId,
      });
    }
    throw error;
  }
  return slugify(name);
}

function promoteRule(
  deps: EntityToggleDeps,
  targets: PromoteTargets,
  step: PathStep,
  draft: string,
): string {
  const title = step.title.en || step.title.ru || step.id;
  if (targets.project) return promoteProjectRule(deps, targets.project.rules, step, title, draft);
  const rules = readRules(deps.paths.claudeMd, deps.store);
  // D-A: создание правила с занятым заголовком — отказ, как в редакторе правил.
  assertRuleTitleFree(rules, '', title);
  const before = new Set(rules.map((rule) => rule.id));
  saveRule(
    deps.paths.claudeMd,
    '',
    { title, body: draft.trim(), isEnabled: true, groupIds: [] },
    deps.store,
    deps.backupDir,
  );
  const added = readRules(deps.paths.claudeMd, deps.store).find((rule) => !before.has(rule.id));
  if (!added) throw invalid('rule not written');
  return added.id;
}

/**
 * Правило проекта — файл `.claude/rules/<id>.md`, как их и читает состав
 * проектной группы; CLAUDE.md проекта не трогается. Занятое имя — отказ, а не
 * запись поверх чужого правила.
 */
function promoteProjectRule(
  deps: EntityToggleDeps,
  rulesDir: string,
  step: PathStep,
  title: string,
  draft: string,
): string {
  // Заголовок без латиницы/цифр даёт пустой слаг, и прежде именем файла
  // становился `step.id` как есть — строка клиента, `../../x` писал мимо
  // `.claude/rules`. Теперь и он проходит через слаг.
  const id = slugify(title) || slugify(step.id);
  if (!id) throw invalid('rule name');
  const file = join(rulesDir, `${id}.md`);
  if (existsSync(file)) {
    throw new GroupRequestError(409, 'resource_exists', 'group-promote-invalid', { detail: id });
  }
  mkdirSync(rulesDir, { recursive: true });
  writeTextFile(file, `# ${title}\n\n${draft.trim()}\n`, { backupDir: deps.backupDir });
  return id;
}

function promoteHook(deps: EntityToggleDeps, targets: PromoteTargets, draft: string): string {
  let raw: { event?: unknown; matcher?: unknown; command?: unknown };
  try {
    raw = JSON.parse(draft) as typeof raw;
  } catch {
    throw invalid('hook draft is not JSON');
  }
  const event = CLAUDE_HOOK_EVENTS.find((item) => item.name === raw.event)?.name as
    Hook['event'] | undefined;
  if (!event) throw invalid('hook event');
  if (typeof raw.command !== 'string' || !raw.command.trim()) throw invalid('hook command');
  const matcher = typeof raw.matcher === 'string' && raw.matcher ? raw.matcher : undefined;
  const id = hookContentId(event, matcher, raw.command);
  const project = targets.project;
  // Хуки проекта читаются как лежат в его файлах — без отметок панели этой машины.
  const hooks = project
    ? readHooksFromFiles(project.settings, project.local, project.root)
    : readHooks(deps.paths.settings, deps.store);
  if (!hooks.some((hook) => hook.id === id)) {
    const hook: Hook = {
      id,
      event: event,
      ...(matcher ? { matcher } : {}),
      command: raw.command,
      isEnabled: true,
      groupIds: [],
      source: 'settings',
    };
    writeHooks(project ? project.settings : deps.paths.settings, [...hooks, hook], deps.backupDir);
  }
  return id;
}

/**
 * Скрипт — файл каталога скриптов (`hooks/`) тем же писателем, что страница
 * скриптов. Имя — `name` запроса, иначе из заголовка шага; всегда `.mjs`.
 * Участником группы скрипт не становится: у группы нет такого вида участника,
 * шаг ссылается на файл сам.
 */
function promoteScript(
  targets: PromoteTargets,
  step: PathStep,
  draft: string,
  name: string | undefined,
): string {
  const id = normalizeScriptName(name ?? (slugify(step.title.en || step.title.ru) || step.id));
  try {
    createScript(targets.hooksDir, id, draft.endsWith('\n') ? draft : `${draft}\n`);
  } catch (error) {
    if (error instanceof ScriptExistsError) {
      throw new GroupRequestError(409, 'resource_exists', 'group-promote-invalid', { detail: id });
    }
    if (error instanceof UnsafeScriptPathError) throw invalid('script name');
    throw error;
  }
  return id;
}

export function promotePathStep(
  deps: EntityToggleDeps,
  group: Group,
  request: PathPromoteNamedRequest,
): Group {
  const steps = group.path?.steps ?? [];
  const step = steps.find((item) => item.id === request.stepId);
  if (!step) throw new GroupRequestError(404, 'step_not_found', 'group-path-step-not-found');

  // Уже ресурс — второй раз не создаём: прежде рядом с первым появлялся второй
  // ресурс, а первый оставался участником без шага.
  if (step.kind === 'resource') {
    throw new GroupRequestError(409, 'step_already_resource', 'group-promote-invalid', {
      detail: step.resource?.id ?? step.id,
    });
  }

  const scope = scopeOf(group);
  // Раскладка ресурсов здесь — Claude'овская (`.claude/*`); у проекта другой CLI
  // её никто не прочтёт. Как у переопределения (`group-sources-routes.ts`) — отказ.
  if (scope.kind === 'project' && scopeProvider(scope) !== 'claude') {
    throw new GroupRequestError(409, 'promote_claude_only', 'group-promote-invalid', {
      detail: 'Claude only',
    });
  }
  const targets = targetsOf(deps, scope);
  const writers = {
    skill: () => promoteSkill(deps, targets, step, request.draft),
    rule: () => promoteRule(deps, targets, step, request.draft),
    hook: () => promoteHook(deps, targets, request.draft),
    script: () => promoteScript(targets, step, request.draft, request.name),
  };
  const id = writers[request.type]();

  // Участник проектной группы — файл её проекта: без `scope` состав искал бы его в общих.
  const member: GroupMember | undefined =
    request.type === 'script'
      ? undefined
      : { kind: request.type, id, ...(scope.kind === 'project' ? { scope } : {}) };
  const members =
    !member || group.members.some((item) => item.kind === member.kind && item.id === member.id)
      ? group.members
      : [...group.members, member];
  const next: Group = {
    ...group,
    members,
    path: {
      steps: steps.map((item) =>
        item.id === step.id
          ? { ...item, kind: 'resource' as const, resource: { type: request.type, id } }
          : item,
      ),
    },
  };
  const saved = deps.store.saveGroup(next);
  // Новый участник выключенной группы гаснет вместе с ней — как любой другой.
  // Проектного участника (со `scope`) удержание не касается: отметки общие, по
  // id, и погасили бы общего тёзку (`collectLeafMembers` его пропускает).
  reconcileMembers(deps, saved, group.members);
  return saved;
}
