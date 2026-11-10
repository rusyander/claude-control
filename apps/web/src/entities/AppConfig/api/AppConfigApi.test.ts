import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { appSettingsSchema, type AppSettings, type AppSettingsPatch } from '@agentdeck/contracts';
import { queryKeys } from '@shared/api/query-keys';
import { apiClient } from '@shared/api/client';
import { applySettingsUpdate } from '../lib/applySettingsUpdate';
import { changedSettings } from '../lib/changedSettings';
import { refreshSettingsFromServer } from '../lib/refreshSettingsFromServer';
import { hasUnsentSettings, sendSettingsPatch } from '../lib/sendSettingsPatch';
import { patchSettings } from '../lib/patchSettings';

describe('patchSettings — PATCH переживает перезагрузку страницы', () => {
  it('обычный патч уходит fetch-запросом с keepalive', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: settings({}) });
    await patchSettings({ theme: 'dark' });
    expect(patch).toHaveBeenCalledWith(
      '/settings',
      { theme: 'dark' },
      { adapter: 'fetch', fetchOptions: { keepalive: true } },
    );
    patch.mockRestore();
  });

  it('патч больше предела keepalive уходит обычным запросом', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ data: settings({}) });
    const big = { claudeDir: 'x'.repeat(60_000) } as AppSettingsPatch;
    await patchSettings(big);
    expect(patch).toHaveBeenCalledWith('/settings', big, undefined);
    patch.mockRestore();
  });
});

const settings = (patch: Partial<AppSettings>): AppSettings => appSettingsSchema.parse(patch);

/** Кеш, каким он остаётся после открытых разделов прошлого провайдера. */
function seed(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(queryKeys.providerRules, ['cursor rule']);
  client.setQueryData(queryKeys.providerRule('team.mdc'), 'cursor rule body');
  client.setQueryData(queryKeys.providerMcp, ['cursor mcp']);
  client.setQueryData(queryKeys.providerHooks, ['cursor hook']);
  client.setQueryData(queryKeys.providerSkills, ['cursor skill']);
  client.setQueryData(queryKeys.providerEnv, ['cursor env']);
  client.setQueryData(queryKeys.providerPermissions, ['cursor permission']);
  client.setQueryData(queryKeys.providerInstructions, ['cursor instructions']);
  client.setQueryData(queryKeys.providerPlugins, ['cursor plugin']);
  client.setQueryData(queryKeys.models, ['cursor model']);
  client.setQueryData(queryKeys.claudeMd, { content: 'cursor instructions file' });
  client.setQueryData(queryKeys.projectProviderRules('p1'), ['cursor project rule']);
  client.setQueryData(queryKeys.projectProviderMcp('p1'), ['cursor project mcp']);
  // Поиск идёт по разделам активного провайдера — выдача тоже устаревает.
  client.setQueryData(queryKeys.search('mcp'), { results: ['cursor hit'] });
  // Не зависят от активного провайдера — переживают переключение.
  client.setQueryData(queryKeys.rules, ['claude rule']);
  client.setQueryData(queryKeys.overview, { rules: { total: 1 } });
  client.setQueryData(queryKeys.projectRules('p1'), 'claude project md');
  client.setQueryData(queryKeys.formatCheck, { report: 'shared' });
  return client;
}

const PROVIDER_SCOPED = [
  queryKeys.providerRules,
  queryKeys.providerRule('team.mdc'),
  queryKeys.providerMcp,
  queryKeys.providerHooks,
  queryKeys.providerSkills,
  queryKeys.providerEnv,
  queryKeys.providerPermissions,
  queryKeys.providerInstructions,
  queryKeys.providerPlugins,
  queryKeys.models,
  queryKeys.claudeMd,
  queryKeys.projectProviderRules('p1'),
  queryKeys.projectProviderMcp('p1'),
  queryKeys.search('mcp'),
];

describe('applySettingsUpdate', () => {
  it('сбрасывает кеш разделов прошлого провайдера при переключении', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    // Иначе раздел рисуется файлами Cursor, а «Сохранить» уходит в конфиг Codex.
    for (const key of PROVIDER_SCOPED) {
      expect(client.getQueryData(key), key.join('/')).toBeUndefined();
    }
  });

  it('не трогает разделы, не зависящие от провайдера', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    expect(client.getQueryData(queryKeys.rules)).toEqual(['claude rule']);
    expect(client.getQueryData(queryKeys.overview)).toEqual({ rules: { total: 1 } });
    expect(client.getQueryData(queryKeys.projectRules('p1'))).toBe('claude project md');
    expect(client.getQueryData(queryKeys.formatCheck)).toEqual({ report: 'shared' });
  });

  it('статус API-ключей переживает переключение провайдера', () => {
    // Имя ключа начинается на `provider-`, но раздел отдаёт ключи ВСЕХ
    // провайдеров сразу: сброс гасил бы форму вместе с введённым ключом.
    const client = seed();
    client.setQueryData(queryKeys.providerKeys, [{ id: 'codex', hasKey: true }]);

    applySettingsUpdate(client, settings({ provider: 'codex' }), { provider: 'codex' });

    expect(client.getQueryData(queryKeys.providerKeys)).toEqual([{ id: 'codex', hasKey: true }]);
  });

  it('правка темы кеш разделов не сбрасывает', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ theme: 'dark' }), { theme: 'dark' });

    expect(client.getQueryData(queryKeys.providerRules)).toEqual(['cursor rule']);
    expect(client.getQueryData(queryKeys.models)).toEqual(['cursor model']);
  });

  it('смена источника каталога помечает каталог устаревшим', () => {
    // Ключ каталога источника не содержит, а `staleTime` у него десять минут:
    // без сброса переключение «models.dev ↔ контур» десять минут не меняло на
    // экране ничего, кроме подписи поля, и человек шёл жать «Обновить» — то
    // есть в контур, куда панель сама ходить не должна.
    const client = seed();

    applySettingsUpdate(client, settings({ modelSource: 'platform' }), {
      modelSource: 'platform',
    });

    expect(client.getQueryState(queryKeys.models)?.isInvalidated).toBe(true);
  });

  it('смена выбранного контура помечает каталог устаревшим', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ modelSourcePlatform: 'enterprise-platform' }), {
      modelSourcePlatform: 'enterprise-platform',
    });

    expect(client.getQueryState(queryKeys.models)?.isInvalidated).toBe(true);
  });

  it('правка темы каталог устаревшим не делает', () => {
    const client = seed();

    applySettingsUpdate(client, settings({ theme: 'dark' }), { theme: 'dark' });

    expect(client.getQueryState(queryKeys.models)?.isInvalidated).toBe(false);
  });

  it('ответ сервера кладётся в кеш настроек сразу', () => {
    const client = seed();
    const next = settings({ theme: 'dark' });

    applySettingsUpdate(client, next, { theme: 'dark' });

    expect(client.getQueryData(queryKeys.settings)).toBe(next);
  });
});

/** Ответ сервера, который тест отпускает сам — в нужном ему порядке. */
function deferred(): { promise: Promise<AppSettings>; resolve: (value: AppSettings) => void } {
  let resolve: (value: AppSettings) => void = () => {};
  const promise = new Promise<AppSettings>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sendSettingsPatch — очередь быстрых правок (F-28)', () => {
  it('вторая правка уходит только после ответа на первую, в кеше — последний ответ', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({}));
    const first = deferred();
    const second = deferred();
    const replies = [first.promise, second.promise];
    const send = vi.fn(() => replies.shift() as Promise<AppSettings>);
    const both = settings({ theme: 'dark', language: 'en' });

    const a = sendSettingsPatch(client, { theme: 'dark' }, send);
    const b = sendSettingsPatch(client, { language: 'en' }, send);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    // Правка видна сразу, до ответа сервера.
    expect(client.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
      theme: 'dark',
      language: 'en',
    });
    first.resolve(settings({ theme: 'dark' }));
    await a;
    await new Promise((done) => setTimeout(done, 0));
    expect(send).toHaveBeenCalledTimes(2);
    // Промежуточный ответ не знает о второй правке и не откатывает её на экране.
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.language).toBe('en');
    second.resolve(both);
    await b;

    expect(client.getQueryData(queryKeys.settings)).toEqual(both);
  });

  // Набор адреса по букве на медленном сервере: пока первый запрос в пути,
  // остальные буквы копятся в один следующий, а не в хвост из десятков PATCH.
  it('правки, сделанные пока запрос в пути, уходят одним запросом', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({}));
    const first = deferred();
    const send = vi
      .fn<(patch: AppSettingsPatch) => Promise<AppSettings>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (patch) => settings({ ...patch }));

    const a = sendSettingsPatch(client, { theme: 'dark' }, send);
    const b = sendSettingsPatch(client, { language: 'en' }, send);
    const c = sendSettingsPatch(client, { theme: 'light', backupKeep: 3 }, send);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve(settings({ theme: 'dark' }));
    const [, second, third] = await Promise.all([a, b, c]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ language: 'en', theme: 'light', backupKeep: 3 });
    expect(second).toBe(third);
    expect(client.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
      theme: 'light',
      language: 'en',
      backupKeep: 3,
    });
  });

  // F5 стирает только неушедшую правку: ушедший PATCH доводит keepalive (patchSettings).
  it('неушедшая правка держит защиту ухода со страницы, пока запрос не ушёл', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({}));
    const first = deferred();
    const send = vi
      .fn<(patch: AppSettingsPatch) => Promise<AppSettings>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (patch) => settings({ ...patch }));

    const a = sendSettingsPatch(client, { theme: 'dark' }, send);
    expect(hasUnsentSettings()).toBe(false);
    const b = sendSettingsPatch(client, { language: 'en' }, send);
    expect(hasUnsentSettings()).toBe(true);
    first.resolve(settings({ theme: 'dark' }));
    await Promise.all([a, b]);

    expect(hasUnsentSettings()).toBe(false);
  });

  it('правка после ухода слитого запроса не теряется, а уходит своим', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({}));
    const first = deferred();
    const second = deferred();
    const send = vi
      .fn<(patch: AppSettingsPatch) => Promise<AppSettings>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockImplementation(async (patch) => settings({ ...patch }));

    const a = sendSettingsPatch(client, { theme: 'dark' }, send);
    const b = sendSettingsPatch(client, { language: 'en' }, send);
    first.resolve(settings({ theme: 'dark' }));
    await a;
    await new Promise((done) => setTimeout(done, 0));
    expect(send).toHaveBeenCalledTimes(2);
    // Второй запрос уже в пути: новая правка в него не дописывается.
    const c = sendSettingsPatch(client, { backupKeep: 3 }, send);
    second.resolve(settings({ theme: 'dark', language: 'en' }));
    await Promise.all([b, c]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith({ backupKeep: 3 });
  });

  it('промежуточный ответ всё равно сбрасывает разделы прошлого провайдера', async () => {
    const client = seed();
    const first = deferred();
    const second = deferred();
    const replies = [first.promise, second.promise];
    const send = vi.fn(() => replies.shift() as Promise<AppSettings>);

    const a = sendSettingsPatch(client, { provider: 'codex' }, send);
    const b = sendSettingsPatch(client, { theme: 'dark' }, send);
    first.resolve(settings({ provider: 'codex' }));
    await a;
    expect(client.getQueryData(queryKeys.providerRules)).toBeUndefined();
    second.resolve(settings({ provider: 'codex', theme: 'dark' }));
    await b;
  });

  it('отказ последней правки перечитывает настройки, следующая правка всё равно уходит', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({}));
    const send = vi
      .fn<(patch: AppSettingsPatch) => Promise<AppSettings>>()
      .mockRejectedValueOnce(new Error('400'))
      .mockImplementation(async (patch) => settings({ theme: patch.theme }));

    await expect(sendSettingsPatch(client, { theme: 'dark' }, send)).rejects.toThrow('400');
    expect(client.getQueryState(queryKeys.settings)?.isInvalidated).toBe(true);

    await sendSettingsPatch(client, { theme: 'light' }, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.theme).toBe('light');
  });
});

/**
 * Сервер-подделка с поверхностным слиянием, как `store.updateSettings`: поле из
 * патча заменяется целиком. Ответы отпускает тест — в любом порядке.
 */
function shallowServer(initial: AppSettings) {
  let state = initial;
  const replies: Array<() => void> = [];
  const seen: AppSettingsPatch[] = [];
  const send = (patch: AppSettingsPatch): Promise<AppSettings> => {
    seen.push(patch);
    state = { ...state, ...patch };
    const snapshot = state;
    return new Promise((resolve) => replies.push(() => resolve(snapshot)));
  };
  return { send, seen, replies, state: () => state };
}

const endpoint = (id: string, patch: Partial<AppSettings['endpointProfiles'][number]> = {}) => ({
  id,
  name: id,
  baseUrl: 'http://127.0.0.1:11434/v1',
  apiKind: 'openai-compat' as const,
  model: '',
  writeToken: false,
  imagesUrl: '',
  ownerPlatformId: '',
  ...patch,
});

/** Правка, как её собирает карточка эндпоинта: список из кеша в момент правки. */
function editProfiles(
  client: QueryClient,
  edit: (list: AppSettings['endpointProfiles']) => AppSettings['endpointProfiles'],
  send: (patch: AppSettingsPatch) => Promise<AppSettings>,
): Promise<AppSettings> {
  const list = client.getQueryData<AppSettings>(queryKeys.settings)?.endpointProfiles ?? [];
  return sendSettingsPatch(client, { endpointProfiles: edit(list) }, send);
}

describe('sendSettingsPatch — правки внахлёст одного поля-списка', () => {
  // Имя, затем адрес профиля — до ответа на первую правку. Сервер заменяет
  // `endpointProfiles` целиком: вторая правка из кеша без первой стирала имя.
  it('две быстрые правки профиля эндпоинта обе доходят до сервера и до кеша', async () => {
    const client = seed();
    const start = settings({ endpointProfiles: [endpoint('ep-1')] });
    client.setQueryData(queryKeys.settings, start);
    const server = shallowServer(start);
    const rename = (list: AppSettings['endpointProfiles']) =>
      list.map((item) => (item.id === 'ep-1' ? { ...item, name: 'Шлюз' } : item));
    const readdress = (list: AppSettings['endpointProfiles']) =>
      list.map((item) =>
        item.id === 'ep-1' ? { ...item, baseUrl: 'http://127.0.0.1:8080' } : item,
      );

    const a = editProfiles(client, rename, server.send);
    const b = editProfiles(client, readdress, server.send);
    // Обе правки сделаны до первого ответа; ответы отпускаются по одному.
    for (let i = 0; i < 10; i += 1) {
      server.replies.shift()?.();
      await new Promise((done) => setTimeout(done, 0));
    }
    await Promise.all([a, b]);

    const want = { name: 'Шлюз', baseUrl: 'http://127.0.0.1:8080' };
    expect(server.state().endpointProfiles[0]).toMatchObject(want);
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.endpointProfiles[0]).toMatchObject(
      want,
    );
  });
});

describe('настройки, сменённые снаружи (соседняя вкладка, телефон)', () => {
  it('changedSettings — только различающиеся поля, вложенные сравниваются по значению', () => {
    const before = settings({ language: 'ru', theme: 'light' });
    const after = { ...settings({ language: 'en', theme: 'light' }), dlp: { ...before.dlp } };
    expect(changedSettings(before, after)).toEqual({ language: 'en' });
    expect(changedSettings(before, structuredClone(before))).toEqual({});
  });

  it('язык из другой вкладки попадает в кеш, смена провайдера сбрасывает разделы чужого CLI', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({ language: 'ru', provider: 'cursor' }));
    const outside = settings({ language: 'en', provider: 'claude' });
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: outside });
    await refreshSettingsFromServer(client);
    expect(get).toHaveBeenCalledWith('/settings');
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.language).toBe('en');
    expect(client.getQueryData(queryKeys.providerRules)).toBeUndefined();
    get.mockRestore();
  });

  it('своё эхо (кеш уже равен серверу) ничего не сбрасывает', async () => {
    const client = seed();
    const same = settings({ language: 'ru', provider: 'cursor' });
    client.setQueryData(queryKeys.settings, same);
    const get = vi.spyOn(apiClient, 'get').mockResolvedValue({ data: structuredClone(same) });
    await refreshSettingsFromServer(client);
    expect(client.getQueryData(queryKeys.providerRules)).toEqual(['cursor rule']);
    get.mockRestore();
  });

  /**
   * Каждый PATCH сервер отражает в поток событий, и панель перечитывает
   * настройки. Эхо, пришедшее, пока правки ещё в пути, несёт промежуточное
   * состояние сервера: положенное в кеш, оно стирало буквы поля адреса прямо
   * под пальцами (живой прогон: «http://…» превращался в «ttp://127»).
   */
  it('эхо, пришедшее пока свои правки в пути, не откатывает набранное', async () => {
    const client = seed();
    const start = settings({ endpointProfiles: [endpoint('ep-1', { baseUrl: '' })] });
    client.setQueryData(queryKeys.settings, start);
    const server = shallowServer(start);
    const type = (value: string) =>
      editProfiles(
        client,
        (list) => list.map((item) => ({ ...item, baseUrl: value })),
        server.send,
      );

    const a = type('h');
    // Эхо первой правки: сервер уже записал «h», вторая буква ещё не ушла.
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async () => {
      void type('ht');
      await new Promise((done) => setTimeout(done, 0));
      return { data: { ...start, endpointProfiles: [endpoint('ep-1', { baseUrl: 'h' })] } };
    });
    await refreshSettingsFromServer(client);
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.endpointProfiles[0]?.baseUrl).toBe(
      'ht',
    );
    for (let i = 0; i < 10; i += 1) {
      server.replies.shift()?.();
      await new Promise((done) => setTimeout(done, 0));
    }
    await a;
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.endpointProfiles[0]?.baseUrl).toBe(
      'ht',
    );
    get.mockRestore();
  });

  it('отброшенное эхо не раскладывает разницу: разделы сбросит ответ своей правки', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({ provider: 'cursor' }));
    let release: (value: { data: AppSettings }) => void = () => {};
    const get = vi
      .spyOn(apiClient, 'get')
      .mockImplementation(() => new Promise((done) => (release = done)));
    // Перечитывание началось до правки, сервер ответил до её записи.
    const refresh = refreshSettingsFromServer(client);
    let reply: (value: AppSettings) => void = () => {};
    const edit = sendSettingsPatch(
      client,
      { provider: 'claude' },
      () => new Promise((done) => (reply = done)),
    );
    release({ data: settings({ provider: 'cursor' }) });
    await refresh;
    // Сервер ещё не ответил: сбрасывать разделы прошлого CLI рано — перечитаны
    // они были бы с сервера, который ещё на нём.
    expect(client.getQueryData(queryKeys.providerRules)).toEqual(['cursor rule']);
    reply(settings({ provider: 'claude' }));
    await edit;
    expect(client.getQueryData(queryKeys.providerRules)).toBeUndefined();
    get.mockRestore();
  });

  it('чтение, начатое до правки и пришедшее после её ответа, правку не откатывает', async () => {
    const client = seed();
    client.setQueryData(queryKeys.settings, settings({ theme: 'light' }));
    let release: (value: { data: AppSettings }) => void = () => {};
    const get = vi
      .spyOn(apiClient, 'get')
      .mockImplementation(() => new Promise((done) => (release = done)));
    const refresh = refreshSettingsFromServer(client);
    await sendSettingsPatch(client, { theme: 'dark' }, async () => settings({ theme: 'dark' }));
    release({ data: settings({ theme: 'light' }) });
    await refresh;
    expect(client.getQueryData<AppSettings>(queryKeys.settings)?.theme).toBe('dark');
    get.mockRestore();
  });
});
