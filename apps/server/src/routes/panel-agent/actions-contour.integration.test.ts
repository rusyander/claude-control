import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlatformsInfo } from '@agentdeck/contracts';
import type {
  PanelActionResult,
  PanelActionsList,
  PanelPendingAction,
} from '@agentdeck/contracts/panel-agent';
import { PANEL_AGENT_HEADER } from '@agentdeck/contracts/panel-agent';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerAccessGate } from '../../lib/access-gate.ts';
import { registerEmptyBodyGuard } from '../../lib/empty-body.ts';
import { createEventHub, type EventHub } from '../../lib/event-hub.ts';
import { allowedOrigins } from '../../lib/origin-guard.ts';
import { PlatformGateway } from '../../domains/platform/gateway/listener.ts';
import { PanelPendingActions } from '../../domains/panel-agent/pending.ts';
import { agentJournalPath } from '../../domains/panel-agent/journal.ts';
import { registerPlatformRoutes } from '../platform-routes.ts';
import { registerPanelAgentRoutes } from './panel-agent-routes.ts';

/**
 * Действия «Контур» (А6) на настоящих маршрутах контура и НАСТОЯЩЕМ upstream —
 * http-стабе на свободном порту, который, как живой контур, отказывает без
 * ключа и принимает только верный. Доказательство — `state.json` на диске,
 * след вызовов стаба и активный контур, а не текст ответа действия.
 *
 * Главное свойство: ключ, который ввёл «человек» (маршрутом мастера, с Origin
 * окна), не появляется ни в одном ответе действия, ни в строке следа, ни в
 * кадре потока событий, ни в файле каталога данных открытым текстом.
 */
const ORIGIN = 'http://localhost:8888';
/** Печатный ASCII: панель другой ключ не сохраняет. Хвост тоже ищется — маска несёт его. */
const KEY = 'HUMAN-TYPED-CONTOUR-KEY-Zq9X';
const KEY_TAIL = 'Zq9X';
const WRONG_KEY = 'HUMAN-TYPED-WRONG-KEY-Wk7Y';

interface StubCall {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** Стаб контура: каталог моделей только с верным ключом, как у платформы. */
async function startStub(): Promise<{
  url: string;
  calls: StubCall[];
  close: () => Promise<void>;
}> {
  const calls: StubCall[] = [];
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://stub').pathname;
    calls.push({
      method: request.method ?? '',
      path,
      authorization: request.headers.authorization,
    });
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    request.resume();
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${KEY}`) {
        send(401, { error: { message: 'invalid API key', type: 'authentication_error' } });
        return;
      }
      if (path.endsWith('/models')) {
        send(200, { object: 'list', data: [{ id: 'stub-chat', kind: 'chat' }] });
        return;
      }
      send(404, { error: { message: 'no such route' } });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('panel-agent actions: contour', () => {
  let root: string;
  let appData: string;
  let store: AppStore;
  let hub: EventHub;
  let frames: string[];
  let pending: PanelPendingActions;
  let gateway: PlatformGateway;
  let app: FastifyInstance;
  let stub: Awaited<ReturnType<typeof startStub>>;
  const results: string[] = [];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-agent-a6-'));
    appData = join(root, 'agentdeck');
    mkdirSync(appData, { recursive: true });
    store = new AppStore(appData);
    // Порт 0: живой шлюз панели на этой машине не должен увести тест к себе.
    store.updateSettings({ platformGateway: { ...store.getSettings().platformGateway, port: 0 } });
    stub = await startStub();
    results.length = 0;

    hub = createEventHub();
    frames = [];
    hub.subscribe((payload) => frames.push(payload));
    pending = new PanelPendingActions(10_000);
    gateway = new PlatformGateway();
    const ctx = {
      store,
      backupDir: join(root, 'backups'),
      location: { paths: { root, appData, settings: join(root, 'settings.json') } },
    } as unknown as ServerContext;
    const access = {
      allowedOrigins: allowedOrigins(8888),
      requiresToken: () => false,
      expectedToken: () => '',
    };
    app = Fastify();
    registerAccessGate(app, access);
    registerEmptyBodyGuard(app);
    registerPlatformRoutes(app, ctx, gateway);
    registerPanelAgentRoutes(app, ctx, { hub, pending, access });
    await app.ready();
  });

  afterEach(async () => {
    pending.cancelAll();
    await gateway.stop();
    await app.close();
    await stub.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Вызов действия так, как его шлёт переходник. Ответ копится для поиска ключа. */
  const call = async (name: string, input: unknown): Promise<PanelActionResult> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/actions/${name}`,
      headers: { [PANEL_AGENT_HEADER]: '1' },
      payload: { input },
    });
    expect(res.statusCode).toBe(200);
    results.push(res.body);
    return res.json<PanelActionResult>();
  };

  const waitPending = async (): Promise<PanelPendingAction> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const list = (await app.inject({ method: 'GET', url: '/api/agent/pending' })).json<
        PanelPendingAction[]
      >();
      if (list[0]) return list[0];
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('карточка так и не появилась');
  };

  /** Клик в окне панели: Origin своего интерфейса, без пометки агента. */
  const decide = async (id: string, decision: 'approve' | 'reject'): Promise<void> => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/agent/pending/${id}`,
      headers: { origin: ORIGIN },
      payload: { decision },
    });
    expect(res.statusCode).toBe(200);
  };

  /** Сохранить черновик с решением человека. */
  const saveDraft = async (input: unknown, decision: 'approve' | 'reject') => {
    const called = call('save_contour_draft', input);
    const card = await waitPending();
    await decide(card.id, decision);
    return { card, result: await called };
  };

  /** Человек вводит ключ в мастере: тот же маршрут и тело, что шлёт окно. */
  const humanTypesKey = async (id: string, token: string): Promise<void> => {
    const info = (await app.inject({ method: 'GET', url: '/api/platforms' })).json<PlatformsInfo>();
    const platform = info.platforms.find((status) => status.platform.id === id)!.platform;
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/platforms/${id}`,
      headers: { origin: ORIGIN },
      payload: { settings: platform, token },
    });
    expect(saved.statusCode).toBe(200);
    const probed = await app.inject({
      method: 'POST',
      url: `/api/platforms/${id}/check`,
      headers: { origin: ORIGIN },
    });
    expect(probed.statusCode).toBe(200);
  };

  const stateOnDisk = (): { settings?: { platforms?: Array<{ id: string; baseUrl: string }> } } => {
    try {
      return JSON.parse(readFileSync(join(appData, 'state.json'), 'utf8')) as never;
    } catch {
      return {};
    }
  };
  const platformsOnDisk = () => stateOnDisk().settings?.platforms ?? [];

  /** Весь каталог данных открытым текстом: ключ лежит только зашифрованным. */
  const appDataText = (): string => {
    const texts: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else texts.push(readFileSync(full, 'utf8'));
      }
    };
    walk(appData);
    return texts.join('\n');
  };

  const assertNoKeyAnywhere = (): void => {
    const journal = readFileSync(agentJournalPath(appData), 'utf8');
    for (const [where, text] of [
      ['action results', results.join('\n')],
      ['journal', journal],
      ['event frames', frames.join('\n')],
      ['app data files', appDataText()],
    ] as const) {
      expect(text, where).not.toContain(KEY);
      expect(text, where).not.toContain(WRONG_KEY);
      expect(text, where).not.toContain(KEY_TAIL);
    }
  };

  it('действия контура в реестре; ни в одной схеме входа нет поля ключа', async () => {
    const { actions } = (
      await app.inject({ method: 'GET', url: '/api/agent/actions' })
    ).json<PanelActionsList>();
    const contour = actions.filter((action) => action.section === 'contour');
    expect(contour.map((action) => [action.name, action.risk])).toEqual([
      ['list_contours', 'read'],
      ['contour_status', 'read'],
      ['probe_contour_url', 'read'],
      ['save_contour_draft', 'change'],
      ['enable_contour', 'danger'],
    ]);
    expect(JSON.stringify(contour.map((action) => action.inputSchema))).not.toMatch(
      /token|key|secret|password/i,
    );
  });

  it('черновик без решения человека не сохраняется: отклонено — на диске пусто, в контур ни шагу', async () => {
    const { card, result } = await saveDraft({ baseUrl: `${stub.url}/v1`, title: 'Dev' }, 'reject');
    // Карточка показывает то, что запишет маршрут, включая «ключ вводите вы».
    expect(card.risk).toBe('change');
    const fields = Object.fromEntries(card.preview.fields.map((f) => [f.label, f.value]));
    expect(fields['Адрес']).toBe(`${stub.url}/v1`);
    expect(fields['Идентификатор']).toBe('127.0.0.1');
    expect(fields['Ключ']).toMatch(/вводите вы/);
    // А9 D4: подписи кодом, фразы панели — кодом значения; данные (адрес) как есть.
    expect(card.preview.summaryCode).toBe('summary-contour-draft-save');
    for (const field of card.preview.fields) expect(field.labelCode).toBeDefined();
    expect(card.preview.fields).toContainEqual(
      expect.objectContaining({ labelCode: 'label-key', valueCode: 'value-key-by-you' }),
    );
    expect(result.outcome).toBe('rejected');
    expect(platformsOnDisk()).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it('одобренный черновик ложится на диск, исход needs-secret открывает поле ключа; ключ агенту не виден', async () => {
    const { result } = await saveDraft(
      { baseUrl: `${stub.url}/v1`, title: 'Dev stand', id: 'dev', consumers: ['assistant'] },
      'approve',
    );
    expect(result.outcome).toBe('needs-secret');
    expect(result.page).toEqual({ route: '/platform', focus: 'contour-key:dev' });
    expect(result.result).toMatchObject({ saved: true, id: 'dev', key: 'missing', active: false });
    // Состояние на диске — выключенный черновик с адресом из ссылки.
    expect(platformsOnDisk()).toEqual([
      expect.objectContaining({ id: 'dev', baseUrl: `${stub.url}/v1`, enabled: false }),
    ]);
    // Окно получило кадр открытия поля ключа.
    const opened = frames.map((f) => JSON.parse(f) as Record<string, unknown>);
    expect(opened).toContainEqual(
      expect.objectContaining({
        type: 'agent-open-page',
        page: { route: '/platform', focus: 'contour-key:dev' },
      }),
    );
    const journal = readFileSync(agentJournalPath(appData), 'utf8');
    expect(journal).toContain('"outcome":"needs-secret"');

    // Проба без ключа доходит до стаба и подтверждает адрес, не бракуя ключ.
    const probe = await call('probe_contour_url', { id: 'dev' });
    expect(probe.outcome).toBe('done');
    expect(probe.result).toMatchObject({ outcome: 'no-key' });
    expect(stub.calls.at(-1)).toMatchObject({ path: '/v1/models', authorization: undefined });

    // Человек вводит НЕВЕРНЫЙ ключ — агент узнаёт только «отклонён».
    await humanTypesKey('dev', WRONG_KEY);
    expect((await call('contour_status', { id: 'dev' })).result).toMatchObject({
      found: true,
      key: 'rejected',
    });

    // Верный — «принят»; ключ ушёл в стаб заголовком, и только туда.
    await humanTypesKey('dev', KEY);
    expect((await call('contour_status', { id: 'dev' })).result).toMatchObject({ key: 'accepted' });
    expect(stub.calls.at(-1)).toMatchObject({ authorization: `Bearer ${KEY}` });
    const listed = await call('list_contours', {});
    expect(listed.result).toMatchObject({ contours: [{ id: 'dev', key: 'accepted' }] });

    // Повторный черновик того же контура — ключ уже лежит: не needs-secret, «ключ сохранён».
    const again = await saveDraft(
      { baseUrl: `${stub.url}/v1`, id: 'dev', title: 'Dev 2' },
      'approve',
    );
    expect(again.result.outcome).toBe('done');
    expect(again.result.result).toMatchObject({ note: 'ключ сохранён', title: 'Dev 2' });

    assertNoKeyAnywhere();
  });

  it('смена адреса контура с сохранённым ключом — отказ до карточки, адрес на диске прежний', async () => {
    await saveDraft({ baseUrl: `${stub.url}/v1`, id: 'dev' }, 'approve');
    await humanTypesKey('dev', KEY);
    const callsBefore = stub.calls.length;

    const moved = await call('save_contour_draft', { baseUrl: 'http://127.0.0.1:9/v1', id: 'dev' });
    expect(moved.outcome).toBe('failed');
    expect(moved.message).toMatch(/already has a stored key/);
    expect((await app.inject({ method: 'GET', url: '/api/agent/pending' })).json()).toEqual([]);
    expect(platformsOnDisk()[0]?.baseUrl).toBe(`${stub.url}/v1`);
    expect(stub.calls.length).toBe(callsBefore);
    assertNoKeyAnywhere();
  });

  it('включение без решения человека контур не включает; без ключа — отказ до карточки', async () => {
    await saveDraft({ baseUrl: `${stub.url}/v1`, id: 'dev' }, 'approve');

    const noKey = await call('enable_contour', { id: 'dev' });
    expect(noKey.outcome).toBe('failed');
    expect(noKey.message).toMatch(/no key yet/);
    expect(store.getSettings().activePlatformId).toBe('');

    await humanTypesKey('dev', KEY);
    const called = call('enable_contour', { id: 'dev' });
    const card = await waitPending();
    expect(card.risk).toBe('danger');
    expect(card.preview.fields.find((f) => f.label === 'Ключ')?.value).toBe(
      'сохранён, принят пробой',
    );
    await decide(card.id, 'reject');
    expect((await called).outcome).toBe('rejected');
    expect(store.getSettings().activePlatformId).toBe('');
    expect(new AppStore(appData).getSettings().activePlatformId).toBe('');

    assertNoKeyAnywhere();
  });

  it('одобренное включение делает контур активным — на диске, а не в тексте ответа', async () => {
    await saveDraft({ baseUrl: `${stub.url}/v1`, id: 'dev' }, 'approve');
    await humanTypesKey('dev', KEY);

    const called = call('enable_contour', { id: 'dev' });
    await decide((await waitPending()).id, 'approve');
    const result = await called;
    expect(result.outcome).toBe('done');
    expect(result.result).toMatchObject({ activeContourId: 'dev', probe: { outcome: 'ok' } });
    expect(new AppStore(appData).getSettings().activePlatformId).toBe('dev');

    assertNoKeyAnywhere();
  }, 30_000);

  it('D2: включение применяет потребителей — ассистент панели ходит через контур, как после «Готово» мастера', async () => {
    await saveDraft({ baseUrl: `${stub.url}/v1`, id: 'dev', consumers: ['assistant'] }, 'approve');
    await humanTypesKey('dev', KEY);

    const called = call('enable_contour', { id: 'dev' });
    const card = await waitPending();
    // Карточка называет, к кому контур применится.
    expect(card.preview.fields.find((f) => f.label === 'Где работает')?.value).toBe('assistant');
    await decide(card.id, 'approve');
    const result = await called;
    expect(result.outcome).toBe('done');
    const settings = new AppStore(appData).getSettings();
    expect(settings.activePlatformId).toBe('dev');
    // Доказательство — настройки на диске: ассистент указывает на профиль контура.
    expect(settings.assistantEndpointId).not.toBe('');
    expect(
      settings.endpointProfiles?.find((profile) => profile.id === settings.assistantEndpointId),
    ).toBeTruthy();
    expect(settings.platforms?.find((platform) => platform.id === 'dev')?.targets).toEqual([
      'assistant',
    ]);
    expect(result.result).toMatchObject({ applied: ['assistant'], skipped: [] });

    // Правка активного контура агентом тоже применяет потребителей, как «Готово» мастера.
    const edited = await saveDraft(
      { baseUrl: `${stub.url}/v1`, id: 'dev', title: 'Dev 2', consumers: ['assistant'] },
      'approve',
    );
    expect(edited.result).toMatchObject({
      outcome: 'done',
      result: { active: true, consumersApplied: { applied: ['assistant'], skipped: [] } },
    });
    expect(new AppStore(appData).getSettings().assistantEndpointId).toBe(
      settings.assistantEndpointId,
    );

    assertNoKeyAnywhere();
  }, 30_000);

  it('карточка устарела: человек поменял контур после показа — stale_preview, на диске его правка', async () => {
    await saveDraft({ baseUrl: `${stub.url}/v1`, id: 'dev', title: 'Dev' }, 'approve');
    /** Человек в мастере меняет название — тем же маршрутом, что окно. */
    const humanRenames = async (title: string): Promise<void> => {
      const info = (
        await app.inject({ method: 'GET', url: '/api/platforms' })
      ).json<PlatformsInfo>();
      const platform = info.platforms.find((status) => status.platform.id === 'dev')!.platform;
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/platforms/dev',
        headers: { origin: ORIGIN },
        payload: { settings: { ...platform, title } },
      });
      expect(saved.statusCode).toBe(200);
    };

    const drafting = call('save_contour_draft', {
      baseUrl: `${stub.url}/v1`,
      id: 'dev',
      title: 'Название агента',
    });
    const draftCard = await waitPending();
    await humanRenames('Название человека');
    await decide(draftCard.id, 'approve');
    expect(await drafting).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(platformsOnDisk()[0]).toMatchObject({ id: 'dev', title: 'Название человека' });

    await humanTypesKey('dev', KEY);
    const enabling = call('enable_contour', { id: 'dev' });
    const enableCard = await waitPending();
    await humanRenames('Ещё раз человек');
    await decide(enableCard.id, 'approve');
    expect(await enabling).toMatchObject({ outcome: 'failed', messageCode: 'stale_preview' });
    expect(new AppStore(appData).getSettings().activePlatformId).toBe('');
    expect(platformsOnDisk()[0]).toMatchObject({ title: 'Ещё раз человек' });
    const journal = readFileSync(agentJournalPath(appData), 'utf8').trim().split('\n');
    expect(JSON.parse(journal.at(-1) ?? '{}')).toMatchObject({
      name: 'enable_contour',
      outcome: 'failed',
      messageCode: 'stale_preview',
    });

    assertNoKeyAnywhere();
  });
});
