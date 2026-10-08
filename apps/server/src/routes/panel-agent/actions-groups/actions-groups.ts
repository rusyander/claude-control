import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Group } from '@agentdeck/contracts';
import type { GroupMembersView } from '@agentdeck/contracts/group-describe';
import type { GroupKnobsView } from '@agentdeck/contracts/group-knobs';
import {
  PATH_ANCHORS,
  pathAnchorSchema,
  type GroupPathView,
  type PathAnchor,
  type PathStep,
} from '@agentdeck/contracts/group-path';
import {
  definePanelAction,
  fingerprintOf,
  type AnyPanelAction,
  type InjectRoute,
} from '../registry.ts';
import {
  card,
  encode,
  maskDeep,
  readRoute,
  routeError,
  routeFingerprint,
  stateCard,
} from '../action-kit/action-kit.ts';
import { maskSecretsInText } from '../../../lib/secret-mask/secret-mask.ts';
import { findGroup, groupDraft, groupInput } from '../actions-app/actions-app.ts';
import { MAX_SCENARIO_STEPS, draftScenario } from '../actions-scenario.ts';
import { GROUP_COPY_ACTIONS } from '../actions-group-copy.ts';
import { bilingualField, bothSides, dataField, type BilingualText } from '../texts/texts.ts';

/**
 * Группы глубже списка: что в группе и зачем (участники, «Путь», числа),
 * черновик новой группы по описанию человека, свой шаг пути и числа скиллов.
 * Каждая запись — маршрутом окна (`/api/groups`, `/path/steps`, `/knobs`) и
 * через карточку подтверждения; своей логики пути и чисел здесь нет.
 */

const groupId = z.string().min(1).describe('Group id from list_groups');

const localized = (max: number, what: string) =>
  z
    .object({ ru: z.string().max(max), en: z.string().trim().min(1).max(max) })
    .describe(`${what}: both languages; the run reads en`);

const stepInput = z.object({
  anchor: pathAnchorSchema.describe(
    'Built-in pipeline stage the step runs AFTER (triage, plan, work, review, fix, deliver)',
  ),
  title: localized(200, 'Short step title'),
  prompt: localized(8_000, 'What the run is told to do at this step'),
  gate: localized(8_000, 'When the step counts as done').optional(),
});
type StepInput = z.infer<typeof stepInput>;

const knobValues = z
  .record(z.string(), z.number().int().nullable())
  .describe(
    'Knob id "<skillId>:<key>" (from read_group) → a number pins it: the run uses exactly that ' +
      'count every time, without asking; null → «Auto»: the skill decides itself',
  );

/** Свои шаги группы — из собранного пути, в его порядке. */
const customSteps = (view: GroupPathView): PathStep[] =>
  view.entries.flatMap((entry) => (entry.kind === 'custom' ? [entry.step] : []));

const pathOf = (inject: InjectRoute, id: string) =>
  readRoute<GroupPathView>(inject, `/api/groups/${encode(id)}/path`);

const knobsOf = (inject: InjectRoute, id: string) =>
  readRoute<GroupKnobsView>(inject, `/api/groups/${encode(id)}/knobs`);

function newStep(input: StepInput, order: number): PathStep {
  return {
    id: randomUUID(),
    anchor: input.anchor,
    order,
    kind: 'prompt',
    title: input.title,
    prompt: input.prompt,
    source: 'en',
    ...(input.gate ? { gate: input.gate } : {}),
    createdAt: new Date().toISOString(),
  };
}

/** Шаги в порядке пути: стадия за стадией, внутри — по `order` (как `buildPath`). */
const inPathOrder = (steps: readonly PathStep[]): PathStep[] =>
  [...steps].sort(
    (a, b) => PATH_ANCHORS.indexOf(a.anchor) - PATH_ANCHORS.indexOf(b.anchor) || a.order - b.order,
  );

/**
 * Ряд, в котором путь рисует шаг: стадия, а шаг внутри скилла — ещё и скилл.
 * Шаги внутри скилла стоят среди шагов скилла, а не среди своих шагов работы, —
 * посчитанные вместе, они сдвигали `position` и номер «work #N» на карточке.
 */
const laneOf = (step: PathStep): string => `${step.anchor}|${step.within?.skillId ?? ''}`;

/**
 * Список с шагом `step` на месте `position` внутри его ряда (нет — в конец).
 * `order` пересчитывается подряд с нуля — так же его приводит маршрут
 * (`normalizePathSteps`), и карточка показывает ровно записанный порядок.
 *
 * Сценарий — один плоский список по всем стадиям (`buildPath`): верхняя вставка
 * в окне кладёт шаг под `triage`, и `position` считается во всём списке, а
 * каждый шаг переписывается под `work` подряд.
 */
function placed(
  steps: readonly PathStep[],
  step: PathStep,
  position?: number,
  flow?: Group['flow'],
): PathStep[] {
  const rest = steps.filter((item) => item.id !== step.id);
  const lane = laneOf(step);
  const same =
    flow === 'scenario'
      ? inPathOrder(rest)
      : inPathOrder(rest.filter((item) => laneOf(item) === lane));
  const at = Math.min(Math.max(position ?? same.length, 0), same.length);
  const ordered = [...same.slice(0, at), step, ...same.slice(at)].map((item, order) => ({
    ...item,
    ...(flow === 'scenario' ? { anchor: 'work' as const } : {}),
    order,
  }));
  if (flow === 'scenario') return ordered;
  const others = rest.filter((item) => laneOf(item) !== lane);
  return [...others, ...ordered];
}

/**
 * Шаги глазами человека: стадия, номер, заголовок на языке окна — порядок как
 * у пути. У сценария стадий нет: «work #3» было бы словарём конвейера внутри
 * списка без стадий, поэтому там — сквозной номер. Шаг внутри скилла назван
 * скиллом: номер у него — среди шагов того же скилла.
 */
function stepLines(
  steps: readonly PathStep[],
  language: keyof BilingualText,
  flow?: Group['flow'],
): string[] {
  const sorted = inPathOrder(steps);
  if (flow === 'scenario') {
    return sorted.map((step, index) => `#${index + 1}: ${bothSides(step.title)[language]}`);
  }
  const counters = new Map<string, number>();
  return sorted.map((step) => {
    const number = (counters.get(laneOf(step)) ?? 0) + 1;
    counters.set(laneOf(step), number);
    const where = step.within ? `${step.anchor} › ${step.within.skillId}` : step.anchor;
    return `${where} #${number}: ${bothSides(step.title)[language]}`;
  });
}

/** Все шаги сценария — под одной стадией (как у `draft_scenario`): стадий в нём нет. */
const anchorFor = (group: Group, anchor: PathAnchor): PathAnchor =>
  group.flow === 'scenario' ? 'work' : anchor;

/** Строки шагов обеими сторонами — для поля карточки. */
const stepLinesBoth = (steps: readonly PathStep[]): BilingualText => ({
  ru: stepLines(steps, 'ru').join('\n'),
  en: stepLines(steps, 'en').join('\n'),
});

// --- Чтение ---

const readGroup = definePanelAction({
  name: 'read_group',
  section: 'groups',
  risk: 'read',
  description:
    'Explain one group: members with what each does (title/summary in both languages once ' +
    'described), its «Path» in run order (built-in stages, steps from member skills, own steps ' +
    'with ids; flow scenario = the steps alone ARE the work) and the run-count knobs of its ' +
    'skills (auto = the skill decides; a number = pinned). Use before editing steps or knobs.',
  input: z.object({ id: groupId }),
  route: (input) => ({ method: 'GET', url: `/api/groups/${encode(input.id)}/path` }),
  afterRoute: async (input, body, inject) => ({
    group: await findGroup(inject, input.id),
    path: body as GroupPathView,
    members: await readRoute<GroupMembersView>(inject, `/api/groups/${encode(input.id)}/members`),
    knobs: await knobsOf(inject, input.id),
  }),
  shape: (_input, body) => {
    const { group, path, members, knobs } = body as {
      group: Group;
      path: GroupPathView;
      members: GroupMembersView;
      knobs: GroupKnobsView;
    };
    const stepOf = (skillId: string, index: number) =>
      members.steps.find((step) => step.skillId === skillId && step.index === index);
    // Текст шагов, описания участников и подписи чисел пишут человек и модели —
    // маской, как у соседних чтений (правила, скиллы, история).
    return {
      id: group.id,
      name: group.name,
      description: maskSecretsInText(group.description),
      ...(group.when ? { when: maskSecretsInText(group.when) } : {}),
      isEnabled: group.isEnabled,
      scope: group.scope ?? { kind: 'global' },
      flow: group.flow ?? 'conveyor',
      members: maskDeep(members.members),
      ...(members.pending ? { membersPending: members.pending } : {}),
      path: maskDeep(
        path.entries.map((entry) => {
          if (entry.kind === 'builtin') return { stage: entry.stage };
          if (entry.kind === 'skill-step') {
            const described = stepOf(entry.skillId, entry.index);
            return {
              skill: entry.skillId,
              step: entry.title,
              ...(described ? { stepTitle: described.title, stepSummary: described.summary } : {}),
            };
          }
          return {
            stepId: entry.step.id,
            after: entry.step.anchor,
            title: entry.step.title.en || entry.step.title.ru,
            prompt: entry.step.prompt.en || entry.step.prompt.ru,
            ...(entry.step.resource ? { resource: entry.step.resource } : {}),
            // Шаг внутри скилла: под другую стадию он не переносится (move_group_step).
            ...(entry.step.within
              ? {
                  within: {
                    skill: entry.step.within.skillId,
                    ...(entry.step.within.after ? { afterStep: entry.step.within.after } : {}),
                  },
                }
              : {}),
          };
        }),
      ),
      knobs: knobs.knobs.map((knob) => ({
        id: `${knob.skillId}:${knob.key}`,
        label: maskSecretsInText(knob.label.en),
        value: knob.auto ? 'auto' : knob.value,
        skillDefault: knob.default,
        min: knob.min,
        max: knob.max,
      })),
      ...(knobs.pending ? { knobsPending: knobs.pending } : {}),
    };
  },
  summary: 'journal-read-group',
});

// --- Черновик группы ---

const draftInput = groupInput.omit({ id: true, env: true }).extend({
  when: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'When the group fits a task — «Auto» picks groups by this line only when a task is split across branches; a plain chat never auto-picks',
    ),
  steps: z.array(stepInput).max(MAX_SCENARIO_STEPS).optional().describe('Own «Path» steps'),
  knobs: knobValues.optional(),
});
type DraftInput = z.infer<typeof draftInput>;

async function draftOf(input: DraftInput, inject: InjectRoute) {
  const groups = await readRoute<Group[]>(inject, '/api/groups');
  const taken = groups.find(
    (group) => group.name.trim().toLocaleLowerCase() === input.name.trim().toLocaleLowerCase(),
  );
  if (taken) {
    throw new Error(
      `A group «${taken.name}» already exists (id ${taken.id}). Pick another name or edit it.`,
    );
  }
  const { draft } = await groupDraft(input, inject);
  await assertMembersExist(draft.members, groups, inject);
  // Черновик — выключенным: включение трогает участников и env, это отдельный шаг.
  return { ...draft, ...(input.when ? { when: input.when } : {}), isEnabled: false };
}

/** Где карточка сверяет id участника: те же списки, что читают разделы панели. */
const MEMBER_LIST: Record<Exclude<Group['members'][number]['kind'], 'group'>, string> = {
  skill: '/api/skills',
  rule: '/api/rules',
  hook: '/api/hooks',
  mcp: '/api/mcp',
  permission: '/api/permissions',
};

/**
 * Участник, которого нет, — отказ до карточки, как у `draft_scenario`: маршрут
 * групп проверяет только форму, и придуманный моделью `skill:x` лёг бы в группу
 * висячей ссылкой.
 */
async function assertMembersExist(
  members: Group['members'],
  groups: readonly Group[],
  inject: InjectRoute,
): Promise<void> {
  const known = new Map<string, Set<string>>();
  for (const member of members) {
    let ids = known.get(member.kind);
    if (!ids) {
      ids =
        member.kind === 'group'
          ? new Set(groups.map((group) => group.id))
          : new Set(
              (await readRoute<{ id: string }[]>(inject, MEMBER_LIST[member.kind])).map(
                (item) => item.id,
              ),
            );
      known.set(member.kind, ids);
    }
    if (!ids.has(member.id)) {
      const list = member.kind === 'mcp' ? 'list_mcp' : `list_${member.kind}s`;
      throw new Error(`No ${member.kind} «${member.id}». Call ${list} for the ids.`);
    }
  }
}

const draftGroup = definePanelAction({
  name: 'draft_group',
  section: 'groups',
  risk: 'change',
  title: 'journal-draft-group',
  description:
    'Create a NEW group from the human’s description in one card: members (kind:id of existing ' +
    'resources — list_skills/list_rules/list_mcp first), when it fits, own «Path» steps and knob ' +
    'values. Created switched OFF (toggle_group enables it). Knob ids not known yet come back in ' +
    'knobsNotSet: read_group later, then set_group_knobs. Needs confirmation.',
  input: draftInput,
  route: async (input, inject) => ({
    method: 'POST',
    url: '/api/groups',
    body: await draftOf(input, inject),
  }),
  afterRoute: async (input, body, inject) => {
    const saved = body as Group;
    const failedAfter = (what: string, error: unknown): Error =>
      new Error(
        `Group «${saved.name}» was created (id ${saved.id}, switched off), but ${what} failed: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    let steps = 0;
    if (input.steps && input.steps.length > 0) {
      let list: PathStep[] = [];
      for (const step of input.steps) list = placed(list, newStep(step, 0));
      const answer = await inject({
        method: 'PUT',
        url: `/api/groups/${encode(saved.id)}/path/steps`,
        body: { steps: list },
      });
      if (answer.status >= 400) {
        throw failedAfter(
          'saving its steps',
          routeError('/api/groups', answer.status, answer.body),
        );
      }
      steps = list.length;
    }
    const wanted = Object.entries(input.knobs ?? {}).filter(([, value]) => value !== null);
    if (wanted.length === 0) return { group: saved, steps, knobsSet: [], knobsNotSet: [] };
    const known = new Set(
      (await knobsOf(inject, saved.id)).knobs.map((knob) => `${knob.skillId}:${knob.key}`),
    );
    const set = wanted.filter(([id]) => known.has(id));
    if (set.length > 0) {
      const answer = await inject({
        method: 'PUT',
        url: `/api/groups/${encode(saved.id)}/knobs`,
        body: { values: Object.fromEntries(set) },
      });
      if (answer.status >= 400) {
        throw failedAfter(
          'setting its knobs',
          routeError('/api/groups', answer.status, answer.body),
        );
      }
    }
    return {
      group: saved,
      steps,
      knobsSet: set.map(([id]) => id),
      knobsNotSet: wanted.filter(([id]) => !known.has(id)).map(([id]) => id),
    };
  },
  shape: (_input, body) => {
    const { group, steps, knobsSet, knobsNotSet } = body as {
      group: Group;
      steps: number;
      knobsSet: string[];
      knobsNotSet: string[];
    };
    return {
      id: group.id,
      name: group.name,
      isEnabled: group.isEnabled,
      steps,
      knobsSet,
      knobsNotSet,
    };
  },
  fingerprint: (_input, inject) =>
    routeFingerprint(inject, '/api/groups', (body) => (body as Group[]).map((group) => group.name)),
  preview: async (input, inject) => {
    const draft = await draftOf(input, inject);
    const steps = (input.steps ?? []).reduce<PathStep[]>(
      (list, step) => placed(list, newStep(step, 0)),
      [],
    );
    const knobs = Object.fromEntries(
      Object.entries(input.knobs ?? {}).filter(([, value]) => value !== null),
    );
    return stateCard(
      `state.json: groups/${input.name}`,
      undefined,
      {
        ...draft,
        members: draft.members.map((member) => `${member.kind}:${member.id}`),
        path: steps.map((step) => ({
          after: step.anchor,
          title: step.title,
          prompt: step.prompt.en,
          ...(step.gate ? { gate: step.gate.en } : {}),
        })),
        ...(Object.keys(knobs).length > 0 ? { knobs } : {}),
      },
      card('summary-group-draft', { name: input.name }),
      [
        dataField('label-members', String(draft.members.length)),
        ...(steps.length > 0 ? [bilingualField('label-group-steps', stepLinesBoth(steps))] : []),
      ],
    );
  },
  page: (_input, result) => {
    const id = (result as { id?: unknown } | undefined)?.id;
    return { route: '/groups', ...(typeof id === 'string' ? { focus: id } : {}) };
  },
});

// --- Шаги пути ---

const stepsFingerprint = async (inject: InjectRoute, id: string) =>
  fingerprintOf(customSteps(await pathOf(inject, id)));

async function withAddedStep(
  input: { id: string; step: StepInput; position?: number },
  inject: InjectRoute,
) {
  const group = await findGroup(inject, input.id);
  const before = customSteps(await pathOf(inject, input.id));
  // Тот же предел, что у draft_group/draft_scenario: конструктор окна и список
  // перетаскивания рассчитаны на него, а добавление по одному обходило его.
  if (before.length >= MAX_SCENARIO_STEPS) {
    throw new Error(
      `The group already has ${before.length} own steps — the limit is ${MAX_SCENARIO_STEPS}. ` +
        'Remove or merge steps in the window first.',
    );
  }
  const step = newStep({ ...input.step, anchor: anchorFor(group, input.step.anchor) }, 0);
  return { group, before, after: placed(before, step, input.position, group.flow), step };
}

const addGroupStep = definePanelAction({
  name: 'add_group_step',
  section: 'groups',
  risk: 'change',
  title: 'journal-add-group-step',
  description:
    'Add an own step to a group’s «Path»: after which built-in stage and at which place among the ' +
    'own steps there (position 0 = first; omit = last). A scenario (flow scenario) has no stages: ' +
    `the anchor is ignored and position is the place in the whole list. Up to ${MAX_SCENARIO_STEPS} ` +
    'own steps per group. Needs confirmation.',
  input: z.object({
    id: groupId,
    step: stepInput,
    position: z.number().int().min(0).optional(),
  }),
  route: async (input, inject) => ({
    method: 'PUT',
    url: `/api/groups/${encode(input.id)}/path/steps`,
    body: { steps: (await withAddedStep(input, inject)).after },
  }),
  fingerprint: (input, inject) => stepsFingerprint(inject, input.id),
  preview: async (input, inject) => {
    const { group, before, after, step } = await withAddedStep(input, inject);
    const title = bothSides(step.title);
    return stateCard(
      `state.json: groups/${group.name}/path`,
      stepLines(before, 'ru', group.flow),
      stepLines(after, 'ru', group.flow),
      card(
        'summary-group-step-add',
        { name: group.name, title: title.ru },
        { name: group.name, title: title.en },
      ),
      [dataField('label-group-step-prompt', step.prompt.en)],
      { before: stepLines(before, 'en', group.flow), after: stepLines(after, 'en', group.flow) },
    );
  },
  shape: (_input, body) => ({ steps: customSteps(body as GroupPathView).map((step) => step.id) }),
  page: (input) => ({ route: '/groups', focus: input.id }),
});

async function withMovedStep(
  input: { id: string; stepId: string; after?: PathAnchor; position: number },
  inject: InjectRoute,
) {
  const group = await findGroup(inject, input.id);
  const before = customSteps(await pathOf(inject, input.id));
  const step = before.find((item) => item.id === input.stepId);
  if (!step)
    throw new Error(`Step «${input.stepId}» is not an own step of this group. Call read_group.`);
  const moved = { ...step, anchor: anchorFor(group, input.after ?? step.anchor) };
  // Шаг внутри скилла живёт в стадии работы (`normalizePathSteps`): перенос под
  // другую стадию проходил превью и падал 400 уже после одобрения человеком.
  if (moved.within && moved.anchor !== 'work') {
    throw new Error(
      `Step «${step.id}» runs inside skill «${moved.within.skillId}», so it stays under work. ` +
        'Omit "after" to reorder it there; taking it out of the skill is done in the window.',
    );
  }
  return { group, before, after: placed(before, moved, input.position, group.flow), step };
}

const moveGroupStep = definePanelAction({
  name: 'move_group_step',
  section: 'groups',
  risk: 'change',
  title: 'journal-move-group-step',
  description:
    'Reorder an own «Path» step (stepId from read_group): new place among the own steps after its ' +
    'stage (position 0 = first), optionally under another stage. Built-in stages and skill steps ' +
    'do not move; an own step placed inside a skill (read_group «within») stays under work. In a ' +
    'scenario position is the place in the whole list. Needs confirmation.',
  input: z.object({
    id: groupId,
    stepId: z.string().min(1),
    after: pathAnchorSchema.optional().describe('Move under this stage; omit to keep'),
    position: z.number().int().min(0),
  }),
  route: async (input, inject) => ({
    method: 'PUT',
    url: `/api/groups/${encode(input.id)}/path/steps`,
    body: { steps: (await withMovedStep(input, inject)).after },
  }),
  fingerprint: (input, inject) => stepsFingerprint(inject, input.id),
  preview: async (input, inject) => {
    const { group, before, after, step } = await withMovedStep(input, inject);
    const title = bothSides(step.title);
    return stateCard(
      `state.json: groups/${group.name}/path`,
      stepLines(before, 'ru', group.flow),
      stepLines(after, 'ru', group.flow),
      card(
        'summary-group-step-move',
        { name: group.name, title: title.ru },
        { name: group.name, title: title.en },
      ),
      [],
      { before: stepLines(before, 'en', group.flow), after: stepLines(after, 'en', group.flow) },
    );
  },
  shape: (_input, body) => ({ steps: customSteps(body as GroupPathView).map((step) => step.id) }),
  page: (input) => ({ route: '/groups', focus: input.id }),
});

// --- Числа ---

async function knobsEdit(
  input: { id: string; values: Record<string, number | null> },
  inject: InjectRoute,
) {
  const group = await findGroup(inject, input.id);
  const view = await knobsOf(inject, input.id);
  const shown = (id: string, value: number | undefined) => ({ [id]: value ?? 'auto' });
  const before: Record<string, number | string> = {};
  const after: Record<string, number | string> = {};
  for (const [id, value] of Object.entries(input.values)) {
    const knob = view.knobs.find((item) => `${item.skillId}:${item.key}` === id);
    if (!knob) {
      const pending = view.pending?.length ? ` Still being read: ${view.pending.join(', ')}.` : '';
      throw new Error(`Unknown knob «${id}». Call read_group for the knob ids.${pending}`);
    }
    if (value !== null && (value < knob.min || value > knob.max)) {
      throw new Error(`«${id}» must be within ${knob.min}..${knob.max}.`);
    }
    Object.assign(before, shown(id, knob.auto ? undefined : knob.value));
    Object.assign(after, shown(id, value ?? undefined));
  }
  return { group, before, after };
}

const setGroupKnobs = definePanelAction({
  name: 'set_group_knobs',
  section: 'groups',
  risk: 'change',
  title: 'journal-set-group-knobs',
  description:
    'Set run-count knobs of a group’s skills (review rounds, agents per round…). A number is pinned ' +
    'and used exactly on every run; null returns the knob to «Auto». Needs confirmation.',
  input: z.object({ id: groupId, values: knobValues }),
  route: (input) => ({
    method: 'PUT',
    url: `/api/groups/${encode(input.id)}/knobs`,
    body: { values: input.values },
  }),
  fingerprint: async (input, inject) =>
    fingerprintOf((await findGroup(inject, input.id)).knobs ?? {}),
  preview: async (input, inject) => {
    const { group, before, after } = await knobsEdit(input, inject);
    return stateCard(
      `state.json: groups/${group.name}/knobs`,
      before,
      after,
      card('summary-group-knobs', { name: group.name }),
      [dataField('label-group-knobs', Object.keys(after).join(', '))],
    );
  },
  shape: (_input, body) => ({
    knobs: (body as GroupKnobsView).knobs.map((knob) => ({
      id: `${knob.skillId}:${knob.key}`,
      value: knob.auto ? 'auto' : knob.value,
    })),
  }),
  page: (input) => ({ route: '/groups', focus: input.id }),
});

export const GROUP_ACTIONS: readonly AnyPanelAction[] = [
  readGroup,
  draftGroup,
  ...GROUP_COPY_ACTIONS,
  draftScenario,
  addGroupStep,
  moveGroupStep,
  setGroupKnobs,
];
