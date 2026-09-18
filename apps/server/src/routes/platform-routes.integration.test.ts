import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EndpointProfile, Platform } from '@agentdeck/contracts';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { managedProfileId } from '../domains/platform/apply/profile.ts';
import { writePlatform, writeToken } from '../domains/platform/store.ts';
import { PlatformGateway } from '../domains/platform/gateway/listener.ts';
import { registerPlatformRoutes } from './platform-routes.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';

/**
 * Маршруты контура целиком, как их видит браузер.
 *
 * Два свойства этого файла важнее остальных проверок, и оба — инварианты партии:
 *
 * 1. НИ ОДИН ответ раздела не содержит ключа. Проверяется не выборочно, а
 *    перебором всех маршрутов: маска и «ключ сохранён» — весь наружный след.
 * 2. Панель не ходит в сеть, пока её не попросили. `fetch` подменён счётчиком, и
 *    любой маршрут кроме тех, что человек нажимает сам (`/check`, вызов агента,
 *    сессия агента, эмбеддинги), обязан оставить счётчик на нуле — включённый
 *    контур с ключом в том числе (инвариант 7: мёртвый контур не мешает панели).
 */

/** Латиница обязательна: ключ вне печатного ASCII панель не сохраняет (Т12). */
const SECRET = 'CONTOUR-KEY-CORPORATE-4f21';

const PLATFORM: Platform = {
  id: 'company-dev',
  title: 'Company · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 100,
  capabilities: [],
  targets: ['assistant'],
  projectPaths: [],
  consumers: [],
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

const MODELS = JSON.stringify({ data: [{ id: 'gpt-4o', kind: 'chat' }] });

let root: string;
let appData: string;
let app: FastifyInstance;
let store: AppStore;
/** Сколько раз панель вышла наружу за тест. Ноль везде, кроме `/check`. */
let calls: string[];
let gateway: PlatformGateway;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cc-platform-routes-'));
  appData = join(root, 'agentdeck');
  mkdirSync(appData, { recursive: true });
  store = new AppStore(appData);

  calls = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(String(url));
    return Promise.resolve(
      new Response(MODELS, { headers: { 'content-type': 'application/json' } }),
    );
  });

  // Активация поднимает погашенный шлюз сама — настоящий слушатель. Порт 0:
  // занятый 5179 живой панели на этой же машине иначе увёл бы тест к соседу.
  store.updateSettings({
    platformGateway: { ...store.getSettings().platformGateway, port: 0 },
  });
  gateway = new PlatformGateway();
  app = Fastify();
  registerPlatformRoutes(
    app,
    {
      location: { paths: { root, appData } },
      store,
    } as unknown as ServerContext,
    gateway,
  );
  await app.ready();
});

afterEach(async () => {
  await gateway.stop();
  await app.close();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('platform routes: настройка контура', () => {
  it('контуров нет — пустой список, а не отказ', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/platforms' });

    expect(res.statusCode).toBe(200);
    expect(res.json().platforms).toEqual([]);
  });

  it('сохранённый контур возвращается карточкой и переживает перезапуск панели', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: PLATFORM },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().platform.title).toBe('Company · dev');
    // Читаем с диска новым хранилищем: настройка легла в state.json, а не в память.
    expect(new AppStore(appData).getSettings().platforms).toHaveLength(1);
  });

  it('взаимное исключение правил (Т7) — отказ сохранения, а не тихая починка', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: {
        settings: {
          ...PLATFORM,
          toolShim: true,
          rules: {
            ...PLATFORM.rules,
            platform: { ...PLATFORM.rules.platform, platformTools: ['web_search'] },
          },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    // Отказ объясняется теми же словами, что строка матрицы на экране: два
    // объяснения одного запрета человек читает как два разных запрета.
    expect(res.json().message).toContain('Включить оба нельзя');
    // Ничего не записано: отказ на правиле не смеет сохранить остальную форму
    // наполовину.
    expect(store.getSettings().platforms).toEqual([]);
  });

  /**
   * Найдено враждебным ревью Т7: отказ стоял ПО СОСТОЯНИЮ, а противоречие
   * приезжает мимо этой двери (разворот архива, `PATCH /api/settings`, импорт).
   * Контур после такого не сохранялся вообще ничем — ни переименование, ни
   * адрес, ни модель, ни ключ, — а убрать одну из сторон было нечем: выход был
   * только через удаление контура вместе с ключом и историей расхода.
   */
  it('уже записанное противоречие не запирает контур: посторонняя правка проходит', async () => {
    const contradiction = {
      ...PLATFORM,
      toolShim: true,
      rules: {
        ...PLATFORM.rules,
        platform: { ...PLATFORM.rules.platform, platformTools: ['web_search'] },
      },
    };
    // Так это и приезжает: мимо двери сохранения, прямо в настройки.
    store.updateSettings({ platforms: [contradiction] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...contradiction, title: 'Company · prod' } },
    });

    expect(res.statusCode).toBe(200);
    expect(store.getSettings().platforms[0]?.title).toBe('Company · prod');
    // И карточка кричит о противоречии — молча его панель не чинит.
    expect(res.json().conflicts.find((item: { id: string }) => item.id === 'tools')?.active).toBe(
      true,
    );
  });

  it('выход из противоречия: снятая прослойка сохраняется', async () => {
    const contradiction = {
      ...PLATFORM,
      toolShim: true,
      rules: {
        ...PLATFORM.rules,
        platform: { ...PLATFORM.rules.platform, platformTools: ['web_search'] },
      },
    };
    store.updateSettings({ platforms: [contradiction] });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...contradiction, toolShim: false } },
    });

    expect(res.statusCode).toBe(200);
    expect(store.getSettings().platforms[0]?.toolShim).toBe(false);
  });

  it('одна сторона исключения сохраняется как обычно', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: {
        settings: {
          ...PLATFORM,
          toolShim: false,
          rules: {
            ...PLATFORM.rules,
            platform: { ...PLATFORM.rules.platform, platformTools: ['web_search'] },
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(store.getSettings().platforms[0]?.rules.platform.platformTools).toEqual(['web_search']);
  });

  it('потребитель не из списка отклоняется на записи, а не хранится молча', async () => {
    // Ревью Т3, MINOR 10: форма потребителя проверялась только разбором архива,
    // а дверь записи принимала любую строку.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, consumers: ['chat', '../мусор'] } },
    });

    expect(res.statusCode).toBe(400);
    expect(store.getSettings().platforms).toHaveLength(0);
  });

  it('сохранение не включает контур: тумблер — это активация, и она своя ручка', async () => {
    // Тело просит `enabled: true`, как это делала бы форма до Т2.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, enabled: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().platform.enabled).toBe(false);
    expect(res.json().active).toBe(false);
    expect(store.getSettings().platforms[0]?.enabled).toBe(false);
    expect(store.getSettings().activePlatformId).toBe('');
  });

  it('правка АКТИВНОГО контура его не гасит: тумблер идёт за активностью', async () => {
    writePlatform(store, PLATFORM);
    store.updateSettings({ activePlatformId: PLATFORM.id });

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      // Форма правки названия присылает то, что показывала: выключённый контур.
      payload: { settings: { ...PLATFORM, title: 'Company · прод', enabled: false } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().platform.enabled).toBe(true);
    expect(res.json().active).toBe(true);
    expect(store.getSettings().platforms[0]?.enabled).toBe(true);
  });

  it('идентификатор в адресе и в теле обязаны совпадать: ключ лежит под старым', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, id: 'company-prod' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('id');
  });

  it('непрочитанный корневой сертификат — отказ при СОХРАНЕНИИ, с именем поля', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: {
        settings: {
          ...PLATFORM,
          toolShim: true,
          contourPrompt: true,
          rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
          caCertPath: join(root, 'нет-такого.pem'),
          transport: defaultPlatformTransport(),
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('caCertPath');
    expect(calls).toEqual([]);
  });

  it('настоящий сертификат сохраняется молча — файл разобран, а не угадан', async () => {
    const pem = join(root, 'corp-root.pem');
    writeFileSync(
      pem,
      readFileSync(
        join(import.meta.dirname, '..', 'domains', 'platform', '__fixtures__', 'corp-root.pem'),
      ),
    );

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, toolShim: true, contourPrompt: true, caCertPath: pem } },
    });

    expect(res.statusCode).toBe(200);
  });

  it('не сертификат под видом сертификата — 400 при сохранении, а не отказ связи потом', async () => {
    const fake = join(root, 'не-сертификат.pem');
    writeFileSync(fake, '-----BEGIN CERTIFICATE-----\nтекст\n-----END CERTIFICATE-----\n');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, toolShim: true, contourPrompt: true, caCertPath: fake } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('caCertPath');
    expect(store.getSettings().platforms).toEqual([]);
  });

  // DRV-04/05: ключ, вписанный в лишние заголовки, лёг бы открытым текстом в
  // настройки и в экспорт окружения. Отказ называет поле и имя, но не значение.
  it('ключ в лишних заголовках транспорта — 400 при сохранении, значение не отражается', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: {
        settings: {
          ...PLATFORM,
          transport: {
            ...defaultPlatformTransport(),
            headers: 'Authorization: Bearer sk-live-51c0',
          },
        },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('transport.headers');
    expect(res.body).not.toContain('sk-live-51c0');
    expect(store.getSettings().platforms).toEqual([]);
  });

  // DRV-03: переопределение пресета с опечаткой общий PATCH роняет молча, а дверь
  // сохранения контура — отказ с именем поля, иначе «сохранено» и шлюз как был.
  it('негодное переопределение пресета — 400 с именем поля, контур не записан', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, manifest: { thinkingField: '__proto__.x' } } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('manifest.thinkingField');
    expect(store.getSettings().platforms).toEqual([]);
  });

  it('пресет и его переопределения сохраняются и читаются обратно', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: {
        settings: {
          ...PLATFORM,
          driver: 'vllm',
          manifest: { anthropicMessages: '', imagesApi: 'images/generations' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const [saved] = store.getSettings().platforms;
    expect(saved?.driver).toBe('vllm');
    expect(saved?.manifest).toEqual({ anthropicMessages: '', imagesApi: 'images/generations' });
  });

  // Живой прогон на Ollama (DRV-03): контур, сохранённый мимо мастера без полей
  // прослойки, получал умолчание платформы компании, и включённая прослойка молча уводила
  // клиента Anthropic с родной ручки пресета на мост.
  it('без полей прослойки и промпта умолчание берётся из пресета типа, а не платформы компании', async () => {
    const { toolShim: _shim, contourPrompt: _prompt, ...bare } = PLATFORM;
    for (const [driver, expected] of [
      ['ollama', false],
      ['enterprise-platform', true],
    ] as const) {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/platforms/company-dev',
        payload: { settings: { ...bare, driver } },
      });
      expect(res.statusCode, driver).toBe(200);
      const [saved] = store.getSettings().platforms;
      expect({ toolShim: saved?.toolShim, contourPrompt: saved?.contourPrompt }, driver).toEqual({
        toolShim: expected,
        contourPrompt: expected,
      });
    }
  });

  it('ключ можно сохранить вместе с настройкой — мастер делает это одним нажатием', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: PLATFORM, token: SECRET },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hasToken).toBe(true);
    expect(res.body).not.toContain(SECRET);
  });

  it('настройка БЕЗ поля ключа сохранённый ключ не трогает', async () => {
    writePlatform(store, PLATFORM);
    writeToken(appData, PLATFORM.id, SECRET);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: { ...PLATFORM, title: 'Company · prod' } },
    });

    expect(res.json().hasToken).toBe(true);
    expect(res.json().platform.title).toBe('Company · prod');
  });

  it('ключ не строкой рядом с настройкой — 400, и настройка не сохранена', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: PLATFORM, token: 42 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('token');
    expect(store.getSettings().platforms).toEqual([]);
  });

  it('слишком длинный ключ тоже не оставляет половину сохранённого', async () => {
    // Отказ на ключе ПОСЛЕ записанной настройки оставил бы контур, которого
    // человек отдельно от ключа не просил.
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: PLATFORM, token: 'x'.repeat(9_000) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('token');
    expect(store.getSettings().platforms).toEqual([]);
  });

  it('слишком короткий ключ отклонён: чистка чужого текста его бы не поймала', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev',
      payload: { settings: PLATFORM, token: 'sk-live' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('token');
    expect(store.getSettings().platforms).toEqual([]);
  });

  it('идентификатор с пробелом или слэшем отклонён: из него собирается адрес шлюза', async () => {
    for (const id of ['company dev', 'company/dev', '../etc']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/platforms/${encodeURIComponent(id)}`,
        payload: { settings: { ...PLATFORM, id } },
      });

      expect(res.statusCode).toBe(400);
    }
    expect(store.getSettings().platforms).toEqual([]);
  });

  it('удаление уносит контур; повторное удаление — 404 с его именем', async () => {
    writePlatform(store, PLATFORM);

    const first = await app.inject({ method: 'DELETE', url: '/api/platforms/company-dev' });
    expect(first.statusCode).toBe(200);
    expect(first.json().platforms).toEqual([]);

    const second = await app.inject({ method: 'DELETE', url: '/api/platforms/company-dev' });
    expect(second.statusCode).toBe(404);
    expect(second.json().code).toBe('platform_not_found');
    expect(second.json().message).toContain('company-dev');
    // Код текста рядом с русской строкой: английский интерфейс переводит его.
    expect(second.json().messageCode).toBe('platform-not-found');
    expect(second.json().params).toEqual({ id: 'company-dev' });
  });

  it('несуществующий контур — 404 на каждом маршруте, который его требует', async () => {
    const answers = await Promise.all([
      app.inject({ method: 'POST', url: '/api/platforms/нет-такого/check' }),
      app.inject({ method: 'DELETE', url: '/api/platforms/нет-такого' }),
      app.inject({
        method: 'PUT',
        url: '/api/platforms/нет-такого/token',
        payload: { token: SECRET },
      }),
    ]);

    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('platform_not_found');
    }
  });

  /**
   * Чем пойдёт прогон (Т6). Маршрут спрашивает шапка чата на каждом открытии
   * разговора, а до ревью его не покрывала ни одна проверка — ни серверная, ни
   * свип.
   */
  describe('GET /api/platform-run-plan/:consumer', () => {
    it('контура нет вовсе — ответ «не через контур», а не отказ', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/platform-run-plan/chat' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ routed: false, title: '' });
    });

    it('живёт своим корнем: контур с именем `run-plan` его не перекрывает', async () => {
      // Статический сегмент сильнее параметра, поэтому внутри
      // `/api/platforms/:id/…` такой контур перекрыл бы собственные маршруты
      // (ревью Т6, m11).
      writePlatform(store, { ...PLATFORM, id: 'run-plan', title: 'Свой контур' });

      // На прежнем адресе этот запрос попадал в план прогона с потребителем
      // «apply» и отвечал чем угодно, кроме плана применения контура.
      const own = await app.inject({ method: 'GET', url: '/api/platforms/run-plan/apply' });
      expect(own.statusCode).toBe(200);
      expect(own.json()).toHaveProperty('targets');

      const plan = await app.inject({ method: 'GET', url: '/api/platform-run-plan/chat' });
      expect(plan.statusCode).toBe(200);
      expect(plan.json()).toHaveProperty('rules');
    });
  });

  it('ключ не строкой — 400 с именем поля, а не 500', async () => {
    writePlatform(store, PLATFORM);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/platforms/company-dev/token',
      payload: { token: 42 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toBe('token');
  });
});

describe('platform routes: проверка связи', () => {
  it('проба запоминается и приезжает в следующем списке', async () => {
    writePlatform(store, PLATFORM);

    const check = await app.inject({ method: 'POST', url: '/api/platforms/company-dev/check' });
    expect(check.statusCode).toBe(200);
    expect(check.json().outcome).toBe('ok');
    expect(calls).toEqual(['https://api.dev.example.ru/v1/models']);

    const list = await app.inject({ method: 'GET', url: '/api/platforms' });
    expect(list.json().platforms[0].health.outcome).toBe('ok');
  });

  it('недоступный контур — 200 с причиной, а не 502 в консоли браузера', async () => {
    writePlatform(store, PLATFORM);
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));

    const res = await app.inject({ method: 'POST', url: '/api/platforms/company-dev/check' });

    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe('unreachable');
    expect(res.json().detail).toContain('ECONNREFUSED');
  });

  it('выключенный контур проверяется по кнопке: мастер проверяет ДО включения', async () => {
    writePlatform(store, { ...PLATFORM, enabled: false });

    const res = await app.inject({ method: 'POST', url: '/api/platforms/company-dev/check' });

    expect(res.json().outcome).toBe('ok');
  });
});

/**
 * Активность как её видит браузер. Проверяется здесь то, чего не доказывает ни
 * один разбор домена: что маршруты вообще заведены, что отказ приезжает своим
 * кодом, что сетевой итог лежит ВНУТРИ ответа — и что «погасить рассказ» не
 * читается как «удалить контур с таким именем».
 */
describe('platform routes: активность контура (Т2)', () => {
  const SECOND: Platform = { ...PLATFORM, id: 'company-prod', title: 'Company · прод' };

  /** Управляемый профиль прежнего контура: по нему видно, что откат случился. */
  const managedProfile = (platformId: string): EndpointProfile => ({
    id: managedProfileId(platformId),
    name: `Контур ${platformId}`,
    baseUrl: `http://127.0.0.1:5199/${platformId}`,
    apiKind: 'anthropic',
    model: '',
    writeToken: false,
    imagesUrl: '',
    ownerPlatformId: platformId,
  });

  it('активация переносит активность: прежний гаснет вместе со своим профилем', async () => {
    writePlatform(store, { ...PLATFORM, enabled: true });
    writePlatform(store, { ...SECOND, enabled: false });
    store.updateSettings({
      activePlatformId: PLATFORM.id,
      endpointProfiles: [managedProfile(PLATFORM.id)],
    });

    const res = await app.inject({ method: 'POST', url: '/api/platforms/company-prod/activate' });

    expect(res.statusCode).toBe(200);
    expect(res.json().activePlatformId).toBe('company-prod');
    expect(res.json().previousPlatformId).toBe('company-dev');
    // Прежний контур не просто помечен неактивным: его применение снято, и
    // профиль, смотревший в шлюз, ушёл вместе с ним.
    expect(res.json().rollback.profileRemoved).toBe(true);
    expect(store.getSettings().endpointProfiles).toEqual([]);
    expect(store.getSettings().activePlatformId).toBe('company-prod');
    expect(store.getSettings().platforms.map((item) => [item.id, item.enabled])).toEqual([
      ['company-dev', false],
      ['company-prod', true],
    ]);
  });

  it('погашенный шлюз активация поднимает сама: настройка включена, слушатель жив', async () => {
    // Живое подключение 14.09.2026: шлюз был выключен, активация кончилась
    // красным «Шлюз не поднят», и чат с галочкой уходил мимо контура. Теперь
    // маршрут активации включает настройку и поднимает слушатель тем же
    // порядком, что кнопка мастера.
    writePlatform(store, PLATFORM);
    expect(store.getSettings().platformGateway.enabled).toBe(false);

    const res = await app.inject({ method: 'POST', url: '/api/platforms/company-dev/activate' });

    expect(res.statusCode).toBe(200);
    expect(res.json().probe.outcome).toBe('ok');
    expect(store.getSettings().activePlatformId).toBe('company-dev');
    expect(store.getSettings().platformGateway.enabled).toBe(true);
    expect(gateway.status().running).toBe(true);
    // Пробный запрос дошёл до шлюза и дальше до контура: причина — не «шлюз не поднят».
    expect(res.json().smoke.detail ?? '').not.toContain('Шлюз не');
    expect(calls[0]).toBe('https://api.dev.example.ru/v1/models');
  });

  it('«Поднять шлюз» с карточки: выключенная настройка включается, слушатель жив, в сеть ни шагу', async () => {
    // Живое подключение 14.09.2026: на карточке висело «Шлюз не поднят», а
    // кнопка жила только в мастере на последнем шаге. Маршрут делает то же, что
    // активация: включает настройку и поднимает слушатель одним вызовом.
    writePlatform(store, { ...PLATFORM, enabled: true });
    store.updateSettings({ activePlatformId: PLATFORM.id });
    expect(store.getSettings().platformGateway.enabled).toBe(false);

    const res = await app.inject({ method: 'POST', url: '/api/platforms/gateway/start' });

    expect(res.statusCode).toBe(200);
    expect(res.json().settings.enabled).toBe(true);
    expect(res.json().status.running).toBe(true);
    expect(store.getSettings().platformGateway.enabled).toBe(true);
    expect(gateway.status().running).toBe(true);
    expect(calls).toEqual([]);

    // Повтор по живому шлюзу — не перезапуск и не ошибка.
    const again = await app.inject({ method: 'POST', url: '/api/platforms/gateway/start' });
    expect(again.statusCode).toBe(200);
    expect(again.json().status.port).toBe(res.json().status.port);
  });

  it('возврат по кнопке чистит поле активного контура и не ходит в сеть', async () => {
    writePlatform(store, { ...PLATFORM, enabled: true });
    store.updateSettings({
      activePlatformId: PLATFORM.id,
      endpointProfiles: [managedProfile(PLATFORM.id)],
    });

    const res = await app.inject({ method: 'POST', url: '/api/platforms/company-dev/deactivate' });

    expect(res.statusCode).toBe(200);
    expect(res.json().profileRemoved).toBe(true);
    expect(store.getSettings().activePlatformId).toBe('');
    expect(store.getSettings().platforms[0]?.enabled).toBe(false);
    expect(store.getSettings().endpointProfiles).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('несуществующий контур на обеих ручках активности — 404, а не 500', async () => {
    const answers = await Promise.all([
      app.inject({ method: 'POST', url: '/api/platforms/нет-такого/activate' }),
      app.inject({ method: 'POST', url: '/api/platforms/нет-такого/deactivate' }),
    ]);

    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('platform_not_found');
    }
    expect(store.getSettings().activePlatformId).toBe('');
  });

  it('рассказ о переносе гасится своим маршрутом, а не удалением контура', async () => {
    writePlatform(store, PLATFORM);
    store.setPlatformActivationNotice({
      activatedId: PLATFORM.id,
      activatedTitle: PLATFORM.title,
      others: ['Company · прод'],
    });

    const before = await app.inject({ method: 'GET', url: '/api/platforms' });
    expect(before.json().activationNotice.others).toEqual(['Company · прод']);

    const res = await app.inject({ method: 'DELETE', url: '/api/platforms/activation-notice' });

    expect(res.statusCode).toBe(200);
    // Рядом с ним живёт «DELETE /api/platforms/:id», и совпасть они не вправе:
    // удаление контура по имени «activation-notice» ответило бы 404, а рассказ
    // остался бы висеть. (Порядок объявления на это не влияет — постоянный
    // отрезок у маршрутизатора Fastify всегда старше параметра; проверено
    // перестановкой: тест остаётся зелёным.)
    expect(res.json().platforms).toHaveLength(1);
    expect(res.json().activationNotice).toBeUndefined();
    expect(store.getPlatformActivationNotice()).toBeUndefined();
  });
});

describe('инвариант 1: ни один ответ раздела не содержит ключа', () => {
  it('перебор всех маршрутов — наружу уходит только маска', async () => {
    writePlatform(store, PLATFORM);

    const answers = [
      await app.inject({
        method: 'PUT',
        url: '/api/platforms/company-dev/token',
        payload: { token: SECRET },
      }),
      await app.inject({ method: 'GET', url: '/api/platforms' }),
      await app.inject({
        method: 'PUT',
        url: '/api/platforms/company-dev',
        payload: { settings: { ...PLATFORM, title: 'Company · prod' } },
      }),
      await app.inject({ method: 'POST', url: '/api/platforms/company-dev/check' }),
      await app.inject({ method: 'DELETE', url: '/api/platforms/company-dev' }),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET);
    }

    // Маска при этом человеку видна: иначе он не узнает, какой ключ сохранён.
    expect(answers[0]!.json().maskedToken).toContain('…');
    expect(answers[1]!.json().platforms[0].hasToken).toBe(true);
    // Ключ уехал в контур заголовком — и только туда.
    expect(calls).toEqual(['https://api.dev.example.ru/v1/models']);
  });

  it('в сеть ходят ровно два маршрута — и это видно по исходникам, а не по одному модулю', () => {
    // Тест с поднятым Fastify доказывает только свой модуль. Настоящее свойство
    // — «панель ходит наружу ПО НАЖАТИЮ ИЛИ ПО ТАЙМЕРУ, КОТОРЫЙ ВЫСТАВИЛА
    // КОМПАНИЯ» — держится тем, что позвать пробу больше неоткуда: ни из
    // старта панели, ни с пути запроса, ни из наблюдателя за чем-то ещё.
    const src = join(import.meta.dirname, '..');
    const callers: string[] = [];

    const walk = (path: string): void => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
          if (/\bcheckPlatform\s*\(|\bprobePlatform\s*\(/.test(readFileSync(full, 'utf8'))) {
            callers.push(entry.name);
          }
        }
      }
    };
    walk(src);

    // Объявление в самих модулях домена — не вызов, поэтому они здесь законны.
    //
    // `model-routes.ts` добавлен Т5 ОСОЗНАННО и ровно с той же оговоркой:
    // каталог из контура обновляется только по кнопке (`refresh=true`), а без
    // неё берётся из следа последней пробы. Открытие настроек к контуру не
    // ходит — это проверяет отдельный тест ниже. Список здесь короткий
    // намеренно: он и есть перечень мест, откуда панель вообще может позвонить
    // в контур, и вырасти он может только правкой этой строки.
    //
    // `activation.ts` добавлен Т2 ОСОЗНАННО: активация — единственное действие,
    // после которого проба обязательна, потому что человек только что перевёл
    // на этот контур и панель, и все CLI. Ходит она по нажатию кнопки, а не
    // сама: при старте панели активация не зовётся (перенос старых настроек
    // сети не касается вовсе).
    //
    // `watch.ts` добавлен A-2 ОСОЗНАННО и стоит здесь дороже остальных: это
    // ЕДИНСТВЕННОЕ место, откуда панель ходит наружу без человека. Повод —
    // застывший каталог: кроме кнопки «Обновить» его обновлять было нечем, и
    // расход считался по прайсу пробы неизвестной давности, токены исчезнувших
    // из каталога моделей уходили в `unpricedTokens`, а «Картинка» отвечала
    // `no-model` по устаревшему списку. Обмен на это — четыре ограничения
    // самого модуля: только активный контур с ключом, никогда на пути запроса,
    // интервал в настройках (`platformProbeMinutes`, ноль — не ходить вовсе;
    // по умолчанию 720 минут, то есть два следа в журнале компании за сутки),
    // первая проба не раньше чем через интервал — при старте панели
    // по-прежнему не ходит никто.
    expect(callers.sort()).toEqual([
      'activation.ts',
      'check.ts',
      'model-routes.ts',
      'platform-routes.ts',
      'probe.ts',
      'watch.ts',
    ]);
  });

  describe('агенты и эмбеддинги', () => {
    const AGENT = '4b0d1f5e-0000-4000-8000-000000000000';

    /** Ответ контура на нужной ручке; остальные оставляем счётчику. */
    const answerWith = (body: string, status = 200): void => {
      vi.stubGlobal('fetch', (url: string) => {
        calls.push(String(url));
        return Promise.resolve(
          new Response(status === 204 ? null : body, {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      });
    };

    it('вызов агента у неподключённого контура — 404 и НИ ОДНОГО запроса наружу', async () => {
      writePlatform(store, { ...PLATFORM, enabled: false });

      const res = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/agents/ask`,
        payload: { agent: AGENT, message: 'привет' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe('platform_not_connected');
      expect(calls).toEqual([]);
    });

    it('нет лицензии на модуль агентов — 200 с исходом «недоступно», а не отказ маршрута', async () => {
      writePlatform(store, PLATFORM);
      writeToken(appData, PLATFORM.id, SECRET);
      answerWith(JSON.stringify({ error: 'module_not_licensed' }), 403);

      const res = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/agents/ask`,
        payload: { agent: AGENT, message: 'привет' },
      });

      // 200 намеренно: отсутствующая возможность — это состояние карточки, а не
      // сбой панели, и красной ошибки в консоли браузера здесь быть не должно.
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe('unavailable');
      expect(res.payload).not.toContain(SECRET);
    });

    it('тип контура без агентов — 404 до сети и на вызове, и на сессиях', async () => {
      writePlatform(store, { ...PLATFORM, driver: 'openai-compat' });
      writeToken(appData, PLATFORM.id, SECRET);
      answerWith(JSON.stringify({ error: { message: 'Not Found' } }), 404);

      const ask = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/agents/ask`,
        payload: { agent: AGENT, message: 'привет' },
      });
      const read = await app.inject({
        method: 'GET',
        url: `/api/platforms/${PLATFORM.id}/agents/sessions/ses-1`,
      });
      const reset = await app.inject({
        method: 'DELETE',
        url: `/api/platforms/${PLATFORM.id}/agents/sessions/ses-1`,
      });

      for (const res of [ask, read, reset]) {
        expect(res.statusCode).toBe(404);
        expect(res.json().code).toBe('agents_not_declared');
      }
      expect(calls).toEqual([]);
    });

    it('без вопроса — 400 с именем поля, без похода по сети', async () => {
      writePlatform(store, PLATFORM);
      writeToken(appData, PLATFORM.id, SECRET);

      const res = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/agents/ask`,
        payload: { agent: AGENT },
      });

      expect(res.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });

    it('сессия читается и сбрасывается по адресу контура', async () => {
      writePlatform(store, PLATFORM);
      writeToken(appData, PLATFORM.id, SECRET);
      answerWith(JSON.stringify({ sessions: [] }));

      const read = await app.inject({
        method: 'GET',
        url: `/api/platforms/${PLATFORM.id}/agents/sessions/ses-1?agent=${AGENT}`,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json().empty).toBe(true);

      answerWith('', 204);
      const reset = await app.inject({
        method: 'DELETE',
        url: `/api/platforms/${PLATFORM.id}/agents/sessions/ses-1`,
      });
      expect(reset.statusCode).toBe(200);
      expect(calls.every((url) => url.includes('/v1/agent/sessions/ses-1'))).toBe(true);
    });

    it('эмбеддинги: один текст строкой принимается, ключ в ответе не появляется', async () => {
      writePlatform(store, PLATFORM);
      writeToken(appData, PLATFORM.id, SECRET);
      answerWith(
        JSON.stringify({ model: 'ru-embed', data: [{ index: 0, embedding: [0.1, 0.2] }] }),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/embeddings`,
        payload: { model: 'ru-embed', input: 'раз' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().dimensions).toBe(2);
      expect(res.payload).not.toContain(SECRET);
    });

    it('эмбеддинги без модели — 400, и в сеть панель не идёт', async () => {
      writePlatform(store, PLATFORM);
      writeToken(appData, PLATFORM.id, SECRET);

      const res = await app.inject({
        method: 'POST',
        url: `/api/platforms/${PLATFORM.id}/embeddings`,
        payload: { input: ['раз'] },
      });

      expect(res.statusCode).toBe(400);
      expect(calls).toEqual([]);
    });
  });

  it.each([true, false])(
    'контур (enabled=%s) не делает НИ ОДНОГО запроса при старте панели',
    async (enabled) => {
      writePlatform(store, { ...PLATFORM, enabled });
      writeToken(appData, PLATFORM.id, SECRET);

      // Заново поднятая панель с готовым контуром: это и есть «старт панели».
      const booted = Fastify();
      registerPlatformRoutes(
        booted,
        {
          location: { paths: { root, appData } },
          store: new AppStore(appData),
        } as unknown as ServerContext,
        new PlatformGateway(),
      );
      await booted.ready();

      const list = await booted.inject({ method: 'GET', url: '/api/platforms' });
      await booted.close();

      expect(list.json().platforms[0].hasToken).toBe(true);
      expect(calls).toEqual([]);
    },
  );
});

describe('platform routes: расход и бюджет (Т8)', () => {
  /** Расход прямо в состоянии панели — так его пишет шлюз, минуя маршруты. */
  const seedSpend = (patch: { usd?: number; exhaustedAt?: string } = {}): void => {
    store.savePlatformSpend({
      platformId: PLATFORM.id,
      days: [
        {
          day: '2026-09-01',
          requests: 1,
          promptTokens: 3_000_000,
          completionTokens: 0,
          totalTokens: 3_000_000,
          money: { usd: 9, pricedTokens: 3_000_000, unpricedTokens: 0, unpricedModels: [] },
        },
        {
          day: '2026-09-10',
          requests: 2,
          promptTokens: 2_000_000,
          completionTokens: 0,
          totalTokens: 2_000_000,
          money: {
            usd: patch.usd ?? 20,
            pricedTokens: 0,
            unpricedTokens: 2_000_000,
            unpricedModels: ['corp-l'],
          },
        },
      ],
      ...(patch.exhaustedAt ? { exhaustedAt: patch.exhaustedAt } : {}),
    });
  };

  it('карточка списка несёт итог по бюджету и расход за период', async () => {
    writePlatform(store, { ...PLATFORM, budgetUsd: 100, budgetSince: '2026-09-10' });
    seedSpend();

    const card = (await app.inject({ method: 'GET', url: '/api/platforms' })).json().platforms[0];
    // Период считается от названного дня: сентябрьское первое в бюджет не вошло.
    // И считается она по НАШЕМУ прайсу: «внутренней единицы контура» больше нет.
    expect(card.budget).toMatchObject({ tracked: true, spentUsd: 20, share: 0.2 });
    expect(card.budget).not.toHaveProperty('spentUnitUsd');
    expect(card.periodSpend.requests).toBe(2);
    expect(card.periodSpend.money.unpricedModels).toEqual(['corp-l']);
    // И ни одного похода наружу ради этих цифр.
    expect(calls).toEqual([]);
  });

  it('маршрут расхода отдаёт дни целиком, а период — суммой', async () => {
    writePlatform(store, { ...PLATFORM, budgetSince: '2026-09-10' });
    seedSpend();

    const res = await app.inject({ method: 'GET', url: '/api/platforms/company-dev/spend' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toHaveLength(2);
    expect(body.total.totalTokens).toBe(5_000_000);
    expect(body.period.totalTokens).toBe(2_000_000);
    expect(calls).toEqual([]);
  });

  it('расхода ещё не было — ноль, а не отказ', async () => {
    writePlatform(store, PLATFORM);
    const body = (
      await app.inject({ method: 'GET', url: '/api/platforms/company-dev/spend' })
    ).json();
    expect(body.days).toEqual([]);
    expect(body.budget.exhausted).toBe(false);
  });

  it('нет такого контура — 404, а не пустой расход', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/platforms/чужой/spend' });
    expect(res.statusCode).toBe(404);
  });

  it('отметку «исчерпан» снимает только человек, и она переживает перезапуск', async () => {
    writePlatform(store, PLATFORM);
    seedSpend({ exhaustedAt: '2026-09-10T10:00:00.000Z' });

    // Читается из состояния на диске — то есть переживает перезапуск панели.
    const before = (await app.inject({ method: 'GET', url: '/api/platforms' })).json().platforms[0];
    expect(before.budget).toMatchObject({
      exhausted: true,
      exhaustedAt: '2026-09-10T10:00:00.000Z',
    });

    const cleared = await app.inject({
      method: 'DELETE',
      url: '/api/platforms/company-dev/spend/exhausted',
    });
    expect(cleared.json().cleared).toBe(true);
    expect(cleared.json().budget.exhausted).toBe(false);

    // Повтор — не отказ: снимать уже нечего, и это законное состояние кнопки.
    const again = await app.inject({
      method: 'DELETE',
      url: '/api/platforms/company-dev/spend/exhausted',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().cleared).toBe(false);
    // Расход при этом не потерян: снимается отметка, а не учёт.
    expect(again.json().total.totalTokens).toBe(5_000_000);
  });

  it('удалённый контур уносит свой расход: идентификатор заводят заново', async () => {
    writePlatform(store, PLATFORM);
    seedSpend();

    await app.inject({ method: 'DELETE', url: '/api/platforms/company-dev' });
    expect(store.getPlatformSpend()['company-dev']).toBeUndefined();
  });
});
