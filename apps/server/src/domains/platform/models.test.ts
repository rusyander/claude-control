import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Platform, PlatformHealthRecord } from '@agentdeck/contracts';
import { catalogChatModels, chooseRunModel } from '@agentdeck/contracts/platform-models';
import { AppStore } from '../../lib/app-store.ts';
import { buildManagedProfile } from './apply/profile.ts';
import { writePlatform } from './store.ts';
import {
  chatModels,
  defaultModelOf,
  effortAccepted,
  modelRulesFor,
  toolRouteOf,
} from './models.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Модель прогона через контур (Т6): чем он пойдёт и почему именно этим.
 *
 * Проверяется то, из-за чего решение вообще появилось: имя панели («sonnet»)
 * контуру неизвестно, уходит в `--model` и перебивает адресную переменную — 403
 * «модель» на каждом сообщении. Поэтому здесь важен не столько выбранный
 * идентификатор, сколько признак `replaced`: это единственное, из чего человек
 * узнаёт о подмене, и потерять его молча дороже, чем выбрать не ту модель.
 */

const PLATFORM: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  consumers: ['chat'],
  projectPaths: [],
  agents: [],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  defaultModel: '',
  consumerModels: {},
  modelMap: {},
  rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
  caCertPath: '',
  transport: defaultPlatformTransport(),
};

const health = (
  models: { id: string; kind?: string; retired?: boolean; imageGeneration?: boolean }[],
): PlatformHealthRecord => ({
  outcome: 'ok',
  reachable: true,
  url: 'https://api.dev.example.ru/v1/models',
  detail: '',
  models,
  capabilities: [],
  limits: {},
  notes: [],
  compromises: [],
  checkedAt: '2026-09-12T10:00:00.000Z',
});

let root: string;
let store: AppStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-contour-models-'));
  const dir = join(root, 'agentdeck');
  mkdirSync(dir, { recursive: true });
  store = new AppStore(dir);
  writePlatform(store, PLATFORM);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('каталог: чем можно вести разговор', () => {
  it('вложения и пропавшие модели в выбор не попадают', () => {
    const models = catalogChatModels([
      { id: 'enterprise-platform-large' },
      { id: 'bge-m3', kind: 'Embedding' },
      { id: 'enterprise-platform-old', retired: true },
    ]);
    expect(models.map((model) => model.id)).toEqual(['enterprise-platform-large']);
  });

  it('объявленный не-чат в выбор разговора не попадает', () => {
    // Ревью Т6 (M6): грамматика была «всё, кроме embed, — чат», и контур,
    // честно назвавший виды, отдавал в выбор модель рисования. А первая модель
    // списка становится моделью ВСЕХ прогонов (`defaultModelOf`).
    const models = catalogChatModels([
      { id: 'dall-e-3', kind: 'image' },
      { id: 'bge-reranker', kind: 'rerank' },
      { id: 'whisper-1', kind: 'audio' },
      { id: 'enterprise-platform-mid', kind: 'chat' },
    ]);
    expect(models.map((model) => model.id)).toEqual(['enterprise-platform-mid']);
  });

  it('нераспознанный вид чатом быть не перестаёт: `{"type":"model"}` — это молчание', () => {
    // Поле вида ищется по нескольким именам, и у части шлюзов там лежит совсем
    // другое. Считать такую строку объявлением значило бы спрятать от человека
    // рабочую модель.
    expect(catalogChatModels([{ id: 'gpt-4o', kind: 'model' }]).map((m) => m.id)).toEqual([
      'gpt-4o',
    ]);
  });

  it('модель без объявленного вида остаётся: промолчавший контур — не запрет', () => {
    // «Вид не объявлен» и «для чата не годится» — разные утверждения, и второе
    // панель не проверяла. Додумать его значило бы спрятать от человека модель,
    // которой контур отвечает.
    expect(catalogChatModels([{ id: 'enterprise-platform-mid' }]).map((m) => m.id)).toEqual(['enterprise-platform-mid']);
  });

  it('без пробы каталога нет вовсе, а не пустая ошибка', () => {
    expect(chatModels(undefined)).toEqual([]);
  });
});

describe('модель контура по умолчанию', () => {
  it('выбор человека сильнее каталога — даже когда контур эту модель не отдаёт', () => {
    // Пропавшая из ответа модель чаще означает суженные права ключа, чем
    // осознанное решение: молча увести разговор на первую попавшуюся значило бы
    // сменить модель без единого слова.
    writePlatform(store, { ...PLATFORM, defaultModel: 'enterprise-platform-large' });
    store.savePlatformHealth(PLATFORM.id, health([{ id: 'enterprise-platform-mid' }]));
    expect(defaultModelOf(store, PLATFORM)).toEqual({ model: 'enterprise-platform-large', source: 'default' });
  });

  it('человек не выбирал — берётся первая чатовая модель каталога, и это НАЗВАНО', () => {
    store.savePlatformHealth(
      PLATFORM.id,
      health([{ id: 'bge-m3', kind: 'embedding' }, { id: 'enterprise-platform-mid' }]),
    );
    // Источник `catalog` — не украшение: у профиля без модели CLI уходит в
    // контур с моделью ВЕНДОРА, и человек читает 403 как поломку панели.
    expect(defaultModelOf(store, PLATFORM)).toEqual({ model: 'enterprise-platform-mid', source: 'catalog' });
  });

  it('модель рисования моделью по умолчанию не становится, хоть и объявлена чатом', () => {
    // Аудит MD-13: у enterprise-platform модели рисования приходят видом `chat` с флагом
    // `image_generation`, и контур ведёт их дорогой без цикла инструментов. Первая
    // в каталоге, она уводила бы в эту дорогу КАЖДЫЙ прогон агента.
    store.savePlatformHealth(
      PLATFORM.id,
      health([
        { id: 'enterprise-platform-image', kind: 'chat', imageGeneration: true },
        { id: 'enterprise-platform-mid', kind: 'chat', imageGeneration: false },
      ]),
    );
    expect(defaultModelOf(store, PLATFORM)).toEqual({ model: 'enterprise-platform-mid', source: 'catalog' });
    // Выбрать её руками по-прежнему можно: список разговора её не прячет.
    expect(modelRulesFor(store, PLATFORM, 'chat').catalog).toContain('enterprise-platform-image');
  });

  it('ни выбора, ни каталога — модели нет, и это отдельный ответ', () => {
    expect(defaultModelOf(store, PLATFORM)).toEqual({ model: '', source: 'none' });
  });

  it('модель, выбранная в диалоге применения до Т6, не теряется', () => {
    // До Т6 модель выбиралась прямо в плане применения и жила в управляемом
    // профиле. Потерять её на первой же пересборке значило бы увести
    // работающий контур на другую модель.
    store.updateSettings({
      endpointProfiles: [
        buildManagedProfile(PLATFORM, { enabled: true, port: 5179, forceStream: true }, 'legacy-m'),
      ],
    });
    expect(defaultModelOf(store, PLATFORM)).toEqual({ model: 'legacy-m', source: 'default' });
  });
});

describe('правила потребителя', () => {
  it('переопределение потребителя сильнее модели контура', () => {
    // «Чат моделью покрупнее, тесты подешевле» — ради этого поле и заведено.
    const platform: Platform = {
      ...PLATFORM,
      defaultModel: 'enterprise-platform-mid',
      consumerModels: { tests: 'enterprise-platform-small' },
    };
    writePlatform(store, platform);
    expect(modelRulesFor(store, platform, 'tests')).toMatchObject({
      model: 'enterprise-platform-small',
      source: 'consumer',
    });
    expect(modelRulesFor(store, platform, 'chat')).toMatchObject({
      model: 'enterprise-platform-mid',
      source: 'default',
    });
  });

  it('каталог правил — только чатовые модели: по нему имя прогона узнаётся своим', () => {
    store.savePlatformHealth(
      PLATFORM.id,
      health([{ id: 'enterprise-platform-mid' }, { id: 'bge-m3', kind: 'embedding' }]),
    );
    expect(modelRulesFor(store, PLATFORM, 'chat').catalog).toEqual(['enterprise-platform-mid']);
  });
});

describe('выбор модели одного прогона', () => {
  const rules = {
    model: 'enterprise-platform-mid',
    source: 'default' as const,
    map: { sonnet: 'enterprise-platform-mid', opus: 'enterprise-platform-large' },
    catalog: ['enterprise-platform-mid', 'enterprise-platform-large'],
  };

  it('прогон ничего не просил — модель контура, и подмены нет', () => {
    expect(chooseRunModel(rules, '')).toEqual({
      model: 'enterprise-platform-mid',
      asked: '',
      source: 'default',
      replaced: false,
    });
  });

  it('панельное имя переводится картой, и перевод назван подменой', () => {
    expect(chooseRunModel(rules, 'opus')).toEqual({
      model: 'enterprise-platform-large',
      asked: 'opus',
      source: 'mapped',
      replaced: true,
    });
  });

  it('регистр в карте не стоит человеку отказа', () => {
    // Карту человек пишет руками, и `Sonnet` против `sonnet` — не его ошибка:
    // регистр в именах моделей не значит ничего ни у одного контура.
    const choice = chooseRunModel({ ...rules, map: { Sonnet: 'enterprise-platform-mid' } }, 'SONNET');
    expect(choice).toMatchObject({ model: 'enterprise-platform-mid', source: 'mapped' });
  });

  it('имя из каталога контура уходит как есть', () => {
    expect(chooseRunModel(rules, 'enterprise-platform-large')).toEqual({
      model: 'enterprise-platform-large',
      asked: 'enterprise-platform-large',
      source: 'asked',
      replaced: false,
    });
  });

  it('незнакомое имя заменяется моделью контура, и замена НАЗВАНА', () => {
    // Ровно тот случай, ради которого писался Т6: молча отпустить «haiku» в
    // контур — это 403 «модель» на каждом сообщении и ни одного слова о причине.
    expect(chooseRunModel(rules, 'haiku')).toEqual({
      model: 'enterprise-platform-mid',
      asked: 'haiku',
      source: 'default',
      replaced: true,
    });
  });

  it('перевод в то же самое имя подменой не считается', () => {
    const choice = chooseRunModel(
      { ...rules, map: { 'enterprise-platform-mid': 'enterprise-platform-mid' } },
      'enterprise-platform-mid',
    );
    expect(choice.replaced).toBe(false);
  });

  it('имя из каталога уезжает идентификатором каталога, а не тем регистром, что набрали', () => {
    // Сверка регистронезависимая ради человека, но наверх уходит то, что контур
    // сам объявил: контуру регистр может быть важен, и «совпало» не должно
    // оборачиваться 403.
    const choice = chooseRunModel({ ...rules, catalog: ['qwen2.5:7b'] }, 'QWEN2.5:7B');
    expect(choice).toMatchObject({ model: 'qwen2.5:7b', asked: 'QWEN2.5:7B', replaced: false });
  });

  it('модели у контура нет вовсе — заменять нечем, и подмена НЕ объявляется', () => {
    // Ревью Т6 (B1): раньше здесь возвращалось `replaced: true` с пустой
    // моделью, и шапка писала «имени „sonnet“ там нет, запрос уйдёт с .» — при
    // том что сервер в этом случае оставляет `--model sonnet` как есть. Экран
    // объявлял подмену, которой не происходит, и не называл ни одной модели.
    const empty = { ...rules, model: '', source: 'none' as const, map: {}, catalog: [] };
    expect(chooseRunModel(empty, '')).toEqual({
      model: '',
      asked: '',
      source: 'none',
      replaced: false,
    });
    expect(chooseRunModel(empty, 'sonnet')).toEqual({
      model: 'sonnet',
      asked: 'sonnet',
      source: 'none',
      replaced: false,
    });
  });

  it('карта работает и при пустой модели контура: это прямое слово человека', () => {
    // Пустой каталог отменяет подстановку панели, но не написанную руками
    // строку «sonnet значит вот это»: иначе настройка молча переставала бы
    // действовать ровно тогда, когда проба не прошла.
    const empty = { ...rules, model: '', source: 'none' as const, catalog: [] };
    expect(chooseRunModel(empty, 'sonnet')).toMatchObject({
      model: 'enterprise-platform-mid',
      source: 'mapped',
      replaced: true,
    });
  });
});

describe('усилие рассуждения', () => {
  it('отвечает манифест драйвера, а не проба', () => {
    // compromise: no-effort — у enterprise-platform поля глубины в публичной схеме нет, и
    // панель его не отправляет вовсе (решение владельца 12.09.2026).
    expect(effortAccepted(PLATFORM)).toBe(false);
  });
});

describe('маршрут инструментов контура', () => {
  const withRules = (platformTools: string[]): Platform['rules'] => ({
    ...PLATFORM.rules,
    platform: { ...PLATFORM.rules.platform, platformTools },
  });

  it('совместимый шлюз без прослойки получает инструменты полем', () => {
    expect(toolRouteOf({ ...PLATFORM, driver: 'openai-compat', toolShim: false })).toBe('native');
  });

  it('платформа компании без прослойки остаётся без инструментов, с прослойкой — через неё', () => {
    expect(toolRouteOf({ ...PLATFORM, toolShim: false })).toBe('none');
    expect(toolRouteOf({ ...PLATFORM, toolShim: true })).toBe('shim');
  });

  it('инструменты самой платформы забирают ход у клиентских — у любого типа', () => {
    expect(
      toolRouteOf({ ...PLATFORM, driver: 'openai-compat', rules: withRules(['web_search']) }),
    ).toBe('none');
  });
});
