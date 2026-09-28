import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import { blockLang } from '@agentdeck/contracts/brand';
import { KNOB_MAX_OPTIONS, type GroupKnobsView } from '@agentdeck/contracts/group-knobs';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import type { GroupAsk, GroupModelMessage } from '../domains/groups/model.ts';
import { groupKnobsLine, KNOBS_EXTRACTION_VERSION } from '../domains/groups/knobs.ts';
import { readPanelJson, writePanelJson } from '../lib/app-store/group-sources.ts';
import { memberContent } from '../domains/groups/members.ts';
import { registerGroupKnobsRoutes } from './group-knobs-routes.ts';

/**
 * «Числа» группы со стороны маршрутов: временный каталог конфигурации и
 * подменённая модель — чтение скиллов, кэш `skill-knobs.json` по хэшу,
 * проверка цитат и запись в группу идут по-настоящему.
 */

const block = (body: unknown): string =>
  `\n\`\`\`${blockLang('group-knobs')}\n${JSON.stringify(body)}\n\`\`\`\n`;

const FLEET = 'Run 2 review rounds before the verdict.\nSpawn 3 agents per round, one per lane.';

const knob = (patch: Record<string, unknown>): Record<string, unknown> => ({
  key: 'review-rounds',
  label: { ru: 'Кругов ревью', en: 'Review rounds' },
  default: 2,
  min: 1,
  max: 6,
  quote: 'Run 2 review rounds before the verdict.',
  ...patch,
});

describe('маршруты «чисел» группы', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let calls: GroupModelMessage[][];
  let tiers: string[];
  let answer: () => string;

  const skillsDir = (): string => join(root, 'skills');
  const writeSkill = (dir: string, id: string, body: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };

  const saveGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'g1',
      name: 'Fleet',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'fleet' }],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 0,
      ...patch,
    });

  const boot = async (override?: GroupAsk): Promise<void> => {
    const ctx = {
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: join(root, 'CLAUDE.md'),
          skills: skillsDir(),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
          appData: join(root, 'agentdeck'),
        },
      },
      store,
      backupDir: join(root, 'agentdeck', 'backups'),
    } as unknown as ServerContext;
    const ask: GroupAsk = async (messages, tier) => {
      calls.push(messages);
      tiers.push(tier);
      return answer();
    };
    app = Fastify();
    registerGroupKnobsRoutes(app, ctx, () => override ?? ask);
    await app.ready();
  };

  /** Первый GET запускает выписку в фоне; ждём, пока pending не опустеет. */
  const settled = async (): Promise<GroupKnobsView> => {
    for (let i = 0; i < 50; i += 1) {
      const view = (await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' })).json();
      if (!view.pending) return view as GroupKnobsView;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('выписка не закончилась');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-knobs-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    mkdirSync(skillsDir(), { recursive: true });
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    store = new AppStore(join(root, 'agentdeck'));
    calls = [];
    tiers = [];
    answer = () =>
      block({
        knobs: [
          knob({}),
          knob({
            key: 'agents-per-round',
            label: { ru: 'Агентов на круг', en: 'Agents per round' },
            default: 3,
            max: 8,
            quote: 'Spawn 3 agents per round',
          }),
          // Выдуманная цитата — такой строки в скилле нет.
          knob({ key: 'verifiers', quote: 'Use 2 verifiers after each round.' }),
          // Цитата настоящая, но числа 5 в ней нет.
          knob({ key: 'passes', default: 5, max: 9 }),
        ],
      });
  });

  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('первый GET отвечает сразу с pending, второй — только с обоснованными числами', async () => {
    writeSkill(skillsDir(), 'fleet', FLEET);
    saveGroup();
    await boot();
    const first = await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ groupId: 'g1', knobs: [], pending: ['fleet'] });
    const view = await settled();
    expect(view.knobs.map((item) => item.key).sort()).toEqual([
      'agents-per-round',
      'review-rounds',
    ]);
    // Ничего не закреплено — всё «Авто»: скилл решает сам.
    expect(
      view.knobs.every((item) => item.skillId === 'fleet' && item.auto && !item.overridden),
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('кэш по хэшу: повторный показ модель не зовёт, правка скилла — зовёт снова', async () => {
    writeSkill(skillsDir(), 'fleet', FLEET);
    saveGroup();
    await boot();
    await settled();
    await settled();
    expect(calls).toHaveLength(1);
    writeSkill(skillsDir(), 'fleet', `${FLEET}\nOne more line.`);
    await settled();
    expect(calls).toHaveLength(2);
  });

  it('скилл без цифр модель не зовёт и в pending не встаёт', async () => {
    writeSkill(skillsDir(), 'plain', 'Say hello politely.');
    saveGroup({ members: [{ kind: 'skill', id: 'plain' }] });
    await boot();
    const res = await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' });
    expect(res.json()).toEqual({ groupId: 'g1', knobs: [] });
    expect(calls).toHaveLength(0);
  });

  it('число знает свой шаг скилла: ревью — на шаге ревью, цитата во вступлении с §N — на шаге N', async () => {
    // Форма скилла доставки 28.09: у проектного скилла текст есть только у сервера, и
    // страница ставила все числа на шаг 1 — у ревью «чисел не было».
    const project = join(root, 'project');
    writeSkill(
      join(project, '.claude', 'skills'),
      'fleet',
      [
        '## Rules',
        'Spawn 3 agents per round in §2.',
        '',
        '## 1. Prepare',
        'Read the diff.',
        '',
        '## 2. Review',
        'Run 2 review rounds before the verdict.',
      ].join('\n'),
    );
    saveGroup({ scope: { kind: 'project', path: project, provider: 'claude' } });
    await boot();
    const view = await settled();
    expect(Object.fromEntries(view.knobs.map((item) => [item.key, item.step]))).toEqual({
      'review-rounds': 1,
      'agents-per-round': 1,
    });
  });

  it('скилл проекта читается из каталога проекта', async () => {
    const project = join(root, 'project');
    writeSkill(join(project, '.claude', 'skills'), 'fleet', FLEET);
    saveGroup({ scope: { kind: 'project', path: project, provider: 'claude' } });
    await boot();
    const view = await settled();
    expect(view.knobs).toHaveLength(2);
    expect(calls[0]![0]!.content).toContain('Spawn 3 agents per round');
  });

  it('PUT: вне границ — 400, число закрепляется (и равное умолчанию), null — снова «Авто»', async () => {
    writeSkill(skillsDir(), 'fleet', FLEET);
    saveGroup();
    await boot();
    await settled();
    const put = (values: Record<string, number | null>) =>
      app.inject({ method: 'PUT', url: '/api/groups/g1/knobs', payload: { values } });
    const id = 'fleet:review-rounds';

    expect((await put({ [id]: 7 })).statusCode).toBe(400);
    expect((await put({ [id]: 0 })).statusCode).toBe(400);
    expect((await put({ 'fleet:invented': 3 })).statusCode).toBe(400);
    expect(store.getGroups()[0]!.knobs).toBeUndefined();

    const set = await put({ [id]: 4 });
    expect(set.statusCode).toBe(200);
    const shown = (set.json() as GroupKnobsView).knobs.find((item) => item.key === 'review-rounds');
    expect(shown).toMatchObject({ value: 4, auto: false, overridden: true, default: 2 });
    expect(store.getGroups()[0]!.knobs).toEqual({ [id]: 4 });

    // Закреплённое умолчание — не «Авто»: хранится, в границах проверяется.
    const pinned = await put({ [id]: 2 });
    expect(store.getGroups()[0]!.knobs).toEqual({ [id]: 2 });
    expect(
      (pinned.json() as GroupKnobsView).knobs.find((item) => item.key === 'review-rounds'),
    ).toMatchObject({ value: 2, auto: false, overridden: false });

    const auto = await put({ [id]: null });
    expect(store.getGroups()[0]!.knobs).toBeUndefined();
    expect(
      (auto.json() as GroupKnobsView).knobs.find((item) => item.key === 'review-rounds'),
    ).toMatchObject({ value: 2, auto: true, overridden: false });
  });

  it('строка прогона: все закреплённые, одинаковая от вызова к вызову, «Авто» — нет строки', async () => {
    writeSkill(skillsDir(), 'fleet', FLEET);
    saveGroup();
    await boot();
    await settled();
    const appData = join(root, 'agentdeck');
    expect(groupKnobsLine(appData, store.getGroups()[0]!)).toBeUndefined();

    await app.inject({
      method: 'PUT',
      url: '/api/groups/g1/knobs',
      payload: { values: { 'fleet:review-rounds': 4 } },
    });
    const line = groupKnobsLine(appData, store.getGroups()[0]!);
    expect(line).toContain('fleet — Review rounds: 4 (skill default 2)');
    expect(line).toContain('Use exactly these counts on every run without asking the user');
    expect(line).not.toContain('Agents per round');
    expect(line).not.toMatch(/\n/);
    expect(groupKnobsLine(appData, store.getGroups()[0]!)).toBe(line);

    // Закреплённое умолчание скилла тоже уходит в прогон: это не «Авто».
    await app.inject({
      method: 'PUT',
      url: '/api/groups/g1/knobs',
      payload: { values: { 'fleet:review-rounds': 2 } },
    });
    expect(groupKnobsLine(appData, store.getGroups()[0]!)).toContain(
      'fleet — Review rounds: 2 (skill default 2)',
    );
    await app.inject({
      method: 'PUT',
      url: '/api/groups/g1/knobs',
      payload: { values: { 'fleet:review-rounds': null } },
    });
    expect(groupKnobsLine(appData, store.getGroups()[0]!)).toBeUndefined();
  });

  // Живой случай (26.09.2026): скилл сдачи тикета проекта — все счётчики словами,
  // в выделении («exactly **two** review subagents»), а в тексте ни одной цифры.
  const WORDS =
    'Run the review with exactly **two** review subagents.\n\n## Verify\nTwo agents check the MR.';

  it('скилл, где числа словами и в выделении: модель зовётся, цитата без звёздочек засчитана', async () => {
    writeSkill(skillsDir(), 'delivery', WORDS);
    saveGroup({ members: [{ kind: 'skill', id: 'delivery' }] });
    answer = () =>
      block({
        knobs: [
          knob({
            key: 'review-subagents',
            label: { ru: 'Сабагентов ревью', en: 'Review subagents' },
            default: 2,
            max: 4,
            quote: 'Run the review with exactly two review subagents.',
          }),
          // Слово «three» в тексте не стоит — выдумка отброшена.
          knob({ key: 'verifiers', default: 3, quote: 'Two agents check the MR.' }),
        ],
      });
    await boot();
    const view = await settled();
    expect(calls).toHaveLength(1);
    expect(view.knobs.map((item) => [item.key, item.default])).toEqual([['review-subagents', 2]]);
  });

  it('выписка старой версии — не кэш: пустое «чисел нет» от старых правил пересчитывается', async () => {
    writeSkill(skillsDir(), 'delivery', WORDS);
    saveGroup({ members: [{ kind: 'skill', id: 'delivery' }] });
    const content = memberContent(
      { paths: { skills: skillsDir() } as never, store },
      { kind: 'global' },
      { kind: 'skill', id: 'delivery' },
    );
    // Так лежала запись в живом кэше: тот же хэш, без версии, пустой список.
    writePanelJson(join(root, 'agentdeck'), 'skill-knobs.json', {
      'global|skill:delivery': { hash: content!.hash, knobs: [] },
    });
    answer = () =>
      block({
        knobs: [knob({ key: 'review-subagents', quote: 'exactly **two** review subagents' })],
      });
    await boot();
    const first = await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' });
    expect(first.json()).toMatchObject({ pending: ['delivery'] });
    const view = await settled();
    expect(view.knobs.map((item) => item.key)).toEqual(['review-subagents']);
    expect(calls).toHaveLength(1);
  });

  // Скилл доставки задачи в духе живого: длинная проза, цифры версий и портов,
  // а счётчики прогонов — словами, в выделении и рядом со ссылками на разделы.
  const DELIVERY = [
    'Deliver a PROJ ticket end-to-end: claim, branch, fix, the gates, draft MR.',
    'Needs Node 22.6 and the stand on port 5173; see §4.2 for the env file.',
    '- exactly **two** review subagents in §9, nowhere else in the flow.',
    'Once the MR is open, move the ticket to review.',
    '**Failure budget:** the same gate red three times on the same cause → stop and ask.',
    '## 9. Deep review — two agents, split by entry point',
    'Look at the pipeline exactly twice: after the fixes are pushed and before the handoff.',
    'An infra death: retry that job **once**. A second one is reported, not retried.',
    'Сверка с макетом — ревью двумя агентами, не больше трёх раз подряд.',
  ].join('\n');

  const deliveryKnobs = (): string =>
    block({
      knobs: [
        knob({
          key: 'review-subagents',
          label: { ru: 'Сабагентов ревью', en: 'Review subagents' },
          default: 2,
          max: 4,
          quote: 'exactly two review subagents in §9',
        }),
        knob({
          key: 'gate-failures',
          label: { ru: 'Падений гейта', en: 'Gate failures' },
          default: 3,
          max: 6,
          quote: 'the same gate red three times on the same cause',
        }),
      ],
    });

  it('пустой ответ при строках-счётчиках: переспрос с кандидатами, числа приходят вторым ответом', async () => {
    writeSkill(skillsDir(), 'delivery', DELIVERY);
    saveGroup({ members: [{ kind: 'skill', id: 'delivery' }] });
    const replies = [block({ knobs: [] }), deliveryKnobs()];
    answer = () => replies.shift() ?? block({ knobs: [] });
    await boot();
    const view = await settled();
    expect(view.knobs.map((item) => [item.key, item.default])).toEqual([
      ['review-subagents', 2],
      ['gate-failures', 3],
    ]);
    expect(calls).toHaveLength(2);
    // Первый запрос уже несёт кандидатов — строки со счётчиками, а не прозу с версиями.
    const hint = calls[0]![0]!.content;
    expect(hint).toContain('Lines that look like run counts:');
    expect(hint).toContain('- - exactly **two** review subagents in §9, nowhere else in the flow.');
    expect(hint).toContain('- An infra death: retry that job **once**.');
    expect(hint).toContain('- Сверка с макетом — ревью двумя агентами');
    expect(hint).not.toContain('- Needs Node 22.6');
    expect(hint).not.toContain('- Once the MR is open');
    // Переспрос — продолжение того же разговора и уже не дешёвой ступенью.
    expect(calls[1]!.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(calls[1]![2]!.content).toContain('- **Failure budget:** the same gate red three times');
    expect(tiers).toEqual(['cheap', 'default']);
  });

  it('пусто и после переспроса: в кэш не ложится, ответы сохранены, скилл в failed, модель не зовётся на каждом показе', async () => {
    writeSkill(skillsDir(), 'delivery', DELIVERY);
    saveGroup({ members: [{ kind: 'skill', id: 'delivery' }] });
    answer = () => block({ knobs: [] });
    await boot();
    await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' });
    let view: GroupKnobsView | undefined;
    for (let i = 0; i < 50 && !view?.failed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      view = (await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' })).json();
    }
    expect(view).toEqual({ groupId: 'g1', knobs: [], failed: ['delivery'] });
    expect(calls).toHaveLength(2);
    const appData = join(root, 'agentdeck');
    expect(readPanelJson<Record<string, unknown>>(appData, 'skill-knobs.json', {})).toEqual({});
    const failure = readPanelJson<Record<string, Record<string, unknown>>>(
      appData,
      'skill-knobs-failed.json',
      {},
    )['global|skill:delivery'];
    expect(failure).toMatchObject({ reason: 'knobs-empty', count: 1, v: 3 });
    expect(failure?.replies).toEqual([block({ knobs: [] }), block({ knobs: [] })]);
    expect(failure?.candidates).toContain(
      'Look at the pipeline exactly twice: after the fixes are pushed and before the handoff.',
    );
    await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' });
    expect(calls).toHaveLength(2);
  });

  it('смена правил выписки: закреплённое число прежней версии видно, пока идёт новая выписка', async () => {
    writeSkill(skillsDir(), 'delivery', DELIVERY);
    const content = memberContent(
      { paths: { skills: skillsDir() } as never, store },
      { kind: 'global' },
      { kind: 'skill', id: 'delivery' },
    );
    const old = {
      key: 'review-subagents',
      skillId: 'delivery',
      label: { ru: 'Сабагентов ревью', en: 'Review subagents' },
      default: 2,
      min: 1,
      max: 4,
      quote: 'exactly two review subagents in §9',
    };
    writePanelJson(join(root, 'agentdeck'), 'skill-knobs.json', {
      'global|skill:delivery': { hash: content!.hash, knobs: [old], v: 2 },
    });
    saveGroup({
      members: [{ kind: 'skill', id: 'delivery' }],
      knobs: { 'delivery:review-subagents': 3 },
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: GroupAsk = async () => {
      await gate;
      return deliveryKnobs();
    };
    await boot(slow);
    const during = (await app.inject({ method: 'GET', url: '/api/groups/g1/knobs' })).json();
    expect(during.pending).toEqual(['delivery']);
    expect(
      during.knobs.map((item: { key: string; value: number; auto: boolean }) => [
        item.key,
        item.value,
        item.auto,
      ]),
    ).toEqual([['review-subagents', 3, false]]);
    release();
    const view = await settled();
    expect(view.knobs.map((item) => [item.key, item.value])).toEqual([
      ['review-subagents', 3],
      ['gate-failures', 3],
    ]);
  });

  it('дикий размах от модели зажат: не больше KNOB_MAX_OPTIONS чисел, умолчание внутри, PUT за краем — 400 (F-73)', async () => {
    writeSkill(skillsDir(), 'fleet', 'Wait 600 seconds between polls.');
    saveGroup();
    answer = () =>
      block({
        knobs: [
          knob({
            key: 'poll-wait',
            label: { ru: 'Пауза опроса', en: 'Poll wait' },
            default: 600,
            min: 0,
            max: 20000,
            quote: 'Wait 600 seconds between polls.',
          }),
        ],
      });
    await boot();
    const [wide] = (await settled()).knobs;
    expect(wide!.max - wide!.min + 1).toBeLessThanOrEqual(KNOB_MAX_OPTIONS);
    expect(wide!.min).toBeLessThanOrEqual(600);
    expect(wide!.max).toBeGreaterThanOrEqual(600);
    expect(wide!.max).toBeLessThanOrEqual(2400);
    const put = (value: number) =>
      app.inject({
        method: 'PUT',
        url: '/api/groups/g1/knobs',
        payload: { values: { 'fleet:poll-wait': value } },
      });
    expect((await put(20000)).statusCode).toBe(400);
    expect((await put(wide!.max)).statusCode).toBe(200);
  });

  it('кэш прежней выписки с диким размахом зажимается при показе (F-73)', async () => {
    writeSkill(skillsDir(), 'fleet', FLEET);
    const content = memberContent(
      { paths: { skills: skillsDir() } as never, store },
      { kind: 'global' },
      { kind: 'skill', id: 'fleet' },
    );
    writePanelJson(join(root, 'agentdeck'), 'skill-knobs.json', {
      'global|skill:fleet': {
        hash: content!.hash,
        knobs: [{ ...knob({ min: -5, max: 100000 }), skillId: 'fleet' }],
        v: KNOBS_EXTRACTION_VERSION,
      },
    });
    saveGroup();
    await boot();
    const [shown] = (await settled()).knobs;
    expect([shown!.min, shown!.max]).toEqual([0, 8]);
    expect(calls).toHaveLength(0);
  });
});
