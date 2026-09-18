import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import type { EndpointProfile, Platform, PlatformModelInfo } from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from '../platform/ca-fetch.ts';
import { promptText } from '../prompts.ts';
import { driverFor } from '../platform/drivers/index.ts';
import { defaultPlatformTransport } from '@agentdeck/contracts/platform-transport';
import { generateImage, planImage, planImageReady, savePicture, type MediaDeps } from './images.ts';
import { isMediaError, type MediaError } from './errors.ts';
import { mediaDir } from './store.ts';

/**
 * Картинки из чата: маршрут решает сервер, и недоступность называется.
 *
 * Здесь заперты обещания режима, а не «функция вернула объект»: доступность
 * считается по ОБЪЯВЛЕННОЙ возможности (инвариант 13 — имя модели объявлением не
 * является), у каждой запертой дороги своя причина, картинка идёт через свой шлюз
 * в диалекте OpenAI, ссылка вместо байтов становится отказом, и ни байта картинки
 * не попадает в настройки панели.
 *
 * С дорогой агента (13.09.2026) сюда добавилось разделение, которое легко
 * потерять правкой: режим запирает ТОЛЬКО отсутствие разговора (`no-agent`), а
 * прежние причины объясняют отсутствие РАСТРА и уезжают в `rasterReason`. Проверки
 * ниже спрашивают оба поля именно поэтому — «нет модели» в `reason` снова
 * означало бы запертый режим там, где рисовать есть чем.
 */

let appData: string;
let store: AppStore;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'media-'));
  store = new AppStore(appData);
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

/** PNG 2×1, настоящий: подпись, IHDR и один IDAT — байты проверяет `decode.ts`. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    // CRC читателю панели не нужен — он читает подпись и IHDR, — но и врать в
    // нём незачем: ноль здесь честнее случайного числа.
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function contour(overrides: Partial<Platform> = {}): Platform {
  return {
    id: 'gor',
    title: 'Company · dev',
    driver: 'enterprise-platform',
    baseUrl: 'https://api.example.ru',
    enabled: true,
    mode: 'required',
    budgetUsd: 0,
    budgetSince: '',
    capabilities: [],
    consumers: [],
    consumerModels: {},
    modelMap: {},
    defaultModel: '',
    agents: [],
    caCertPath: '',
    rules: { platform: defaultPlatformRules(), ours: defaultOurRules() },
    ...overrides,
  } as Platform;
}

function profile(overrides: Partial<EndpointProfile> = {}): EndpointProfile {
  return {
    id: 'own',
    name: 'Своя модель',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKind: 'openai-compat',
    model: 'sd-xl',
    writeToken: false,
    imagesUrl: '',
    ownerPlatformId: '',
    ...overrides,
  };
}

function model(id: string, imageGeneration: boolean): PlatformModelInfo {
  return { id, imageGeneration } as PlatformModelInfo;
}

/** Контур активен, проба записана: ровно то состояние, в котором живёт панель. */
function useContour(platform: Platform, models: PlatformModelInfo[]): void {
  store.updateSettings({ platforms: [platform], activePlatformId: platform.id });
  store.savePlatformHealth(platform.id, {
    ok: true,
    checkedAt: '2026-09-12T10:00:00.000Z',
    models,
  } as never);
}

function deps(extra: Partial<MediaDeps> = {}): MediaDeps {
  return { appDataDir: appData, store, ...extra };
}

/** Ответ чужой стороны: тело строкой, как его читает `readCapped`. */
function reply(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Кадры потока `chat/completions` с картинкой частью содержимого. */
function framesWithImage(bytes: Buffer): string {
  const part = {
    choices: [
      {
        delta: {
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` },
            },
          ],
        },
      },
    ],
  };
  return `data: ${JSON.stringify(part)}\n\ndata: [DONE]\n\n`;
}

describe('planImage: чем нарисуем и почему нельзя', () => {
  it('ни контура, ни профилей, ни разговора — заперто, и заперто разговором', () => {
    const plan = planImage(deps());

    expect(plan.available).toBe(false);
    // Режим запирает отсутствие агента, а растровую причину панель называет
    // рядом: чинить нужно её, а открыть — разговор.
    expect(plan.reason).toBe('no-agent');
    expect(plan.rasterReason).toBe('no-route');
    // Подпись компромисса приезжает вместе с причиной: человек читает правило
    // там же, где недоступность.
    expect(plan.compromise).toBe('media-by-capability');
  });

  it('модель без объявленной генерации не даёт РАСТРА, и это сказано отдельно', () => {
    // Ровно инвариант 13: в имени «vision» есть, объявления — нет.
    useContour(contour(), [model('company-vision-7b', false)]);

    const plan = planImage(deps({ gatewayPort: () => 5100 }));

    expect(plan.available).toBe(false);
    expect(plan.rasterReason).toBe('no-model');
  });

  it('объявленная модель + поднятый шлюз — дорога «частью ответа» с промптом режима', () => {
    useContour(contour(), [model('company-chat', false), model('company-image', true)]);

    const plan = planImage(deps({ gatewayPort: () => 5100 }));

    expect(plan).toMatchObject({
      available: true,
      source: 'contour-chat',
      model: 'company-image',
      title: 'Company · dev',
      // Промпт режима на этой дороге уезжает системным сообщением — и панель
      // говорит это вслух, иначе правка промпта выглядит несработавшей.
      promptSent: true,
    });
  });

  it('шлюз не поднят — причина названа его тумблером, а не «нет модели»', () => {
    useContour(contour(), [model('company-image', true)]);

    const plan = planImage(deps({ gatewayPort: () => 0 }));

    expect(plan.available).toBe(false);
    expect(plan.rasterReason).toBe('gateway-off');
  });

  /**
   * A-1: «шлюз не поднят» — это ДВА разных состояния, и человеку от них нужно
   * разное. Тумблер выключен — его выбор, и снимает его он. Тумблер включён, а
   * слушателя нет — поднимать обязана панель, и послать человека «включить шлюз»,
   * который уже включён, значит послать чинить не то.
   */
  it('тумблер включён, слушателя нет — причина другая, и в ней отказ слушателя', () => {
    useContour(contour(), [model('company-image', true)]);
    store.updateSettings({
      platformGateway: { enabled: true, port: 5179, forceStream: true },
    });

    const plan = planImage(
      deps({ gatewayPort: () => 0, gatewayFailure: () => 'listen EADDRINUSE 5179' }),
    );

    expect(plan.rasterReason).toBe('gateway-failed');
    // Причину отказа панель выдумать не может — она приезжает от слушателя.
    expect(plan.reasonDetail).toBe('listen EADDRINUSE 5179');
  });

  it('тумблер включён — план сам поднимает свой шлюз, и ровно один раз', async () => {
    useContour(contour(), [model('company-image', true)]);
    store.updateSettings({
      platformGateway: { enabled: true, port: 5179, forceStream: true },
    });
    let raised = 0;
    let port = 0;
    const raising = deps({
      gatewayPort: () => port,
      raiseGateway: () => {
        raised += 1;
        port = 5179;
        return Promise.resolve();
      },
    });

    const plan = await planImageReady(raising);
    expect(raised).toBe(1);
    // И тот же расчёт отвечает уже доступной дорогой: замок там, где панель
    // умеет поднять шлюз одним вызовом, был отказом собственной работе.
    expect(plan).toMatchObject({ available: true, source: 'contour-chat' });

    // Шлюз жив — второй расчёт ничего не поднимает.
    await planImageReady(raising);
    expect(raised).toBe(1);
  });

  it('тумблер ВЫКЛЮЧЕН — панель не поднимает ничего и оставляет прежний замок', async () => {
    useContour(contour(), [model('company-image', true)]);
    let raised = 0;
    const plan = await planImageReady(
      deps({
        gatewayPort: () => 0,
        raiseGateway: () => {
          raised += 1;
          return Promise.resolve();
        },
      }),
    );

    expect(raised).toBe(0);
    expect(plan.rasterReason).toBe('gateway-off');
    // Настройка не тронута: включить её за человека — дело активации контура по
    // его же нажатию, а не расчёта плана картинки.
    expect(store.getSettings().platformGateway.enabled).toBe(false);
  });

  it('мешает не шлюз — поднимать нечего и незачем', async () => {
    useContour(contour(), [model('company-chat', false)]);
    store.updateSettings({
      platformGateway: { enabled: true, port: 5179, forceStream: true },
    });
    let raised = 0;
    const plan = await planImageReady(
      deps({
        gatewayPort: () => 0,
        raiseGateway: () => {
          raised += 1;
          return Promise.resolve();
        },
      }),
    );

    expect(plan.rasterReason).toBe('no-model');
    expect(raised).toBe(0);
  });

  it('совместимый контур ручку не объявляет — и не запирает дорогу профиля', () => {
    // `openai-compat` = «панель о возможностях этого шлюза не знает ничего»
    // (подписано как probe-guess). Рисовать при этом есть чем — профилем.
    useContour(contour({ driver: 'openai-compat' }), [model('any', false)]);
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });

    const plan = planImage(deps({ gatewayPort: () => 5100 }));

    expect(plan).toMatchObject({ available: true, source: 'endpoint', model: 'sd-xl' });
    // У ручки картинок системного сообщения нет вовсе — и это сказано.
    expect(plan.promptSent).toBe(false);
  });

  it('профиль без адреса генерации — своя причина: угадывать адрес нельзя (В4)', () => {
    store.updateSettings({ endpointProfiles: [profile()] });

    const plan = planImage(deps());

    expect(plan.available).toBe(false);
    expect(plan.rasterReason).toBe('endpoint-no-url');
  });

  it('профиль другого вида API — причина про вид, а не про адрес', () => {
    store.updateSettings({ endpointProfiles: [profile({ apiKind: 'anthropic' })] });

    const plan = planImage(deps());

    expect(plan.available).toBe(false);
    expect(plan.rasterReason).toBe('endpoint-api-kind');
  });

  it('профиль, порождённый контуром, за свой не считается', () => {
    // Такой профиль смотрит на НАШ же шлюз: рисовать через него — ходить к себе.
    store.updateSettings({
      endpointProfiles: [
        profile({ ownerPlatformId: 'gor', imagesUrl: 'http://127.0.0.1:1/v1/images/generations' }),
      ],
    });

    const plan = planImage(deps());

    expect(plan.available).toBe(false);
    expect(plan.rasterReason).toBe('no-route');
  });

  it('контур не рисует, а профиль сломан — причина та, которую человек чинит сам', () => {
    useContour(contour(), [model('company-chat', false)]);
    store.updateSettings({ endpointProfiles: [profile()] });

    const plan = planImage(deps({ gatewayPort: () => 5100 }));

    expect(plan.rasterReason).toBe('endpoint-no-url');
  });
});

describe('planImage: дорога агента — режим работает без контура и у любого CLI', () => {
  it('в разговоре режим доступен, даже когда рисовать растром нечем', () => {
    const plan = planImage(deps(), { agent: true });

    expect(plan).toMatchObject({ available: true, source: 'agent', promptSent: true });
    // Главное, что просил владелец: «нет контура» больше не запирает картинки.
    // Но и неправды в обратную сторону нет — почему нет РАСТРА, панель говорит.
    expect(plan.rasterReason).toBe('no-route');
    expect(plan.reason).toBeUndefined();
  });

  it('растровая дорога сильнее: с рисующим контуром выбирается она, а не агент', () => {
    useContour(contour(), [model('company-image', true)]);

    const plan = planImage(deps({ gatewayPort: () => 5100 }), { agent: true });

    // Просят обычно снимок, а агент рисует вектор кодом: продукт другой, и
    // подменять им растр, когда растр есть, панель не вправе.
    expect(plan.source).toBe('contour-chat');
    expect(plan.rasterReason).toBeUndefined();
  });

  it('модель разговора панели неизвестна — и она её не выдумывает', () => {
    useContour(contour(), [model('company-chat', false)]);

    const plan = planImage(deps({ gatewayPort: () => 5100 }), { agent: true });

    expect(plan.source).toBe('agent');
    expect(plan.model).toBe('');
    expect(plan.title).toBe('');
  });
});

describe('savePicture: рисунок из блока агента', () => {
  it('вектор ложится файлом, запись называет дорогу и тип', () => {
    const svg = '<svg viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg"><rect width="4"/></svg>';

    const image = savePicture(deps({ now: () => new Date('2026-09-13T08:00:00.000Z') }), {
      chatId: 'chat-7',
      prompt: 'схема потоков',
      block: svg,
      model: 'claude-opus-5',
    });

    expect(image).toMatchObject({
      chatId: 'chat-7',
      mime: 'image/svg+xml',
      source: 'agent',
      model: 'claude-opus-5',
      prompt: 'схема потоков',
      createdAt: '2026-09-13T08:00:00.000Z',
    });
    expect(image.name).toBe(`picture-${image.id}.svg`);
    // Расширение на диске то же, что в имени записи: пара «байты + `.json`» —
    // единственный источник правды о картинке, и `.bin` рядом с обещанным `.svg`
    // означал бы карточку, которая не покажет ничего.
    expect(readFileSync(join(mediaDir(appData), `${image.id}.svg`), 'utf8')).toBe(svg);
    // То же обещание, что у растра: в настройках панели картинок нет. Настройки
    // трогаются нарочно — иначе файла нет вовсе и проверка ничего не проверяет.
    store.updateSettings({});
    expect(readFileSync(join(appData, 'state.json'), 'utf8')).not.toContain('<svg');
  });

  it('скрипт в рисунке — отказ 400 словами, и на диске ничего не остаётся', () => {
    const error = savePictureError({
      block: '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api")</script></svg>',
    });

    expect(isMediaError(error)).toBe(true);
    expect((error as MediaError).status).toBe(400);
    expect((error as MediaError).message).toContain('скрипт');
    expect(existsSync(mediaDir(appData))).toBe(false);
  });

  it('ссылка наружу и не-вектор — свои причины, а не одна общая', () => {
    expect(
      (
        savePictureError({
          block: '<svg><image href="https://cdn.example/x.png"/></svg>',
        }) as MediaError
      ).message,
    ).toContain('самодостаточным');
    expect((savePictureError({ block: '<html><body/></html>' }) as MediaError).message).toContain(
      'не рисунок SVG',
    );
  });
});

/** Отказ `savePicture` как значение: у него проверяется текст, а не стек. */
function savePictureError(request: { block: string }): unknown {
  try {
    savePicture(deps(), { chatId: '', prompt: '', model: '', ...request });
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('generateImage: дорога «частью ответа» через свой шлюз', () => {
  it('запрос уходит на свой шлюз в диалекте OpenAI, с промптом режима', async () => {
    useContour(contour(), [model('company-image', true)]);
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: PlatformFetch = (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(reply(framesWithImage(png())));
    };

    const image = await generateImage(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: 'chat-1',
      prompt: 'кот на подоконнике',
    });

    // Через СВОЙ шлюз, а не напрямую: там след запроса, учёт расхода и перевод
    // отказов контура. И в диалекте OpenAI — мост Anthropic картинку не несёт.
    expect(seen[0]?.url).toBe('http://127.0.0.1:5100/gor/v1/chat/completions');
    expect(seen[0]?.body).toMatchObject({
      model: 'company-image',
      stream: true,
      messages: [
        { role: 'system', content: promptText(appData, 'image') },
        { role: 'user', content: 'кот на подоконнике' },
      ],
    });
    expect(image).toMatchObject({
      chatId: 'chat-1',
      mime: 'image/png',
      model: 'company-image',
      source: 'contour-chat',
      prompt: 'кот на подоконнике',
      width: 2,
      height: 1,
    });
  });

  it('байты ложатся файлом, а в настройках панели их нет ни одного', async () => {
    useContour(contour(), [model('company-image', true)]);
    const bytes = png();
    const fetchImpl: PlatformFetch = () => Promise.resolve(reply(framesWithImage(bytes)));

    const image = await generateImage(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'схема',
    });

    const files = readdirSync(mediaDir(appData));
    expect(files).toContain(`${image.id}.png`);
    expect(readFileSync(join(mediaDir(appData), `${image.id}.png`))).toEqual(bytes);
    expect(image.sizeBytes).toBe(bytes.length);
    // Главное обещание задачи: настройки человек читает и переносит архивом, и
    // мегабайта base64 в них быть не должно.
    const state = readFileSync(join(appData, 'state.json'), 'utf8');
    expect(state).not.toContain(bytes.toString('base64').slice(0, 24));
    expect(state).not.toContain('data:image/png');
  });

  it('модель ответила словами — отказ несёт её слова, а не «панель сломалась»', async () => {
    useContour(contour(), [model('company-image', true)]);
    const frames =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Рисовать не буду, вот описание' } }] })}\n\n` +
      'data: [DONE]\n\n';
    const fetchImpl: PlatformFetch = () => Promise.resolve(reply(frames));

    const error = await generateImage(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'кот',
    }).catch((thrown: unknown) => thrown as MediaError);

    expect(isMediaError(error)).toBe(true);
    expect((error as MediaError).status).toBe(502);
    expect((error as MediaError).message).toContain('Рисовать не буду');
  });

  it('ссылка вместо байтов — отказ: по чужим адресам панель не ходит', async () => {
    useContour(contour(), [model('company-image', true)]);
    const frames =
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              content: [{ type: 'image_url', image_url: { url: 'https://cdn.example/1.png' } }],
            },
          },
        ],
      })}\n\n` + 'data: [DONE]\n\n';
    const fetchImpl: PlatformFetch = () => Promise.resolve(reply(frames));

    const error = await generateImage(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'кот',
    }).catch((thrown: unknown) => thrown as MediaError);

    expect((error as MediaError).message).toContain('по чужим адресам панель не ходит');
    expect(existsSync(mediaDir(appData))).toBe(false);
  });

  it('отказ контура приезжает его словами и кодом 502, а не пустой картинкой', async () => {
    useContour(contour(), [model('company-image', true)]);
    const fetchImpl: PlatformFetch = () =>
      Promise.resolve(reply(JSON.stringify({ error: { message: 'проверки контента' } }), 451));

    const error = await generateImage(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'кот',
    }).catch((thrown: unknown) => thrown as MediaError);

    expect((error as MediaError).status).toBe(502);
    expect((error as MediaError).message).toContain('проверки контента');
    expect((error as MediaError).message).toContain('451');
  });

  it('запертый режим отказывает ДО запроса и называет причину', async () => {
    let called = 0;
    const fetchImpl: PlatformFetch = () => {
      called += 1;
      return Promise.resolve(reply('{}'));
    };

    const error = await generateImage(deps({ fetchImpl }), { chatId: '', prompt: 'кот' }).catch(
      (thrown: unknown) => thrown as MediaError,
    );

    expect(called).toBe(0);
    expect((error as MediaError).status).toBe(409);
    expect((error as MediaError).reason).toBe('no-route');
  });
});

describe('generateImage: ручка картинок своего эндпоинта', () => {
  it('просит сами байты и берёт адрес из ПОЛЯ профиля', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    const seen: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
    const bytes = png();
    const fetchImpl: PlatformFetch = (url, init) => {
      seen.push({
        url,
        body: JSON.parse(String(init?.body)),
        ...(init?.headers ? { headers: init.headers } : {}),
      });
      return Promise.resolve(
        reply(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })),
      );
    };

    const image = await generateImage(deps({ fetchImpl }), { chatId: 'c', prompt: 'логотип' });

    expect(seen[0]?.url).toBe('http://127.0.0.1:11434/v1/images/generations');
    expect(seen[0]?.body).toMatchObject({
      model: 'sd-xl',
      prompt: 'логотип',
      response_format: 'b64_json',
    });
    // Токена у профиля нет — и заголовка авторизации тоже: пустой Bearer чужой
    // сервер отклоняет иначе, чем его отсутствие.
    expect(seen[0]?.headers?.authorization).toBeUndefined();
    expect(image.source).toBe('endpoint');
    expect(image.mime).toBe('image/png');
  });

  it('второй запрос ждёт первого: наверх уходит один рисунок за раз', async () => {
    // Ревью Т9, MINOR 8: справка это обещала, а держала только кнопка одной
    // страницы — две вкладки заказывали два рисунка разом и два списания.
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    const bytes = png();
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const fetchImpl: PlatformFetch = async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      // Первый отказывает — очередь обязана пустить второй всё равно.
      if (calls === 1) return reply('{"error":{"message":"занято"}}', 503);
      return reply(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
    };

    const [first, second] = await Promise.allSettled([
      generateImage(deps({ fetchImpl }), { chatId: 'a', prompt: 'кот' }),
      generateImage(deps({ fetchImpl }), { chatId: 'b', prompt: 'пёс' }),
    ]);

    expect(peak).toBe(1);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('ответ без байтов и без адреса — названный отказ, а не пустой файл', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    const fetchImpl: PlatformFetch = () => Promise.resolve(reply(JSON.stringify({ data: [{}] })));

    const error = await generateImage(deps({ fetchImpl }), { chatId: '', prompt: 'кот' }).catch(
      (thrown: unknown) => thrown as MediaError,
    );

    expect((error as MediaError).message).toContain('ни байтов, ни адреса');
  });

  it('ответ не JSON — тоже названный отказ', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    const fetchImpl: PlatformFetch = () => Promise.resolve(reply('<html>502 Bad Gateway</html>'));

    const error = await generateImage(deps({ fetchImpl }), { chatId: '', prompt: 'кот' }).catch(
      (thrown: unknown) => thrown as MediaError,
    );

    expect((error as MediaError).message).toContain('не JSON');
  });
});

/**
 * Отдельная ручка картинок контура (DRV-18): путь ОБЪЯВЛЯЕТ манифест драйвера,
 * панель его не угадывает. До задачи строка `images-api` не несла пути, и дорога
 * шла на угаданный `images/generations`, а моделью подставлялась модель чата
 * контура — ручка картинок такую отвергает. Драйвер подменён на время теста тем
 * же объектом, который читает дорога: реестр драйверов закрыт.
 */
describe('generateImage: ручка картинок контура — через свой шлюз', () => {
  const driver = driverFor('openai-compat');
  const declared = driver.images;
  afterEach(() => {
    driver.images = declared;
  });

  function gateway(): Platform {
    return contour({
      driver: 'openai-compat',
      baseUrl: 'https://gw.example.ru/v1',
      defaultModel: 'chat-large',
      transport: defaultPlatformTransport(),
    });
  }

  async function drawnVia(models: PlatformModelInfo[]) {
    driver.images = { api: 'images/create' };
    useContour(gateway(), models);
    const seen: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const bytes = png();
    const fetchImpl: PlatformFetch = (url, init) => {
      seen.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        reply(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] })),
      );
    };
    const image = await generateImage(deps({ fetchImpl, gatewayPort: () => 5100 }), {
      chatId: 'c',
      prompt: 'кот',
    });
    return { image, seen };
  }

  // Объявленный путь ручки теперь знает ШЛЮЗ (`gateway/images.ts`); домен идёт на
  // свой маршрут шлюза без ключа — ключ, след и расход подставляет шлюз.
  it('адрес — свой шлюз, и ключа контура в запросе панели нет', async () => {
    const { image, seen } = await drawnVia([model('flux-1', true)]);
    expect(seen[0]?.url).toBe(`http://127.0.0.1:5100/${gateway().id}/v1/images/generations`);
    expect(Object.keys(seen[0]?.headers ?? {}).map((key) => key.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(seen[0]?.body.model).toBe('flux-1');
    expect(image.source).toBe('contour-images');
  });

  it('шлюз погашен — дорога заперта причиной шлюза, наружу не уходит ничего', async () => {
    driver.images = { api: 'images/create' };
    useContour(gateway(), [model('flux-1', true)]);
    const plan = planImage(deps({ gatewayPort: () => 0 }));
    expect(plan.available).toBe(false);
    expect(plan.rasterReason ?? plan.reason).toBe('gateway-off');
    let called = false;
    const fetchImpl: PlatformFetch = () => {
      called = true;
      return Promise.resolve(reply('{}'));
    };
    await expect(
      generateImage(deps({ fetchImpl, gatewayPort: () => 0 }), { chatId: 'c', prompt: 'кот' }),
    ).rejects.toMatchObject({ status: 409, reason: 'gateway-off' });
    expect(called).toBe(false);
  });

  it('рисующей модели в каталоге нет — чатовая не подставляется, поле модели не шлётся', async () => {
    const { seen } = await drawnVia([model('chat-large', false)]);
    expect(seen[0]?.body).not.toHaveProperty('model');
  });
});
