import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Group } from '@agentdeck/contracts';
import { migrateScenarioSteps } from '@agentdeck/contracts/group-path';
import { readTextFile } from '../../lib/safe-io.ts';
import type { EntityToggleDeps } from '../entity-toggle.ts';
import { buildScenarioBody, hasScenario, retireScenarioHooks } from '../group-scenario.ts';
import { splitFrontmatter } from '../skills/frontmatter.ts';
import { deleteSkill } from '../skills/lifecycle.ts';
import { disabledSkillsDir } from '../skills/paths.ts';

/**
 * Перенос старого «Порядка работы» (`scenario.steps`) в «Путь» и снятие его
 * компиляции.
 *
 * Прежде шаги жили скиллом `scenario-<slug>` и хуком-триггером: модель видела
 * их подсказкой, а панель ничего не проверяла. Теперь шаги идут в конвейере
 * настоящими ходами после стадии, и старая подсказка стала бы дублем, который
 * говорит модели то же самое другими словами — и расходится при первой правке.
 *
 * Поэтому: шаги → `path.steps` (стадия `work`, «нужен перевод»), `scenario`
 * остаётся в записи читаемым (одну версию, для отката), скомпилированный скилл
 * удаляется С КОПИЕЙ — но только если он ровно тот, что панель собрала. Скилл,
 * который человек правил или дополнил файлами, — уже его работа: он остаётся
 * на месте и участником группы. Хуки-триггеры снимаются все: их компиляция
 * больше не идёт, и триггер без скилла отказывал бы в каждом сообщении.
 *
 * Идемпотентно: у группы с `path` переносить нечего, и вызов без переносов не
 * пишет ни одного файла — ни state.json, ни settings.json.
 */

export interface PathMigrationReport {
  /** Группы, чьи шаги перенесены. */
  migrated: string[];
  /** Удалённые скомпилированные скиллы (копия снята). */
  removedSkills: string[];
  /** Скомпилированные скиллы, оставленные на месте: их правили руками. */
  keptSkills: string[];
}

/** Где лежит папка скилла сейчас: включённый или выключенный. */
function skillDirOf(skillsDir: string, id: string): string | undefined {
  for (const dir of [join(skillsDir, id), join(disabledSkillsDir(skillsDir), id)]) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

/**
 * Скилл ровно тот, что собрала панель: в папке только SKILL.md (и, может быть,
 * скрипт триггера), а тело совпадает со сборкой сценария. Любое отличие — это
 * чья-то правка, и удалять её панель не вправе.
 */
export function isUntouchedScenarioSkill(dir: string, group: Group): boolean {
  if (!group.scenario) return false;
  const files = readdirSync(dir);
  if (files.some((name) => name !== 'SKILL.md' && name !== 'trigger.mjs')) return false;
  const skillFile = join(dir, 'SKILL.md');
  if (!existsSync(skillFile)) return false;
  const { body } = splitFrontmatter(readTextFile(skillFile));
  return body.trim() === buildScenarioBody(group, group.scenario).trim();
}

/** Одна группа: новая запись и что сделать со скомпилированным скиллом. */
export function migrateGroupRecord(
  group: Group,
  now: string,
): { group: Group; compiledSkillId?: string } | undefined {
  if (group.path !== undefined) return undefined;
  const compiledSkillId = group.scenario?.compiledSkillId;
  if (!hasScenario(group.scenario) && !compiledSkillId) return undefined;

  const steps = migrateScenarioSteps(
    group.scenario,
    now,
    (index) => `scenario-${group.id.slice(0, 8)}-${index}`,
  );
  return {
    group: { ...group, path: { steps } },
    compiledSkillId,
  };
}

/**
 * Перенос одной группы вместе со снятием её скомпилированного скилла — общий
 * для запуска и для сохранения старой формы. Раньше сохранение переносило
 * только шаги: скилл-дубль оставался, а запуск эту группу (путь уже есть)
 * больше не трогал (F-259). `compiledFrom` — запись, по которой собирался
 * скилл: при правке это сохранённая группа, а не присланная форма.
 */
export function migrateGroupWithSkill(
  deps: EntityToggleDeps,
  group: Group,
  now: string,
  compiledFrom: Group = group,
): { group: Group; removedSkill?: string; keptSkill?: string } | undefined {
  const next = migrateGroupRecord(group, now);
  if (!next) return undefined;
  const skillId = next.compiledSkillId;
  const dir = skillId ? skillDirOf(deps.paths.skills, skillId) : undefined;
  if (!skillId || !dir) return { group: next.group };
  if (!isUntouchedScenarioSkill(dir, compiledFrom))
    return { group: next.group, keptSkill: skillId };
  // Копия ДО удаления: откат — через историю копий, как у любого скилла.
  deleteSkill(deps.paths.skills, skillId, deps.backupDir);
  deps.store.removeEntity('skill', skillId);
  const record = next.group;
  return {
    group: {
      ...record,
      members: record.members.filter(
        (member) => !(member.kind === 'skill' && member.id === skillId),
      ),
      scenario: record.scenario ? { ...record.scenario, compiledSkillId: undefined } : undefined,
    },
    removedSkill: skillId,
  };
}

export function migrateGroupPaths(
  deps: EntityToggleDeps,
  now = new Date().toISOString(),
): PathMigrationReport {
  const report: PathMigrationReport = { migrated: [], removedSkills: [], keptSkills: [] };

  for (const group of deps.store.getGroups()) {
    const next = migrateGroupWithSkill(deps, group, now);
    if (!next) continue;
    if (next.removedSkill) report.removedSkills.push(next.removedSkill);
    if (next.keptSkill) report.keptSkills.push(next.keptSkill);
    deps.store.saveGroup(next.group);
    report.migrated.push(group.id);
  }

  if (report.migrated.length > 0) retireScenarioHooks(deps);
  return report;
}
