import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Group, GroupScenario, Hook, ScenarioStep } from '@claude-control/contracts';
import { writeTextFile } from '../lib/safe-io.ts';
import { slugify } from '../lib/slug.ts';
import { saveSkill, SKILLS_DISABLED_DIR } from './skills.ts';
import { readHooks, writeHooks } from './hooks.ts';
import { SCENARIO_MARKER } from './compiled-markers.ts';
import type { EntityToggleDeps } from './entity-toggle.ts';

/**
 * Сценарий группы — порядок работы над типовой задачей — в виде, который
 * понимает Claude Code.
 *
 * Хранить шаги в самой группе бесполезно: про группы Claude не знает. Поэтому
 * шаги компилируются в обычный скилл, а скилл добавляется в группу участником —
 * и гаснет вместе с ней. Так сценарий подчиняется тем же тумблеру и привязке к
 * проекту, что и остальной набор, и не требует ни одной новой сущности на
 * стороне Claude Code.
 *
 * Второй половиной идёт триггер. Описание скилла лишь ПРЕДЛАГАЕТ себя модели;
 * когда сценарий обязателен («любая задача с номером тикета делается так»),
 * этого мало. Регулярное выражение по тексту запроса компилируется в хук
 * `UserPromptSubmit` со скриптом рядом со скиллом — тем же способом, которым
 * компилируются сценарии-автоматизации, включая маркер в команде.
 */

/**
 * Метка скомпилированного триггера в команде хука — по ней он и опознаётся.
 * Живёт в `compiled-markers.ts`: её читает и `hooks.ts`, который этот модуль
 * импортирует сам. Реэкспорт — ради прежних импортов.
 */
export { SCENARIO_MARKER };

/** Имя скрипта-триггера в папке скилла. */
const TRIGGER_FILE = 'trigger.mjs';

/**
 * Слаг скилла для сценария.
 *
 * Префикс обязателен: без него сценарий с именем существующего скилла записался
 * бы поверх чужой работы. Уже скомпилированный id не пересчитывается — иначе
 * переименование группы оставляло бы на диске второй, осиротевший скилл.
 */
export function scenarioSkillId(group: Group): string {
  const compiled = group.scenario?.compiledSkillId;
  if (compiled) return compiled;

  const slug = slugify(group.name);
  return `scenario-${slug || 'group'}`;
}

/** Есть ли что компилировать: пустой сценарий скилла не заводит. */
export function hasScenario(scenario?: GroupScenario): scenario is GroupScenario {
  return Boolean(scenario && scenario.steps.some((step) => step.title.trim()));
}

/**
 * Годится ли выражение триггера. Проверяем ЗДЕСЬ, потому что цена ошибки
 * платится не здесь: сломанное выражение упало бы внутри хука, на каждом
 * запросе пользователя, стеком в контекст агента.
 */
export function isValidTrigger(pattern: string): boolean {
  if (!pattern.trim()) return true;
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

/** Тело SKILL.md из шагов сценария. */
export function buildScenarioBody(group: Group, scenario: GroupScenario): string {
  const lines: string[] = [`# ${group.name}`, ''];

  const intro = scenario.when.trim() || group.description.trim();
  if (intro) lines.push(intro, '');

  lines.push('## Порядок работы', '');

  scenario.steps.forEach((step: ScenarioStep, index: number) => {
    if (!step.title.trim()) return;
    lines.push(`### ${index + 1}. ${step.title.trim()}`, '');
    if (step.body.trim()) lines.push(step.body.trim(), '');
    // Признак выполнения — то, ради чего шаг вообще записан: без него список
    // остаётся пожеланием, которое агент считает выполненным по своему усмотрению.
    if (step.gate.trim()) lines.push(`**Готово, когда:** ${step.gate.trim()}`, '');
  });

  lines.push(
    '## Чего не делать',
    '',
    'Не переставлять шаги местами и не объявлять шаг сделанным без его признака выполнения.',
  );

  return lines.join('\n');
}

/** Где сейчас лежит папка скилла: включённый — в skills/, выключенный — рядом. */
function skillDir(skillsDir: string, id: string): string {
  const enabled = join(skillsDir, id);
  if (existsSync(enabled)) return enabled;

  const disabled = join(skillsDir, '..', SKILLS_DISABLED_DIR, id);
  return existsSync(disabled) ? disabled : enabled;
}

/**
 * Записать скилл сценария и скрипт триггера. Возвращает id скилла, чтобы
 * вызывающий сделал его участником группы, или `undefined`, если сценария нет.
 */
export function compileScenarioSkill(deps: EntityToggleDeps, group: Group): string | undefined {
  const { paths, backupDir } = deps;
  const { scenario } = group;
  if (!hasScenario(scenario)) return undefined;

  const id = scenarioSkillId(group);

  saveSkill(
    paths.skills,
    id,
    {
      name: group.name,
      // Описание решает, подключит ли Claude скилл сам, поэтому в него идёт
      // строка «когда применять», а не название группы.
      description: scenario.when.trim() || group.description.trim() || group.name,
      body: buildScenarioBody(group, scenario),
      groupIds: [group.id],
    },
    backupDir,
  );

  if (scenario.trigger.trim() && isValidTrigger(scenario.trigger)) {
    writeTextFile(join(skillDir(paths.skills, id), TRIGGER_FILE), buildTriggerScript(group, id), {
      backupDir,
    });
  }

  return id;
}

/**
 * Скрипт-триггер: читает запрос пользователя и, если тот попадает под
 * выражение, кладёт в контекст напоминание о сценарии.
 *
 * Пишется как ДАННЫЕ (`JSON.stringify`), а не склейкой строк: выражение и имена
 * приходят от человека и содержат кавычки и обратные слэши чаще, чем что-либо
 * ещё. Любая осечка внутри хука стоит стека в контексте на каждом запросе,
 * поэтому скрипт при любой беде молча выходит с нулём.
 */
export function buildTriggerScript(group: Group, skillId: string): string {
  const notice =
    `Запрос попадает под сценарий «${group.name}». ` +
    `Выполняй по шагам из ~/.claude/skills/${skillId}/SKILL.md, не пропуская признаки выполнения.`;

  return `// Сгенерировано панелью claude-control из сценария группы «${group.name}».
// Правки затираются при следующем сохранении группы — меняйте сценарий в панели.
import { readFileSync } from 'node:fs';

const TRIGGER = new RegExp(${JSON.stringify(group.scenario?.trigger ?? '')}, 'i');
const NOTICE = ${JSON.stringify(notice)};

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (TRIGGER.test(String(input.prompt ?? ''))) process.stdout.write(NOTICE);
} catch {
  // Хук не имеет права мешать работе: любая ошибка здесь — молчаливый выход.
}
`;
}

/**
 * Пересобрать хуки-триггеры по всем группам. Как и у автоматизаций, свои записи
 * узнаются по маркеру в команде, поэтому пересборка не задевает ни хуки,
 * написанные руками, ни скомпилированные автоматизации.
 *
 * Триггер ставится только у ВКЛЮЧЁННОЙ группы: выключенная не должна ничего
 * навязывать, а её скилл в этот момент и так лежит в skills-disabled/.
 */
export function compileScenarioHooks(deps: EntityToggleDeps): void {
  const { paths, store, backupDir } = deps;

  const hooks = readHooks(paths.settings, store);
  const kept = hooks.filter((hook) => !hook.command.includes(SCENARIO_MARKER));

  const compiled: Hook[] = store
    .getGroups()
    .filter(
      (group) =>
        group.isEnabled &&
        hasScenario(group.scenario) &&
        group.scenario.trigger.trim().length > 0 &&
        isValidTrigger(group.scenario.trigger),
    )
    .map((group) => {
      const id = scenarioSkillId(group);
      const script = join(skillDir(paths.skills, id), TRIGGER_FILE);

      return {
        id: `scenario:${group.id}`,
        event: 'UserPromptSubmit' as const,
        command: `node "${script}" ${SCENARIO_MARKER}:${group.id}`,
        isEnabled: true,
        groupIds: [group.id],
        // Скомпилированное всегда уходит в основной settings.json: локальный
        // файл панель не переписывает.
        source: 'settings' as const,
      };
    });

  // Ни одного триггера ни в файле, ни в группах — файл не трогаем. Иначе
  // каждый щелчок тумблера у обычной группы плодил бы резервную копию
  // settings.json на пустом месте.
  if (compiled.length === 0 && kept.length === hooks.length) return;

  writeHooks(paths.settings, [...kept, ...compiled], backupDir);
}
