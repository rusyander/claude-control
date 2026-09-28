import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import { writePanelJson } from '../../lib/app-store/group-sources.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { memberContent } from '../../domains/groups/members.ts';
import { KNOBS_EXTRACTION_VERSION } from '../../domains/groups/knobs.ts';
import type { GroupAsk } from '../../domains/groups/model.ts';
import { registerGroupRoutes } from '../group-routes.ts';
import { registerGroupPathRoutes } from '../group-path-routes.ts';
import { registerGroupKnobsRoutes } from '../group-knobs-routes.ts';
import { registerSkillRoutes } from '../entity/skill-routes.ts';
import { registerRuleRoutes } from '../entity/rule-routes.ts';
import { registerHookRoutes } from '../entity/hook-routes.ts';
import { registerScriptRoutes } from '../script-routes.ts';
import { registerGroupDuplicateRoutes } from '../group-duplicate-routes.ts';
import { DESCRIBE_VERSION, describeIdle } from '../../domains/groups/describe.ts';
import { resourceSource } from '../../domains/groups/describe-sources.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Агент панели и группы: вызов инструмента → карточка → одобрение → настоящие
 * маршруты групп → state.json на ВРЕМЕННОМ диске. Доказательство — запись,
 * прочитанная новым хранилищем, а не ответ действия. Модель чисел не зовётся:
 * выписка скилла уже лежит в кэше, как после показа карточки группы.
 */
const ORIGIN = 'http://localhost:8888';

describe('panel-agent actions: groups', () => {
  let base: string;
  let root: string;
  let appData: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;

  const paths = () => ({
    root,
    appData,
    settings: join(root, 'settings.json'),
    settingsLocal: join(root, 'settings.local.json'),
    claudeMd: join(root, 'CLAUDE.md'),
    secretsEnv: join(root, '.mcp-secrets.env'),
    skills: join(root, 'skills'),
    hooks: join(root, 'hooks'),
    mcpConfig: join(base, '.claude.json'),
  });
  const disk = () => new AppStore(appData);
  const diskGroup = (name: string): Group | undefined =>
    disk()
      .getGroups()
      .find((group) => group.name === name);

  const skill = (id: string, description: string, body: string): void => {
    mkdirSync(join(root, 'skills', id), { recursive: true });
    writeFileSync(
      join(root, 'skills', id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`,
    );
  };

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-groups-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    writeFileSync(paths().settings, '{\n  "env": {}\n}\n');
    writeFileSync(paths().mcpConfig, '{}\n');
    skill('fleet', 'Parallel review fleet', 'Run 2 review rounds before the verdict.');
    writeFileSync(
      join(appData, 'state.json'),
      JSON.stringify({
        groups: [],
        automations: [],
        disabled: { rule: [], hook: [], skill: [], mcp: [], permission: [] },
      }),
    );
    store = new AppStore(appData);
    const content = memberContent(
      { paths: paths(), store },
      { kind: 'global' },
      { kind: 'skill', id: 'fleet' },
    );
    writePanelJson(appData, 'skill-knobs.json', {
      'global|skill:fleet': {
        hash: content?.hash,
        v: KNOBS_EXTRACTION_VERSION,
        knobs: [
          {
            key: 'review-rounds',
            skillId: 'fleet',
            label: { ru: 'Кругов ревью', en: 'Review rounds' },
            default: 2,
            min: 1,
            max: 6,
            quote: 'Run 2 review rounds before the verdict.',
          },
        ],
      },
    });
    pending = new PanelPendingActions(10_000);
    const ctx = {
      store,
      location: { paths: paths() },
      backupDir: join(appData, 'backups'),
      effectiveSettings: () => store.getSettings(),
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    // Модели здесь нечего делать: всё нужное уже в кэше. Позвали — тест о другом.
    const ask: GroupAsk = () => Promise.reject(new Error('model must not be called'));
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerGroupRoutes(app, ctx);
    registerGroupPathRoutes(app, ctx, () => ask);
    registerGroupKnobsRoutes(app, ctx, () => ask);
    registerSkillRoutes(app, ctx);
    registerRuleRoutes(app, ctx);
    registerHookRoutes(app, ctx);
    registerScriptRoutes(app, ctx);
    registerGroupDuplicateRoutes(app, ctx);
    // Язык панели для имени копии: тот же обработчик, что в config-routes, без его зависимостей.
    app.get('/api/settings', () => ctx.effectiveSettings());
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    await describeIdle();
    pending.cancelAll();
    await app.close();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const call = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-groups' },
    });

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  /** Вызов с решением человека по его карточке; карточки нет — исход без неё. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject' = 'approve',
  ): Promise<{ card?: PanelPendingAction; result: PanelActionResult }> => {
    let settled = false;
    const running = call(name, input).then((res) => {
      settled = true;
      return res.json<PanelActionResult>();
    });
    let card: PanelPendingAction | undefined;
    while (!settled && !card) {
      [card] = await listPending();
      if (!card) await new Promise((done) => setTimeout(done, 10));
    }
    if (card) {
      const answer = await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision },
      });
      expect(answer.statusCode).toBe(200);
    }
    return { ...(card ? { card } : {}), result: await running };
  };

  const STEP = {
    anchor: 'review',
    title: { ru: 'Сверка с макетом', en: 'Compare with the mock' },
    prompt: { ru: 'Сверь экран с макетом', en: 'Compare the screen with the mock' },
  };

  it('draft_group: одна карточка, группа выключенной, шаги и закреплённое умолчание на диске', async () => {
    const { card, result } = await decided('draft_group', {
      name: 'Ревью фронта',
      description: 'Review of UI work',
      when: 'UI changes',
      members: ['skill:fleet'],
      steps: [STEP],
      knobs: { 'fleet:review-rounds': 2, 'ghost:passes': 3 },
    });
    expect(card?.risk).toBe('change');
    expect(card?.preview.diff).toContain('Compare the screen with the mock');
    expect(card?.preview.diff).toContain('fleet:review-rounds');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({
      steps: 1,
      knobsSet: ['fleet:review-rounds'],
      knobsNotSet: ['ghost:passes'],
    });

    const group = diskGroup('Ревью фронта');
    expect(group).toMatchObject({
      isEnabled: false,
      when: 'UI changes',
      members: [{ kind: 'skill', id: 'fleet' }],
      // Равное умолчанию скилла — закреплено, не «Авто».
      knobs: { 'fleet:review-rounds': 2 },
    });
    expect(group?.path?.steps).toHaveLength(1);
    expect(group?.path?.steps[0]).toMatchObject({
      anchor: 'review',
      order: 0,
      kind: 'prompt',
      title: STEP.title,
      prompt: STEP.prompt,
    });
  });

  it('draft_group отклонён — на диске ничего', async () => {
    const { result } = await decided('draft_group', { name: 'Нет', steps: [STEP] }, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(disk().getGroups()).toEqual([]);
  });

  it('read_group: участники с описанием, путь по порядку, числа «Авто» и закреплённые', async () => {
    await decided('draft_group', { name: 'Флот', members: ['skill:fleet'], steps: [STEP] });
    const id = diskGroup('Флот')!.id;
    // Участник, которого больше нет (скилл удалили после), — окном, как в жизни:
    // draft_group такого не заведёт.
    const members = await app.inject({
      method: 'PUT',
      url: `/api/groups/${id}`,
      headers: { origin: ORIGIN },
      payload: {
        ...diskGroup('Флот')!,
        members: [
          { kind: 'skill', id: 'fleet' },
          { kind: 'skill', id: 'ghost' },
        ],
      },
    });
    expect(members.statusCode).toBe(200);

    const auto = (await call('read_group', { id })).json<PanelActionResult>();
    expect(auto.outcome).toBe('done');
    const view = auto.result as {
      members: Array<{ id: string; description?: string; missing?: boolean }>;
      path: Array<Record<string, unknown>>;
      knobs: Array<{ id: string; value: number | string; skillDefault: number }>;
    };
    expect(view.members).toEqual([
      { kind: 'skill', id: 'fleet', description: 'Parallel review fleet' },
      { kind: 'skill', id: 'ghost', missing: true },
    ]);
    const stages = view.path.map((entry) => entry.stage ?? entry.title);
    expect(stages.indexOf('Compare with the mock')).toBe(stages.indexOf('review') + 1);
    expect(view.knobs).toEqual([
      expect.objectContaining({ id: 'fleet:review-rounds', value: 'auto', skillDefault: 2 }),
    ]);

    await decided('set_group_knobs', { id, values: { 'fleet:review-rounds': 2 } });
    const pinned = (await call('read_group', { id })).json<PanelActionResult>().result as {
      knobs: Array<{ value: number | string }>;
    };
    expect(pinned.knobs[0]?.value).toBe(2);
  });

  it('add_group_step и move_group_step: порядок своих шагов на диске', async () => {
    await decided('draft_group', { name: 'Путь', steps: [STEP] });
    const id = diskGroup('Путь')!.id;
    const first = diskGroup('Путь')!.path!.steps[0]!.id;

    const added = await decided('add_group_step', {
      id,
      position: 0,
      step: { ...STEP, title: { ru: 'Скриншоты', en: 'Screenshots' } },
    });
    expect(added.card?.preview.diff).toContain('Скриншоты');
    expect(added.result.outcome).toBe('done');
    const titles = () =>
      diskGroup('Путь')!
        .path!.steps.filter((step) => step.anchor === 'review')
        .sort((a, b) => a.order - b.order)
        .map((step) => step.title.en);
    expect(titles()).toEqual(['Screenshots', 'Compare with the mock']);

    const moved = await decided('move_group_step', { id, stepId: first, position: 0 });
    expect(moved.result.outcome).toBe('done');
    expect(titles()).toEqual(['Compare with the mock', 'Screenshots']);

    const other = await decided('move_group_step', {
      id,
      stepId: first,
      after: 'plan',
      position: 0,
    });
    expect(other.result.outcome).toBe('done');
    expect(diskGroup('Путь')!.path!.steps.find((step) => step.id === first)?.anchor).toBe('plan');
  });

  it('set_group_knobs: число закрепляется, null — «Авто», неизвестное — отказ без карточки', async () => {
    await decided('draft_group', { name: 'Числа', members: ['skill:fleet'] });
    const id = diskGroup('Числа')!.id;

    const set = await decided('set_group_knobs', { id, values: { 'fleet:review-rounds': 4 } });
    expect(set.card?.preview.diff).toContain('auto');
    expect(diskGroup('Числа')?.knobs).toEqual({ 'fleet:review-rounds': 4 });

    await decided('set_group_knobs', { id, values: { 'fleet:review-rounds': null } });
    expect(diskGroup('Числа')?.knobs).toBeUndefined();

    const unknown = await decided('set_group_knobs', { id, values: { 'fleet:invented': 3 } });
    expect(unknown.card).toBeUndefined();
    expect(unknown.result.outcome).toBe('failed');
    const range = await decided('set_group_knobs', { id, values: { 'fleet:review-rounds': 9 } });
    expect(range.card).toBeUndefined();
    expect(diskGroup('Числа')?.knobs).toBeUndefined();
  });

  const OWN = {
    title: { ru: 'Сверка с макетом', en: 'Compare with the mock' },
    prompt: { ru: 'Сверь экран с макетом', en: 'Compare the screen with the mock' },
    gate: { ru: 'расхождений нет', en: 'no differences left' },
  };

  it('draft_scenario: одна карточка, сценарий выключенным, шаги по порядку, скилл шага — участник', async () => {
    const { card, result } = await decided('draft_scenario', {
      name: 'Сдача задачи',
      when: 'задача готова к сдаче',
      steps: [{ skill: 'fleet' }, OWN],
    });
    expect(card?.risk).toBe('change');
    expect(card?.preview.diff).toContain('Compare the screen with the mock');
    expect(card?.preview.diff).toContain('"skill": "fleet"');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ flow: 'scenario', isEnabled: false });

    const group = diskGroup('Сдача задачи');
    expect(group).toMatchObject({
      flow: 'scenario',
      isEnabled: false,
      when: 'задача готова к сдаче',
      members: [{ kind: 'skill', id: 'fleet' }],
    });
    const steps = [...(group?.path?.steps ?? [])].sort((a, b) => a.order - b.order);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      order: 0,
      kind: 'resource',
      resource: { type: 'skill', id: 'fleet' },
    });
    expect(steps[1]).toMatchObject({ order: 1, kind: 'prompt', title: OWN.title, gate: OWN.gate });
    expect(new Set(steps.map((step) => step.anchor)).size).toBe(1);

    // read_group говорит, что это сценарий.
    const read = (await call('read_group', { id: group!.id })).json<PanelActionResult>();
    expect(read.result).toMatchObject({ flow: 'scenario' });
  });

  // Кадр справки 27.09: английская карточка сценария читала заголовки шагов по-русски.
  it('карточки шагов несут обе стороны заголовка: ru — в value/summaryParams/diff, en — в *En', async () => {
    const field = (preview: PanelPendingAction['preview'] | undefined, code: string) =>
      preview?.fields.find((item) => item.labelCode === code);

    const scenario = await decided('draft_scenario', {
      name: 'Два языка',
      steps: [{ skill: 'fleet' }, OWN, { ...OWN, title: { ru: '', en: 'Only English' } }],
    });
    expect(field(scenario.card?.preview, 'label-scenario-steps')).toMatchObject({
      value: '1. skill fleet\n2. Сверка с макетом\n3. Only English',
      valueEn: '1. skill fleet\n2. Compare with the mock\n3. Only English',
    });

    const draft = await decided('draft_group', { name: 'Путь-2', steps: [STEP] });
    expect(field(draft.card?.preview, 'label-group-steps')).toMatchObject({
      value: 'review #1: Сверка с макетом',
      valueEn: 'review #1: Compare with the mock',
    });

    const id = diskGroup('Путь-2')!.id;
    const added = await decided('add_group_step', {
      id,
      step: { ...STEP, title: { ru: 'Скриншоты', en: 'Screenshots' } },
    });
    expect(added.card?.preview.summaryParams).toMatchObject({ title: 'Скриншоты' });
    expect(added.card?.preview.summaryParamsEn).toMatchObject({ title: 'Screenshots' });
    expect(added.card?.preview.diff).toContain('+  "review #2: Скриншоты"');
    expect(added.card?.preview.diffEn).toContain('+  "review #2: Screenshots"');
    expect(added.card?.preview.diffEn).not.toContain('Скриншоты');

    const stepId = diskGroup('Путь-2')!.path!.steps.find(
      (step) => step.title.en === 'Screenshots',
    )!.id;
    const moved = await decided('move_group_step', { id, stepId, position: 0 });
    expect(moved.card?.preview.summaryParams).toMatchObject({ title: 'Скриншоты' });
    expect(moved.card?.preview.summaryParamsEn).toMatchObject({ title: 'Screenshots' });
    expect(moved.card?.preview.diffEn).toContain('"review #1: Screenshots"');
    expect(moved.card?.preview.diffEn).not.toContain('Сверка');
  });

  // Владелец: сценарий на 20–80 шагов, шаг — любой вид, что даёт конструктор окна.
  it('draft_scenario: 80 шагов, шаг — скилл, правило, хук или утилита; 81-й — отказ', async () => {
    writeFileSync(
      paths().claudeMd,
      '# Rules\n\n## ПРАВИЛО: Review checklist\n\nRead every diff line.\n',
    );
    writeFileSync(
      paths().settings,
      JSON.stringify({
        env: {},
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx eslint .' }] }],
        },
      }),
    );
    mkdirSync(paths().hooks, { recursive: true });
    writeFileSync(join(paths().hooks, 'collect.mjs'), '// Collect the report\nconsole.log(1);\n');
    const list = <T>(url: string) =>
      app
        .inject({ method: 'GET', url, headers: { origin: ORIGIN } })
        .then((res) => res.json<T[]>());
    const rule = (await list<{ id: string }>('/api/rules'))[0]!.id;
    const hook = (await list<{ id: string }>('/api/hooks'))[0]!.id;
    const script = (await list<{ id: string }>('/api/scripts')).find((item) =>
      item.id.includes('collect'),
    )!.id;
    const kinds = [
      { skill: 'fleet' },
      {
        resource: { type: 'rule', id: rule },
        title: { ru: 'Чек-лист ревью', en: 'Review checklist' },
      },
      { resource: { type: 'hook', id: hook } },
      { resource: { type: 'script', id: script } },
    ];
    const steps = Array.from({ length: 80 }, (_, index) =>
      index < kinds.length
        ? kinds[index]
        : {
            title: { ru: `Шаг ${index + 1}`, en: `Step ${index + 1}` },
            prompt: { ru: 'сделать', en: `do ${index + 1}` },
          },
    );
    const { result } = await decided('draft_scenario', { name: 'Длинный', steps });
    expect(result.outcome).toBe('done');
    const group = diskGroup('Длинный')!;
    const saved = [...group.path!.steps].sort((a, b) => a.order - b.order);
    expect(saved).toHaveLength(80);
    expect(saved.slice(0, 4).map((step) => step.resource)).toEqual([
      { type: 'skill', id: 'fleet' },
      { type: 'rule', id: rule },
      { type: 'hook', id: hook },
      { type: 'script', id: script },
    ]);
    expect(saved[1]!.title).toEqual({ ru: 'Чек-лист ревью', en: 'Review checklist' });
    expect(saved[79]!.prompt.en).toBe('do 80');
    // Скилл, правило и хук — участники; утилиту запускают, она не участник.
    expect(group.members).toEqual([
      { kind: 'skill', id: 'fleet' },
      { kind: 'rule', id: rule },
      { kind: 'hook', id: hook },
    ]);

    const tooMany = await decided('draft_scenario', {
      name: 'Слишком',
      steps: [...steps, steps[10]],
    });
    expect(tooMany.card).toBeUndefined();
    expect(diskGroup('Слишком')).toBeUndefined();

    const ghost = await decided('draft_scenario', {
      name: 'Призрак-хук',
      steps: [{ resource: { type: 'hook', id: 'Stop:none' } }],
    });
    expect(ghost.card).toBeUndefined();
    expect(diskGroup('Призрак-хук')).toBeUndefined();
  });

  // Аудит 27.09 (I4): карточки шагов сценария говорили «work #N» — словарь стадий там, где стадий нет.
  it('шаг сценария: без стадий в карточке, anchor агента не уводит шаг из списка', async () => {
    await decided('draft_scenario', { name: 'Без стадий', steps: [OWN] });
    const id = diskGroup('Без стадий')!.id;
    const added = await decided('add_group_step', {
      id,
      step: { ...STEP, title: { ru: 'Скриншоты', en: 'Screenshots' } },
      position: 0,
    });
    expect(added.card?.preview.diffEn).toContain('"#1: Screenshots"');
    expect(added.card?.preview.diffEn).toContain('"#2: Compare with the mock"');
    expect(added.card?.preview.diffEn).not.toMatch(/(work|review) #/);
    const steps = diskGroup('Без стадий')!.path!.steps;
    expect(new Set(steps.map((step) => step.anchor))).toEqual(new Set(['work']));
    const moved = await decided('move_group_step', {
      id,
      stepId: steps.find((step) => step.title.en === 'Screenshots')!.id,
      after: 'deliver',
      position: 1,
    });
    expect(moved.card?.preview.diff).toContain('"#2: Скриншоты"');
    expect(diskGroup('Без стадий')!.path!.steps.every((step) => step.anchor === 'work')).toBe(true);
  });

  /** Свои шаги группы прямо маршрутом окна — так, как их кладёт веб или копия. */
  const putSteps = async (id: string, steps: Array<Record<string, unknown>>) => {
    const at = new Date().toISOString();
    const res = await app.inject({
      method: 'PUT',
      url: `/api/groups/${id}/path/steps`,
      headers: { origin: ORIGIN },
      payload: {
        steps: steps.map((step, index) => ({
          id: `s-${index}`,
          order: 0,
          kind: 'prompt',
          source: 'en',
          createdAt: at,
          prompt: OWN.prompt,
          ...step,
        })),
      },
    });
    expect(res.statusCode).toBe(200);
  };
  const pathTitles = async (id: string): Promise<string[]> =>
    (await app.inject({ method: 'GET', url: `/api/groups/${id}/path` }))
      .json<{ entries: Array<{ kind: string; step?: { title: { en: string } } }> }>()
      .entries.flatMap((entry) => (entry.step ? [entry.step.title.en] : []));

  /**
   * F-126. Сценарий — плоский список по всем стадиям (`buildPath`), а верхняя
   * вставка в окне кладёт шаг под `triage`. «position 0» агента считалась только
   * среди шагов `work` — новый шаг вставал вторым.
   */
  it('шаг сценария: position — место во всём списке, даже когда шаги лежат под разными стадиями', async () => {
    await decided('draft_scenario', { name: 'Плоский', steps: [OWN] });
    const id = diskGroup('Плоский')!.id;
    await putSteps(id, [
      { anchor: 'triage', title: { ru: 'А', en: 'A' } },
      { anchor: 'work', title: { ru: 'Б', en: 'B' } },
    ]);

    const added = await decided('add_group_step', {
      id,
      step: { ...STEP, title: { ru: 'Новый', en: 'New' } },
      position: 0,
    });
    expect(added.card?.preview.diffEn).toContain('"#1: New"');
    expect(added.result.outcome).toBe('done');
    expect(await pathTitles(id)).toEqual(['New', 'A', 'B']);

    const b = diskGroup('Плоский')!.path!.steps.find((step) => step.title.en === 'B')!;
    await decided('move_group_step', { id, stepId: b.id, position: 0 });
    expect(await pathTitles(id)).toEqual(['B', 'New', 'A']);
  });

  it('add_group_step: сценарий на пределе в 80 шагов — отказ до карточки', async () => {
    await decided('draft_scenario', { name: 'Полный', steps: [OWN] });
    const id = diskGroup('Полный')!.id;
    await putSteps(
      id,
      Array.from({ length: 80 }, (_, index) => ({
        anchor: 'work',
        order: index,
        title: { ru: `Шаг ${index}`, en: `Step ${index}` },
      })),
    );
    const { card, result } = await decided('add_group_step', { id, step: STEP });
    expect(card).toBeUndefined();
    expect(result.outcome).toBe('failed');
    expect(diskGroup('Полный')!.path!.steps).toHaveLength(80);
  });

  /**
   * F-291. Шаг внутри скилла живёт в стадии работы; перенос под другую стадию
   * проходил превью, а на клике маршрут отвечал 400. `read_group` не называл
   * `within`, и агенту неоткуда было узнать, что шаг такой.
   */
  it('шаг внутри скилла: read_group его называет, перенос под другую стадию — отказ до карточки', async () => {
    await decided('draft_group', { name: 'Внутри', members: ['skill:fleet'] });
    const id = diskGroup('Внутри')!.id;
    await putSteps(id, [
      {
        anchor: 'work',
        within: { skillId: 'fleet', index: 0, after: '' },
        title: { ru: 'Внутри', en: 'Inside' },
      },
    ]);
    const view = (await call('read_group', { id })).json<PanelActionResult>().result as {
      path: Array<Record<string, unknown>>;
    };
    expect(view.path.find((entry) => entry.stepId === 's-0')).toMatchObject({
      within: { skill: 'fleet' },
    });

    const { card, result } = await decided('move_group_step', {
      id,
      stepId: 's-0',
      after: 'plan',
      position: 0,
    });
    expect(card).toBeUndefined();
    expect(result.outcome).toBe('failed');
    expect(diskGroup('Внутри')!.path!.steps[0]?.anchor).toBe('work');
  });

  it('draft_group с несуществующим участником — отказ без карточки, на диске ничего', async () => {
    const { card, result } = await decided('draft_group', {
      name: 'Призрак',
      members: ['skill:fleet', 'skill:ghost'],
    });
    expect(card).toBeUndefined();
    expect(result.outcome).toBe('failed');
    expect(disk().getGroups()).toEqual([]);
  });

  /** F-17. Соседние чтения маскируют текст; шаги и подписи группы — тоже. */
  it('read_group: секрет в шаге группы уходит агенту маской', async () => {
    const token = ['ghp', '_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
    await decided('draft_group', { name: 'Секрет', members: ['skill:fleet'] });
    const id = diskGroup('Секрет')!.id;
    await putSteps(id, [
      {
        anchor: 'review',
        title: { ru: `Вход ${token}`, en: `Login ${token}` },
        prompt: { ru: `Токен ${token}`, en: `Use ${token}` },
      },
    ]);
    const text = JSON.stringify((await call('read_group', { id })).json<PanelActionResult>());
    expect(text).not.toContain(token);
    expect(text).toContain('Login ');
  });

  it('draft_scenario с несуществующим скиллом — отказ без карточки, на диске ничего', async () => {
    const { card, result } = await decided('draft_scenario', {
      name: 'Призрак',
      steps: [{ skill: 'ghost' }],
    });
    expect(card).toBeUndefined();
    expect(result.outcome).toBe('failed');
    expect(disk().getGroups()).toEqual([]);
  });

  it('read_group: описанный участник — с именем и строкой на двух языках', async () => {
    await decided('draft_group', { name: 'Описанный', members: ['skill:fleet'] });
    const id = diskGroup('Описанный')!.id;
    const source = resourceSource(
      { paths: paths(), store },
      { kind: 'global' },
      { kind: 'skill', id: 'fleet' },
    )!;
    writePanelJson(appData, 'describe.json', {
      [source.key]: {
        hash: source.hash,
        v: DESCRIBE_VERSION,
        title: { ru: 'Флот ревью', en: 'Review fleet' },
        summary: { ru: 'Ревью в два круга', en: 'Two-round review' },
      },
    });
    const view = (await call('read_group', { id })).json<PanelActionResult>().result as {
      members: Array<Record<string, unknown>>;
      membersPending?: string[];
    };
    expect(view.members).toEqual([
      {
        kind: 'skill',
        id: 'fleet',
        description: 'Parallel review fleet',
        title: { ru: 'Флот ревью', en: 'Review fleet' },
        summary: { ru: 'Ревью в два круга', en: 'Two-round review' },
      },
    ]);
    expect(view).not.toHaveProperty('membersPending');
  });
  it('copy_group: карточка с именем копии, копия выключена, шаги с новыми id, общий скилл не погашен', async () => {
    await decided('draft_group', {
      name: 'Флот',
      when: 'UI changes',
      members: ['skill:fleet'],
      steps: [STEP],
      knobs: { 'fleet:review-rounds': 3 },
    });
    const source = diskGroup('Флот')!;
    await decided('toggle_group', { id: source.id, isEnabled: true });

    const { card, result } = await decided('copy_group', { id: source.id });
    expect(card?.risk).toBe('change');
    expect(card?.preview).toMatchObject({
      summaryCode: 'summary-group-copy',
      summaryParams: { name: 'Флот', copy: 'Флот (копия)' },
    });
    expect(card?.preview.fields?.map((field) => field.valueCode)).toContain(
      'value-group-copy-effect',
    );
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({
      name: 'Флот (копия)',
      isEnabled: false,
      sourceId: source.id,
    });

    const copy = diskGroup('Флот (копия)')!;
    expect(copy).toMatchObject({
      isEnabled: false,
      when: 'UI changes',
      members: [{ kind: 'skill', id: 'fleet' }],
      knobs: { 'fleet:review-rounds': 3 },
    });
    expect(copy.path?.steps.map((step) => step.title)).toEqual([STEP.title]);
    expect(copy.path?.steps[0]!.id).not.toBe(source.path?.steps[0]!.id);
    // Выключенная копия не гасит общий скилл включённого оригинала.
    expect(disk().disablingGroups('skill', 'fleet')).toEqual([]);
    expect(diskGroup('Флот')).toMatchObject({ isEnabled: true, name: 'Флот' });
  });

  /**
   * F-233. Отпечаток копии был только [id, имя] всех групп: правка участников
   * или «Когда» источника между карточкой и кликом проходила, и копия уносила не
   * то, что человек подтвердил. Переменные группы копия уносит молча — на
   * карточке теперь их имена (не значения).
   */
  it('copy_group: источник изменился после карточки — stale_preview; env — именами на карточке', async () => {
    await decided('draft_group', { name: 'Флот', members: ['skill:fleet'] });
    const id = diskGroup('Флот')!.id;
    const withEnv = await app.inject({
      method: 'PUT',
      url: `/api/groups/${id}`,
      headers: { origin: ORIGIN },
      payload: { ...diskGroup('Флот')!, env: { API_TOKEN: 'secret-value' } },
    });
    expect(withEnv.statusCode).toBe(200);

    const running = call('copy_group', { id });
    let card: PanelPendingAction | undefined;
    while (!card) {
      [card] = await listPending();
      if (!card) await new Promise((done) => setTimeout(done, 10));
    }
    expect(JSON.stringify(card.preview)).toContain('API_TOKEN');
    expect(JSON.stringify(card.preview)).not.toContain('secret-value');
    const edited = await app.inject({
      method: 'PUT',
      url: `/api/groups/${id}`,
      headers: { origin: ORIGIN },
      payload: { ...diskGroup('Флот')!, when: 'only on Fridays' },
    });
    expect(edited.statusCode).toBe(200);
    const answer = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${card.id}`,
      headers: { origin: ORIGIN },
      payload: { decision: 'approve' },
    });
    expect(answer.statusCode).toBe(200);
    const result = (await running).json<PanelActionResult>();
    expect(result).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(disk().getGroups()).toHaveLength(1);
  });

  it('copy_group: отказ — на диске одна группа; занятое имя — отказ до карточки', async () => {
    await decided('draft_group', { name: 'Флот', members: ['skill:fleet'] });
    const id = diskGroup('Флот')!.id;
    const { result } = await decided('copy_group', { id }, 'reject');
    expect(result.outcome).toBe('rejected');
    expect(disk().getGroups()).toHaveLength(1);

    const taken = await decided('copy_group', { id, name: ' флот ' });
    expect(taken.card).toBeUndefined();
    expect(taken.result.outcome).toBe('failed');
    expect(disk().getGroups()).toHaveLength(1);
  });
});
