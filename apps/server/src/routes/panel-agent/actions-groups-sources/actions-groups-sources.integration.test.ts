import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Group } from '@agentdeck/contracts';
import type { PanelActionResult, PanelPendingAction } from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { blockLang } from '@agentdeck/contracts/brand';
import { GROUP_OVERRIDE_FILE } from '@agentdeck/contracts/group-sources';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../../context.ts';
import { registerAccessGate } from '../../../lib/access-gate/access-gate.ts';
import { registerEmptyBodyGuard } from '../../../lib/empty-body.ts';
import { createEventHub } from '../../../lib/event-hub/event-hub.ts';
import { allowedOrigins } from '../../../lib/origin-guard/origin-guard.ts';
import { PanelPendingActions } from '../../../domains/panel-agent/pending/pending.ts';
import type { GroupAsk, GroupModelMessage } from '../../../domains/groups/model.ts';
import { resetDiscoveryRuns } from '../../../domains/group-discovery/run.ts';
import { describeIdle } from '../../../domains/groups/describe/describe.ts';
import { registerGroupRoutes } from '../../group-routes/group-routes.ts';
import { registerGroupSourcesRoutes } from '../../group-sources-routes/group-sources-routes.ts';
import { registerGroupPathRoutes } from '../../group-path-routes/group-path-routes.ts';
import { registerSkillRoutes } from '../../entity/skill-routes.ts';
import { registerRuleRoutes } from '../../entity/rule-routes.ts';
import { registerHookRoutes } from '../../entity/hook-routes.ts';
import { registerPanelAgentRoutes } from '../panel-agent-routes/panel-agent-routes.ts';
import { registerProjectRoutes } from '../../project-routes/project-routes.ts';
import { folderSnapshot } from '../registered-folder/registered-folder.test-kit.ts';

/**
 * Агент панели и группы по областям: вызов инструмента → карточка → решение
 * человека → настоящие маршруты «Групп» → файлы и state.json на ВРЕМЕННОМ
 * диске. Подменена только модель (граница процесса CLI и сети); доказательство —
 * файлы и запись группы, прочитанные заново, а не ответ действия.
 */
const ORIGIN = 'http://localhost:8888';

const block = (kind: string, body: unknown): string =>
  `\n\`\`\`${blockLang(kind)}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\`\n`;

describe('panel-agent actions: groups by scope', () => {
  let base: string;
  let root: string;
  let project: string;
  let appData: string;
  let store: AppStore;
  let pending: PanelPendingActions;
  let app: FastifyInstance;
  let calls: GroupModelMessage[][];
  let answer: (messages: GroupModelMessage[]) => string;

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
  const diskGroup = (id: string): Group | undefined =>
    disk()
      .getGroups()
      .find((group) => group.id === id);

  const skill = (dir: string, id: string, body: string): void => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(
      join(dir, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: ${id} skill\n---\n\n${body}\n`,
      'utf8',
    );
  };

  const projectGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'proj-1',
      name: 'Ticket flow',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'ladder' }],
      env: {},
      projectPaths: [],
      scope: { kind: 'project', path: project, provider: 'claude' },
      isEnabled: true,
      order: 0,
      ...patch,
    });

  const globalGroup = (patch: Partial<Group> = {}): Group =>
    store.saveGroup({
      id: 'glob-1',
      name: 'Ticket flow (global)',
      description: '',
      color: 'accent',
      icon: 'folder',
      members: [{ kind: 'skill', id: 'global-ladder' }],
      env: {},
      projectPaths: [],
      isEnabled: true,
      order: 1,
      ...patch,
    });

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), 'cc-agent-group-sources-'));
    root = join(base, '.claude');
    appData = join(root, 'agentdeck');
    project = join(base, 'proj');
    mkdirSync(appData, { recursive: true });
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(paths().settings, '{}', 'utf8');
    writeFileSync(paths().mcpConfig, '{}\n');
    skill(join(root, 'skills'), 'global-ladder', 'Global ladder.');
    skill(join(project, '.claude', 'skills'), 'ladder', '## 1. Read\n\n## 2. Write');
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
    writeFileSync(join(project, '.git', 'info', 'exclude'), '# git ls-files --others\n', 'utf8');

    store = new AppStore(appData);
    store.addProject({ id: 'p1', name: 'proj', path: project });
    calls = [];
    answer = () => 'no block';
    resetDiscoveryRuns();
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
    const ask: GroupAsk = async (messages) => {
      calls.push(messages);
      return answer(messages);
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerGroupRoutes(app, ctx);
    registerGroupSourcesRoutes(app, ctx, () => ask);
    registerGroupPathRoutes(app, ctx, () => ask);
    registerSkillRoutes(app, ctx);
    registerRuleRoutes(app, ctx);
    registerHookRoutes(app, ctx);
    registerProjectRoutes(app, ctx);
    app.get('/api/settings', () => ctx.effectiveSettings());
    registerPanelAgentRoutes(app, ctx, { hub: createEventHub(), pending, access });
    await app.ready();
  });

  afterEach(async () => {
    await describeIdle();
    pending.cancelAll();
    await app.close();
    resetDiscoveryRuns();
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const post = (name: string, input: unknown) =>
    app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input, conversationId: 'conv-group-sources' },
    });

  const call = async (name: string, input: unknown) =>
    (await post(name, input)).json<PanelActionResult>();

  const listPending = async (): Promise<PanelPendingAction[]> =>
    (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json();

  /** Вызов с решением человека; `between` — правка цели после показа карточки. */
  const decided = async (
    name: string,
    input: unknown,
    decision: 'approve' | 'reject' = 'approve',
    between?: () => void | Promise<void>,
  ): Promise<{ card?: PanelPendingAction; result: PanelActionResult }> => {
    let settled = false;
    const running = post(name, input).then((res) => {
      settled = true;
      return res.json<PanelActionResult>();
    });
    let card: PanelPendingAction | undefined;
    while (!settled && !card) {
      [card] = await listPending();
      if (!card) await new Promise((done) => setTimeout(done, 10));
    }
    if (card) {
      await between?.();
      const answered = await app.inject({
        method: 'POST',
        url: `/api/agent/pending/${card.id}`,
        headers: { origin: ORIGIN },
        payload: { decision },
      });
      expect(answered.statusCode).toBe(200);
    }
    return { ...(card ? { card } : {}), result: await running };
  };

  const fieldValues = (card?: PanelPendingAction) =>
    (card?.preview.fields ?? []).map((field) => field.value).join('\n');

  // --- Обнаружение и импорт ---

  const discovered = async () => {
    skill(join(project, '.claude', 'skills'), 'review', '## 1. Look\n\n## 2. Say');
    store.addProject({ id: 'p1', name: 'proj', path: project });
    answer = (messages) =>
      messages[0]!.content.includes(`Source: ${project.replaceAll('\\', '/')}`)
        ? block('group-discover', {
            groups: [
              {
                name: 'Review loop',
                why: 'skills used together',
                members: [
                  { kind: 'skill', id: 'ladder' },
                  { kind: 'skill', id: 'review' },
                ],
              },
            ],
          })
        : block('group-discover', { groups: [] });
    let view = await call('list_discovered_groups', {});
    for (let i = 0; i < 200 && (view.result as { running: boolean }).running; i += 1) {
      await new Promise((done) => setTimeout(done, 20));
      view = await call('list_discovered_groups', {});
    }
    return view.result as {
      running: boolean;
      groups: Array<{ key: string; name: string; status: string; members: string[] }>;
    };
  };

  it('list_discovered_groups + import_discovered_group: находка → группа проекта выключенной', async () => {
    const view = await discovered();
    const found = view.groups.find((item) => item.name === 'Review loop');
    expect(found).toMatchObject({ status: 'new', members: ['skill:ladder', 'skill:review'] });

    const { card, result } = await decided('import_discovered_group', { key: found!.key });
    expect(card?.risk).toBe('change');
    expect(card?.preview.summary).toContain('Review loop');
    expect(fieldValues(card)).toContain('skill:review');
    expect(result.outcome).toBe('done');
    const id = (result.result as { id: string }).id;
    expect(diskGroup(id)).toMatchObject({
      name: 'Review loop',
      isEnabled: false,
      scope: { kind: 'project' },
    });

    // Второй импорт той же находки — отказ до карточки, групп не прибавилось.
    const again = await call('import_discovered_group', { key: found!.key });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('already a project group');
    expect(
      disk()
        .getGroups()
        .filter((group) => group.name === 'Review loop'),
    ).toHaveLength(1);

    const unknown = await call('import_discovered_group', { key: 'no-such-key' });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.message).toContain('list_discovered_groups');
  });

  it('import_discovered_group: сегмент пути источника похож на токен — ключ доходит целым, карточка находит находку', async () => {
    // Сегмент временного каталога, который детектор секретов принял за ключ в прогоне
    // обхода 28.09: ключ находки несёт путь источника, сетка D8 прятала сегмент, и
    // импорт по такому ключу находки не находил (≈6% случайных mkdtemp-имён). Решение
    // здесь — отказ: ключ длиннее 100 знаков, а предел параметра адреса поднят только у
    // настоящей панели (`index.ts`); длинный ключ проверяет check-group-import-long-key.mjs.
    project = join(base, 'cc-agent-rules-walk-n71z0A', 'proj');
    skill(join(project, '.claude', 'skills'), 'ladder', '## 1. Read\n\n## 2. Write');
    const view = await discovered();
    const found = view.groups.find((item) => item.name === 'Review loop');
    expect(found, JSON.stringify(view)).toBeDefined();
    expect(found!.key).not.toContain('•');
    const { card, result } = await decided(
      'import_discovered_group',
      { key: found!.key },
      'reject',
    );
    expect(card?.preview.summary).toContain('Review loop');
    expect(result.outcome).toBe('rejected');
  });

  it('run_group_discovery: карточка про лимит, одобрение запускает поиск заново; отказ — нет', async () => {
    await discovered();
    const before = calls.length;
    // Источник изменился — модель должна быть позвана снова.
    skill(join(project, '.claude', 'skills'), 'extra', 'Extra.');

    const rejected = await decided('run_group_discovery', {}, 'reject');
    expect(rejected.result.outcome).toBe('rejected');
    await new Promise((done) => setTimeout(done, 100));
    expect(calls.length).toBe(before);

    const { card, result } = await decided('run_group_discovery', {});
    expect(card?.preview.summaryCode).toBe('summary-run-group-discovery');
    expect(fieldValues(card)).toContain('лимит');
    expect(result.outcome).toBe('done');
    for (let i = 0; i < 200 && calls.length === before; i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(calls.length).toBeGreaterThan(before);
  });

  // --- Копия в общие, советы, слияние ---

  const copyWithImprove = async (text: string) => {
    projectGroup();
    answer = (messages) => {
      const id = /^### skill (\S+)$/m.exec(messages[0]!.content)?.[1];
      return block('group-advice', {
        advice: [{ kind: 'skill', id, verdict: 'improve', reason: 'tighter', replacement: text }],
      });
    };
    return decided('copy_group_to_global', { id: 'proj-1' });
  };

  it('copy_group_to_global → apply_group_advice: правится только общая копия', async () => {
    const projectSkill = join(project, '.claude', 'skills', 'ladder', 'SKILL.md');
    const projectBefore = readFileSync(projectSkill, 'utf8');
    const { card, result } = await copyWithImprove(
      '---\nname: ladder\ndescription: d\n---\n\nIMPROVED\n',
    );
    expect(card?.preview.summary).toContain('Ticket flow');
    expect(fieldValues(card)).toContain('skill:ladder');
    expect(result.outcome).toBe('done');
    const copied = result.result as {
      copy: { id: string };
      advice: Array<{ member: string; verdict: string; replacement?: string }>;
    };
    expect(copied.advice).toEqual([
      expect.objectContaining({ member: 'skill:ladder', verdict: 'improve' }),
    ]);
    expect(diskGroup(copied.copy.id)?.scope ?? { kind: 'global' }).toEqual({ kind: 'global' });
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain(
      '## 1. Read',
    );

    const applied = await decided('apply_group_advice', {
      id: copied.copy.id,
      items: [{ kind: 'skill', id: 'ladder' }],
    });
    expect(applied.card?.preview.summaryCode).toBe('summary-apply-group-advice');
    expect(applied.result.outcome).toBe('done');
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain('IMPROVED');
    expect(readFileSync(projectSkill, 'utf8')).toBe(projectBefore);

    // Повтор: советов не осталось — отказ маршрута, файл тот же.
    const again = await decided('apply_group_advice', {
      id: copied.copy.id,
      items: [{ kind: 'skill', id: 'ladder' }],
    });
    expect(again.result).toMatchObject({ outcome: 'failed', status: 409 });
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain('IMPROVED');
  });

  it('copy_group_to_global общей группы — отказ до карточки, модель не звана', async () => {
    globalGroup();
    const result = await call('copy_group_to_global', { id: 'glob-1' });
    expect(result.outcome).toBe('failed');
    expect(result.message).toContain('already global');
    expect(calls).toHaveLength(0);
    expect(await listPending()).toEqual([]);
  });

  it('merge_group_origin: предложение слияния, затем apply_group_advice кладёт его в копию', async () => {
    const copy = await copyWithImprove('unused');
    const copyId = (copy.result.result as { copy: { id: string } }).copy.id;

    const nothing = await call('merge_group_origin', { id: copyId });
    expect(nothing.outcome).toBe('failed');
    expect(nothing.message).toContain('has not changed');

    writeFileSync(
      join(project, '.claude', 'skills', 'ladder', 'SKILL.md'),
      '---\nname: ladder\ndescription: d\n---\n\n## 1. Read\n\n## 2. Write\n\n## 3. Test\n',
      'utf8',
    );
    answer = () =>
      block('group-merge', {
        advice: [
          {
            kind: 'skill',
            id: 'ladder',
            verdict: 'improve',
            reason: 'merged',
            replacement: 'MERGED',
          },
        ],
      });
    const merged = await decided('merge_group_origin', { id: copyId });
    expect(merged.card?.preview.summaryCode).toBe('summary-merge-group-origin');
    expect(merged.result.outcome).toBe('done');
    expect((merged.result.result as { advice: unknown[] }).advice).toHaveLength(1);

    const applied = await decided('apply_group_advice', {
      id: copyId,
      items: [{ kind: 'skill', id: 'ladder' }],
    });
    expect(applied.result.outcome).toBe('done');
    expect(readFileSync(join(root, 'skills', 'ladder', 'SKILL.md'), 'utf8')).toContain('MERGED');

    const notCopy = await call('merge_group_origin', { id: 'proj-1' });
    expect(notCopy.outcome).toBe('failed');
    expect(notCopy.message).toContain('no original');
  });

  // --- Переопределение и включение по каталогу ---

  it('set_group_override вкл/выкл и read_group_override: файл в проекте появляется и уходит', async () => {
    projectGroup();
    globalGroup();
    answer = () => block('group-override', '# Follow the global group\n\nUse global-ladder.');
    const file = join(project, GROUP_OVERRIDE_FILE);

    const off = await call('read_group_override', { id: 'glob-1', path: project });
    expect(off.outcome).toBe('done');
    expect(off.result).toMatchObject({ enabled: false });

    const on = await decided('set_group_override', { id: 'glob-1', path: project, enabled: true });
    expect(on.card?.preview.summaryCode).toBe('summary-group-override-on');
    expect(fieldValues(on.card)).toContain(GROUP_OVERRIDE_FILE);
    expect(on.result.outcome).toBe('done');
    expect(readFileSync(file, 'utf8')).toContain('Use global-ladder.');
    expect(
      (await call('read_group_override', { id: 'glob-1', path: project })).result,
    ).toMatchObject({ enabled: true });

    const offAgain = await decided('set_group_override', {
      id: 'glob-1',
      path: project,
      enabled: false,
    });
    expect(offAgain.result.outcome).toBe('done');
    expect(existsSync(file)).toBe(false);

    const projectSide = await call('set_group_override', {
      id: 'proj-1',
      path: project,
      enabled: true,
    });
    expect(projectSide.outcome).toBe('failed');
    expect(projectSide.message).toContain('project group');
  });

  it('a folder the panel does not know — override, activation and catalog refused before a card; the folder stays byte for byte', async () => {
    const outside = join(base, 'outside');
    skill(join(outside, '.claude', 'skills'), 'ladder', '## 1. Read\n\n## 2. Write');
    mkdirSync(join(outside, '.git', 'info'), { recursive: true });
    writeFileSync(join(outside, '.git', 'info', 'exclude'), '# git ls-files --others\n', 'utf8');
    projectGroup({ scope: { kind: 'project', path: outside, provider: 'claude' } });
    globalGroup();
    globalGroup({ id: 'glob-2', isEnabled: false, projectPaths: [outside] });
    answer = () => block('group-override', '# Follow the global group\n\nUse global-ladder.');
    const before = folderSnapshot(outside);

    const seen: Record<string, unknown> = {};
    const refused: Record<string, unknown> = {};
    const inputs: Array<[string, Record<string, unknown>]> = [
      ['read_group_override', { id: 'glob-1', path: outside }],
      ['set_group_override', { id: 'glob-1', path: outside, enabled: true }],
      ['activate_groups_for_path', { path: outside }],
      ['list_resource_catalog', { path: outside }],
    ];
    for (const [name, input] of inputs) {
      // Карточку одобряем: до правки запись дошла бы до диска — это и видно.
      const { card, result } = await decided(name, input);
      const notRegistered = (result.message ?? '').includes('not registered');
      seen[name] = { carded: Boolean(card), outcome: result.outcome, notRegistered };
      refused[name] = { carded: false, outcome: 'failed', notRegistered: true };
    }
    expect(seen).toEqual(refused);
    expect(folderSnapshot(outside)).toEqual(before);
    expect(existsSync(join(outside, GROUP_OVERRIDE_FILE))).toBe(false);
    expect(diskGroup('glob-2')?.isEnabled).toBe(false);
    // Модель не звали: файл переопределения пишет она.
    expect(calls).toEqual([]);
  });

  it('activate_groups_for_path: включает привязанную выключенную; повтор — нечего включать', async () => {
    globalGroup({ isEnabled: false, projectPaths: [project] });
    const { card, result } = await decided('activate_groups_for_path', { path: project });
    expect(card?.preview.summaryCode).toBe('summary-activate-groups');
    expect(fieldValues(card)).toContain('Ticket flow (global)');
    expect(result.outcome).toBe('done');
    expect(diskGroup('glob-1')?.isEnabled).toBe(true);

    const again = await call('activate_groups_for_path', { path: project });
    expect(again.outcome).toBe('failed');
    expect(again.message).toContain('Nothing to switch on');
  });

  it('activate_groups_for_path: группу включили руками после карточки — stale_preview, ничего не выполнено', async () => {
    globalGroup({ isEnabled: false, projectPaths: [project] });
    const { result } = await decided(
      'activate_groups_for_path',
      { path: project },
      'approve',
      () => {
        // Человек включил группу руками, пока карточка висела.
        store.saveGroup({
          ...store.getGroups().find((group) => group.id === 'glob-1')!,
          isEnabled: true,
        });
      },
    );
    expect(result.outcome).toBe('failed');
    expect(result.messageCode).toBe('stale_preview');
  });

  // --- «Путь» и каталог ---

  const STEP = {
    id: 's1',
    anchor: 'work' as const,
    order: 0,
    kind: 'prompt' as const,
    title: { ru: 'Проверить ссылки', en: 'Check links' },
    prompt: { ru: 'Проверь ссылки', en: 'Check every link' },
    source: 'en' as const,
    createdAt: '2026-09-28T00:00:00.000Z',
  };

  it('promote_group_step: шаг становится скиллом и участником группы; секрет и чужой шаг — отказ', async () => {
    globalGroup({ path: { steps: [STEP] } });
    const secret = await call('promote_group_step', {
      id: 'glob-1',
      stepId: 's1',
      type: 'rule',
      draft: 'Use key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(secret.outcome).toBe('failed');
    expect(secret.message).toContain('Secret values are never accepted');

    const ghost = await call('promote_group_step', {
      id: 'glob-1',
      stepId: 'ghost',
      type: 'skill',
      draft: 'x',
    });
    expect(ghost.outcome).toBe('failed');
    expect(ghost.message).toContain('read_group');

    const draft = '---\nname: check-links\ndescription: checks links\n---\n\nCheck every link.';
    const { card, result } = await decided('promote_group_step', {
      id: 'glob-1',
      stepId: 's1',
      type: 'skill',
      draft,
    });
    expect(card?.preview.diff).toContain('Check every link.');
    expect(result.outcome).toBe('done');
    expect(readFileSync(join(root, 'skills', 'check-links', 'SKILL.md'), 'utf8')).toContain(
      'Check every link.',
    );
    const saved = diskGroup('glob-1')!;
    expect(saved.members).toContainEqual({ kind: 'skill', id: 'check-links' });
    expect(saved.path!.steps[0]).toMatchObject({ kind: 'resource' });
  });

  it('draft_group_step: карточка про лимит; до клика и после отказа — ни вызова модели, ни файла черновиков', async () => {
    globalGroup();
    answer = () =>
      block('path-step', {
        title: { ru: 'Проверка', en: 'Check' },
        prompt: { ru: 'проверить', en: 'check' },
      });
    const drafts = join(appData, 'group-path-drafts.json');
    const before = JSON.stringify(diskGroup('glob-1'));
    const asked = calls.length;
    const input = { id: 'glob-1', text: 'проверить ссылки', anchor: 'work' };

    const rejected = await decided('draft_group_step', input, 'reject', () => {
      expect(existsSync(drafts)).toBe(false);
      expect(calls.length).toBe(asked);
    });
    expect(rejected.card?.preview.summaryCode).toBe('summary-draft-group-step');
    expect(rejected.result.outcome).toBe('rejected');
    expect(existsSync(drafts)).toBe(false);
    expect(calls.length).toBe(asked);

    let pendingSeen = false;
    const { card, result } = await decided('draft_group_step', input, 'approve', () => {
      pendingSeen = true;
      expect(existsSync(drafts)).toBe(false);
      expect(calls.length).toBe(asked);
    });
    expect(pendingSeen).toBe(true);
    expect(fieldValues(card)).toContain('лимит');
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ proposal: { title: { en: 'Check' } } });
    expect(calls.length).toBe(asked + 1);
    // Одобрен — разговор ассистента записан, как у кнопки; сама группа не тронута.
    expect(existsSync(drafts)).toBe(true);
    expect(JSON.stringify(diskGroup('glob-1'))).toBe(before);
  });

  it('list_resource_catalog: общие скиллы и скиллы проекта по пути', async () => {
    const global = await call('list_resource_catalog', {});
    expect(global.outcome).toBe('done');
    const ids = (global.result as { items: Array<{ id: string; scope: string }> }).items;
    expect(ids).toContainEqual(expect.objectContaining({ id: 'global-ladder', scope: 'global' }));
    const withProject = await call('list_resource_catalog', { path: project });
    expect(
      (withProject.result as { items: Array<{ id: string; scope: string }> }).items,
    ).toContainEqual(expect.objectContaining({ id: 'ladder', scope: 'project' }));
  });
});
