import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Group, GroupMember } from '@agentdeck/contracts';
import type { GroupPathView, PathStep } from '@agentdeck/contracts/group-path';
import { definePanelAction, type InjectRoute } from './registry.ts';
import {
  card,
  encode,
  readRoute,
  routeError,
  routeFingerprint,
  stateCard,
} from './action-kit/action-kit.ts';
import { groupDraft, groupInput } from './actions-app/actions-app.ts';
import { bilingualField, bothSides, type BilingualText } from './texts/texts.ts';

/**
 * Черновик сценария одной карточкой: группа с `flow: 'scenario'`, чьи шаги по
 * порядку — вся работа. Шаг — готовый ресурс тех же видов, что предлагает
 * конструктор окна (скилл, правило, хук, утилита: шаг-ресурс, а скилл, правило
 * и хук — ещё и участники), или свой текст на двух языках. Создаётся
 * выключенным и теми же маршрутами окна: `POST /api/groups`, затем
 * `PUT …/path/steps`.
 */

/** Все шаги сценария — под одной стадией: порядок задаёт `order`, стадий в сценарии нет. */
const SCENARIO_ANCHOR = 'work' as const;

const localized = (max: number, what: string) =>
  z
    .object({ ru: z.string().max(max), en: z.string().trim().min(1).max(max) })
    .describe(`${what}: both languages; the run reads en`);

/** Сколько шагов держит сценарий: владелец просил 20–80, конструктор окна держит 80. */
export const MAX_SCENARIO_STEPS = 80;

const RESOURCE_TYPES = ['skill', 'rule', 'hook', 'script'] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Где карточка сверяет id ресурса: те же списки, что читают разделы панели. */
const LIST_ROUTE: Record<ResourceType, string> = {
  skill: '/api/skills',
  rule: '/api/rules',
  hook: '/api/hooks',
  script: '/api/scripts',
};

const scenarioStep = z.union([
  z.object({
    skill: z.string().min(1).describe('Existing skill id (list_skills): the step applies it'),
    title: localized(200, 'Short step title (default: the id)').optional(),
  }),
  z.object({
    resource: z
      .object({ type: z.enum(RESOURCE_TYPES), id: z.string().min(1) })
      .describe(
        'Existing resource the step uses: skill (list_skills), rule (list_rules), hook ' +
          '(list_hooks, id "Event:hash"), script = utility (list_scripts, file name)',
      ),
    title: localized(200, 'Short step title (default: the id)').optional(),
  }),
  z.object({
    title: localized(200, 'Short step title'),
    prompt: localized(8_000, 'What the run is told to do at this step'),
    gate: localized(8_000, 'When the step counts as done').optional(),
  }),
]);
type ScenarioStepInput = z.infer<typeof scenarioStep>;

const scenarioInput = groupInput.omit({ id: true, env: true, projectPaths: true }).extend({
  when: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'When the scenario fits a task — «Auto» picks by this line only when a task is split across branches; a plain chat never auto-picks',
    ),
  steps: z
    .array(scenarioStep)
    .min(1)
    .max(MAX_SCENARIO_STEPS)
    .describe(`Ordered steps: the whole work, in order (up to ${MAX_SCENARIO_STEPS})`),
});
type ScenarioInput = z.infer<typeof scenarioInput>;

/** Ресурс шага: `{skill}` — прежняя краткая запись скилла. */
function resourceOf(step: ScenarioStepInput): { type: ResourceType; id: string } | undefined {
  if ('skill' in step) return { type: 'skill', id: step.skill };
  if ('resource' in step) return step.resource;
  return undefined;
}

function scenarioSteps(input: ScenarioInput, now: string): PathStep[] {
  return input.steps.map((step: ScenarioStepInput, order): PathStep => {
    const base = {
      id: randomUUID(),
      anchor: SCENARIO_ANCHOR,
      order,
      source: 'en' as const,
      createdAt: now,
    };
    const resource = resourceOf(step);
    if (resource) {
      // Без названия — id по обе стороны, как у выбора из каталога окна.
      const title = 'title' in step && step.title ? step.title : undefined;
      return {
        ...base,
        kind: 'resource',
        title: {
          ru: title?.ru.trim() || title?.en || resource.id,
          en: title?.en || resource.id,
        },
        prompt: { ru: '', en: '' },
        resource,
      };
    }
    if (!('prompt' in step)) throw new Error('A scenario step is a resource or own text.');
    return {
      ...base,
      kind: 'prompt',
      title: step.title,
      prompt: step.prompt,
      ...(step.gate ? { gate: step.gate } : {}),
    };
  });
}

async function scenarioDraft(input: ScenarioInput, inject: InjectRoute) {
  const groups = await readRoute<Group[]>(inject, '/api/groups');
  const taken = groups.find(
    (group) => group.name.trim().toLocaleLowerCase() === input.name.trim().toLocaleLowerCase(),
  );
  if (taken) {
    throw new Error(`A group «${taken.name}» already exists (id ${taken.id}). Pick another name.`);
  }
  const wanted = input.steps.flatMap((step) => {
    const resource = resourceOf(step);
    return resource ? [resource] : [];
  });
  for (const type of RESOURCE_TYPES) {
    const ids = wanted.filter((item) => item.type === type).map((item) => item.id);
    if (ids.length === 0) continue;
    const known = new Set(
      (await readRoute<{ id: string }[]>(inject, LIST_ROUTE[type])).map((item) => item.id),
    );
    const unknown = ids.find((id) => !known.has(id));
    if (unknown) {
      throw new Error(`No ${type} «${unknown}». Call list_${type}s for the ids.`);
    }
  }
  const { draft } = await groupDraft(input, inject);
  // Ресурс шага — участник сценария: без этого шаг велел бы применить скилл
  // (правило, хук), который группа не включает. Утилита — не участник: её
  // запускают, включать нечего.
  const members: GroupMember[] = [...draft.members];
  for (const { type, id } of wanted) {
    if (type === 'script') continue;
    if (!members.some((member) => member.kind === type && member.id === id)) {
      members.push({ kind: type, id });
    }
  }
  return {
    group: {
      ...draft,
      members,
      flow: 'scenario' as const,
      ...(input.when ? { when: input.when } : {}),
      isEnabled: false,
    },
    steps: scenarioSteps(input, new Date().toISOString()),
  };
}

/** Строка шага на языке окна: ресурс — видом, id и названием, свой шаг — заголовком. */
const stepLine = (step: PathStep, index: number, language: keyof BilingualText): string => {
  const title = bothSides(step.title)[language];
  if (step.kind !== 'resource' || !step.resource) return `${index + 1}. ${title}`;
  const { type, id } = step.resource;
  return `${index + 1}. ${type} ${id}${title && title !== id ? ` — ${title}` : ''}`;
};

export const draftScenario = definePanelAction({
  name: 'draft_scenario',
  section: 'groups',
  risk: 'change',
  title: 'journal-draft-scenario',
  description:
    'Create a NEW scenario in one card: a group whose ordered steps ARE the whole work (no pipeline ' +
    `stages), 1–${MAX_SCENARIO_STEPS} steps. Each step is an existing resource ` +
    '{resource: {type: skill|rule|hook|script, id}, title?} (list the ids first; a skill, rule or ' +
    'hook joins as a member, a script is a utility the step runs), the shorthand {skill: id}, or ' +
    'own text {title, prompt, gate?} in both languages. Plus name, when it fits and extra members. ' +
    'Created switched OFF (toggle_group enables it). Needs confirmation.',
  input: scenarioInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/groups',
    body: (await scenarioDraft(input, inject)).group,
  }),
  afterRoute: async (input, body, inject) => {
    const saved = body as Group;
    // Шаги уже проверены до записи (route): имя теперь занято самим сценарием.
    const steps = scenarioSteps(input, new Date().toISOString());
    const answer = await inject({
      method: 'PUT',
      url: `/api/groups/${encode(saved.id)}/path/steps`,
      body: { steps },
    });
    if (answer.status >= 400) {
      throw new Error(
        `Scenario «${saved.name}» was created (id ${saved.id}, switched off), but saving its steps ` +
          `failed: ${routeError('/api/groups', answer.status, answer.body).message}`,
      );
    }
    return { group: saved, path: answer.body as GroupPathView };
  },
  shape: (_input, body) => {
    const { group, path } = body as { group: Group; path: GroupPathView };
    return {
      id: group.id,
      name: group.name,
      flow: group.flow,
      isEnabled: group.isEnabled,
      steps: path.entries.flatMap((entry) => (entry.kind === 'custom' ? [entry.step.id] : [])),
    };
  },
  fingerprint: (_input, inject) =>
    routeFingerprint(inject, '/api/groups', (body) => (body as Group[]).map((group) => group.name)),
  preview: async (input, inject) => {
    const { group, steps } = await scenarioDraft(input, inject);
    return stateCard(
      `state.json: groups/${input.name}`,
      undefined,
      {
        ...group,
        members: group.members.map((member) => `${member.kind}:${member.id}`),
        steps: steps.map((step) =>
          step.kind === 'resource' && step.resource
            ? { [step.resource.type]: step.resource.id }
            : {
                title: step.title,
                prompt: step.prompt.en,
                ...(step.gate ? { gate: step.gate.en } : {}),
              },
        ),
      },
      card('summary-scenario-draft', { name: input.name }),
      [
        bilingualField('label-scenario-steps', {
          ru: steps.map((step, index) => stepLine(step, index, 'ru')).join('\n'),
          en: steps.map((step, index) => stepLine(step, index, 'en')).join('\n'),
        }),
      ],
    );
  },
  page: (_input, result) => {
    const id = (result as { id?: unknown } | undefined)?.id;
    return { route: '/groups', ...(typeof id === 'string' ? { focus: id } : {}) };
  },
});
