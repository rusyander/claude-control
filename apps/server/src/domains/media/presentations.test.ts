import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import type {
  EndpointProfile,
  MediaDeck,
  Platform,
  PlatformModelInfo,
} from '@agentdeck/contracts';
import { defaultOurRules, defaultPlatformRules } from '@agentdeck/contracts/platform';
import { DECK_MAX_RASTER } from '@agentdeck/contracts/media-deck';
import { AppStore } from '../../lib/app-store.ts';
import type { PlatformFetch } from '../platform/ca-fetch.ts';
import { promptText } from '../prompts.ts';
import {
  deckFromBlock,
  deckFile,
  deckRevisePrompt,
  generateDeck,
  planDeck,
} from './presentations.ts';
import { canPrintPdf } from './deck/pdf.ts';
import { deckFilePath, hasDeckFile, readDeckRecord } from './deck/store.ts';
import { isMediaError, type MediaError } from './errors.ts';
import type { MediaDeps } from './upstream.ts';

/**
 * Презентации: дорога есть всегда, файлы собирает панель.
 *
 * Обещания, запертые здесь, — те, которые легко потерять правкой маршрута:
 *
 *  - режим НЕ требует объявленной возможности. Диктовать структуру умеет любая
 *    текстовая модель, и «нет флага» заперло бы режим на пустом месте — ровно
 *    наоборот тому, как устроены картинки;
 *  - первой идёт дорога агента: она есть у любого CLI и не тратит ключ;
 *  - PDF обещается только там, где есть чем печатать, и причина называется;
 *  - колода лежит в записи структурой, поэтому PPTX и PDF собираются спустя дни
 *    без второго запроса к модели.
 *
 * Чужая сторона подставлена (`fetchImpl`) — это сеть; всё остальное, включая
 * сборку файлов, работает настоящее.
 */

let appData: string;
let store: AppStore;

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'deck-'));
  store = new AppStore(appData);
});

afterEach(() => {
  rmSync(appData, { recursive: true, force: true });
});

/** Окружение, в котором браузер для печати ЕСТЬ: путь существует. */
const WITH_BROWSER = { AGENTDECK_BROWSER: fileURLToPath(import.meta.url) };

const DECK = {
  title: 'Итоги квартала',
  subtitle: 'Отдел продаж',
  slides: [
    { title: 'Выручка', bullets: ['выросла вдвое'], notes: 'вслух' },
    { title: 'Дальше', bullets: ['нанять двоих'] },
  ],
};

function contour(overrides: Partial<Platform> = {}): Platform {
  return {
    id: 'gor',
    title: 'EnterprisePlatform · dev',
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
    model: 'qwen2.5',
    writeToken: false,
    imagesUrl: '',
    ownerPlatformId: '',
    ...overrides,
  };
}

function useContour(platform: Platform, models: PlatformModelInfo[] = []): void {
  store.updateSettings({ platforms: [platform], activePlatformId: platform.id });
  store.savePlatformHealth(platform.id, {
    ok: true,
    checkedAt: '2026-09-13T10:00:00.000Z',
    models,
  } as never);
}

function deps(extra: Partial<MediaDeps> = {}): MediaDeps {
  return { appDataDir: appData, store, env: {}, ...extra };
}

/**
 * Настоящий PNG — крошечный, но с подписью и IHDR: панель читает у картинки
 * размеры сама, и подделка из случайных байтов не дошла бы до файла колоды.
 */
function png(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
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

/** Ответ ручки картинок: байты в base64, как их отдаёт OpenAI-вид. */
function drawn(): Response {
  return new Response(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ответ `chat/completions` без потока: колода строкой в содержимом. */
function answer(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('planDeck: кто соберёт колоду', () => {
  it('в разговоре — агент, и ни контура, ни ключа для этого не нужно', () => {
    const plan = planDeck(deps(), { agent: true });

    expect(plan).toMatchObject({ available: true, source: 'agent', model: '' });
  });

  it('дорога агента сильнее контура: за уже оплаченное подпиской ключ не тратится', () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));

    const plan = planDeck(deps({ gatewayPort: () => 5100 }), { agent: true });

    expect(plan.source).toBe('agent');
  });

  it('без разговора собирает контур — и БЕЗ всякой объявленной возможности', () => {
    // Каталог ключа пуст на флаги: диктовать структуру умеет любая текстовая
    // модель, и требовать объявления значило бы запереть режим на пустом месте.
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }), [
      { id: 'enterprise-platform-chat', imageGeneration: false } as PlatformModelInfo,
    ]);

    const plan = planDeck(deps({ gatewayPort: () => 5100 }));

    expect(plan).toMatchObject({
      available: true,
      source: 'contour',
      model: 'enterprise-platform-chat',
      title: 'EnterprisePlatform · dev',
    });
  });

  it('модель контура не выбрана — берётся первая из каталога ключа', () => {
    useContour(contour(), [{ id: 'enterprise-platform-8b' } as PlatformModelInfo]);

    expect(planDeck(deps({ gatewayPort: () => 5100 })).model).toBe('enterprise-platform-8b');
  });

  it('модель по умолчанию — тем же правилом, что у прогонов: не эмбеддинг и не рисование', () => {
    // Аудит MD-05: своя копия выбора брала первую строку каталога как есть, а
    // контур отдаёт вложения и модели рисования одним списком с чатом.
    useContour(contour(), [
      { id: 'bge-m3', kind: 'embedding' } as PlatformModelInfo,
      { id: 'enterprise-platform-image', kind: 'chat', imageGeneration: true } as PlatformModelInfo,
      { id: 'enterprise-platform-8b', kind: 'chat' } as PlatformModelInfo,
    ]);

    expect(planDeck(deps({ gatewayPort: () => 5100 })).model).toBe('enterprise-platform-8b');
  });

  it('ни выбранной модели, ни каталога — причина про модель, а не «некому»', () => {
    useContour(contour());

    const plan = planDeck(deps({ gatewayPort: () => 5100 }));

    expect(plan.available).toBe(false);
    expect(plan.reason).toBe('no-model');
  });

  it('шлюз не поднят — причина названа его тумблером', () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));

    const plan = planDeck(deps({ gatewayPort: () => 0 }));

    expect(plan.available).toBe(false);
    expect(plan.reason).toBe('gateway-off');
  });

  it('свой эндпоинт OpenAI-вида годится, другого вида — нет, и это разные причины', () => {
    store.updateSettings({ endpointProfiles: [profile()] });
    expect(planDeck(deps())).toMatchObject({
      available: true,
      source: 'endpoint',
      model: 'qwen2.5',
    });

    store.updateSettings({ endpointProfiles: [profile({ apiKind: 'anthropic' })] });
    expect(planDeck(deps()).reason).toBe('endpoint-api-kind');
  });

  it('ни разговора, ни контура, ни профиля — «собирать некому»', () => {
    const plan = planDeck(deps());

    expect(plan.available).toBe(false);
    expect(plan.reason).toBe('no-route');
    expect(plan.compromise).toBe('media-by-capability');
  });

  it('PDF обещается по факту наличия браузера, и отказ называет причину', () => {
    // Оба ответа приходят вместе с планом, до нажатия: кнопка, которая ответит
    // отказом, — то же самое, что спрятанная причина.
    expect(planDeck(deps(), { agent: true }).pdf).toEqual({
      available: false,
      reason: 'no-browser',
    });
    expect(planDeck(deps({ env: WITH_BROWSER }), { agent: true }).pdf).toEqual({ available: true });
  });
});

describe('generateDeck: свой запрос через шлюз', () => {
  it('уходит на свой шлюз в диалекте OpenAI, без потока и с промптом каталога', async () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: PlatformFetch = (url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(answer(JSON.stringify(DECK)));
    };

    const deck = await generateDeck(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: 'chat-1',
      prompt: 'итоги квартала',
    });

    expect(seen[0]?.url).toBe('http://127.0.0.1:5100/gor/v1/chat/completions');
    expect(seen[0]?.body).toMatchObject({
      model: 'enterprise-platform-chat',
      // Не потоком: колода нужна целиком, кусками её не разобрать.
      stream: false,
      messages: [
        { role: 'system', content: promptText(appData, 'presentation') },
        { role: 'user', content: expect.stringContaining('Тема: итоги квартала') },
      ],
    });
    // Вопросов на этой дороге быть не может: разговора нет, и ответить на них
    // некому — вопрос вместо колоды стал бы отказом «модель ответила не колодой».
    const asked = String((seen[0]?.body.messages as Array<{ content: string }>)[1]?.content ?? '');
    expect(asked).toContain('Вопросов не задавай');
    expect(asked).toContain('agentdeck:deck');
    expect(deck).toMatchObject({
      chatId: 'chat-1',
      title: 'Итоги квартала',
      source: 'contour',
      model: 'enterprise-platform-chat',
      // Титульный лист плюс слайд на каждый пункт.
      slideCount: 3,
    });
  });

  it('файлы кладутся сразу, а PDF в списке нет, пока печатать нечем', async () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));
    const fetchImpl: PlatformFetch = () => Promise.resolve(answer(JSON.stringify(DECK)));

    const deck = await generateDeck(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
    });

    expect(deck.formats).toEqual(['html', 'pptx']);
    expect(existsSync(deckFilePath(appData, deck.id, 'html'))).toBe(true);
    expect(existsSync(deckFilePath(appData, deck.id, 'pptx'))).toBe(true);
    expect(existsSync(deckFilePath(appData, deck.id, 'pdf'))).toBe(false);
    // Структура лежит в записи: из неё собирается PPTX и печатается PDF спустя
    // дни, без второго запроса к модели.
    expect(readDeckRecord(appData, deck.id)?.deck.slides).toHaveLength(2);
    // И ни строки колоды в настройках панели.
    expect(readFileSync(join(appData, 'state.json'), 'utf8')).not.toContain('Итоги квартала');
  });

  it('с браузером PDF появляется в списке видов — но файл печатается позже', async () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));
    const fetchImpl: PlatformFetch = () => Promise.resolve(answer(JSON.stringify(DECK)));

    const deck = await generateDeck(
      deps({ gatewayPort: () => 5100, fetchImpl, env: WITH_BROWSER }),
      { chatId: '', prompt: 'итоги' },
    );

    expect(deck.formats).toContain('pdf');
    expect(existsSync(deckFilePath(appData, deck.id, 'pdf'))).toBe(false);
  });

  it('колода в обёртке из размышлений и вежливой прозы — всё равно колода', async () => {
    // Аудит MD-07: модели средней руки и рассуждающие модели заворачивают JSON в
    // фразу или в `<think>`. Структура в ответе была, а панель говорила «ответила
    // не колодой» — и человек менял модель, которая работала.
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));
    const fetchImpl: PlatformFetch = () =>
      Promise.resolve(
        answer(
          '<think>Нужно два слайда, первый про выручку.</think>\nКонечно! Вот презентация:\n```json\n' +
            JSON.stringify(DECK) +
            '\n```\nНадеюсь, пригодится.',
        ),
      );

    const deck = await generateDeck(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
    });

    expect(readDeckRecord(appData, deck.id)?.deck.title).toBe('Итоги квартала');
  });

  it('модель ответила прозой — отказ несёт её слова, а не «панель сломалась»', async () => {
    useContour(contour({ defaultModel: 'enterprise-platform-chat' }));
    const fetchImpl: PlatformFetch = () =>
      Promise.resolve(answer('Конечно! Вот план вашей презентации: сначала титул…'));

    const error = await generateDeck(deps({ gatewayPort: () => 5100, fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
    }).catch((thrown: unknown) => thrown as MediaError);

    expect(isMediaError(error)).toBe(true);
    expect((error as MediaError).status).toBe(502);
    expect((error as MediaError).message).toContain('Вот план вашей презентации');
  });

  it('запертый режим отказывает ДО запроса и называет причину', async () => {
    let called = 0;
    const fetchImpl: PlatformFetch = () => {
      called += 1;
      return Promise.resolve(answer('{}'));
    };

    const error = await generateDeck(deps({ fetchImpl }), { chatId: '', prompt: 'итоги' }).catch(
      (thrown: unknown) => thrown as MediaError,
    );

    expect(called).toBe(0);
    expect((error as MediaError).status).toBe(409);
    expect((error as MediaError).reason).toBe('no-route');
  });
});

describe('deckFromBlock: колода, надиктованная агентом разговора', () => {
  it('принимается без всякой сети и подписывается моделью разговора', async () => {
    let called = 0;
    const fetchImpl: PlatformFetch = () => {
      called += 1;
      return Promise.resolve(answer('{}'));
    };

    const deck = await deckFromBlock(deps({ fetchImpl }), {
      chatId: 'chat-9',
      prompt: 'итоги квартала',
      block: JSON.stringify(DECK),
      model: 'claude-opus-5',
    });

    // Ни одного запроса: то, что агент уже сказал, панель не переспрашивает.
    expect(called).toBe(0);
    expect(deck).toMatchObject({
      source: 'agent',
      model: 'claude-opus-5',
      chatId: 'chat-9',
      slideCount: 3,
    });
    expect(existsSync(deckFilePath(appData, deck.id, 'pptx'))).toBe(true);
  });

  it('в блоке не колода — 400 с причиной, и файлов не появляется', async () => {
    const error = await deckFromBlock(deps(), {
      chatId: '',
      prompt: '',
      block: '{"title":"без слайдов"}',
      model: '',
    }).catch((thrown: unknown) => thrown as MediaError);

    expect((error as MediaError).status).toBe(400);
    expect((error as MediaError).message).toContain('ни одного слайда');
    expect(existsSync(join(appData, 'media', 'decks'))).toBe(false);
  });
});

describe('правка колоды: панель помнит вместо агента', () => {
  /** Колода из блока — то, что человек уже видел карточкой. */
  async function made(deck: unknown = DECK): Promise<MediaDeck> {
    return await deckFromBlock(deps(), {
      chatId: 'chat-1',
      prompt: 'итоги квартала',
      block: JSON.stringify(deck),
      model: 'claude-opus-5',
    });
  }

  it('просьба к агенту несёт структуру прежней колоды и запрет на разницу', async () => {
    const previous = await made();

    const prompt = deckRevisePrompt(deps(), previous.id, 'третий слайд короче');

    // Структура целиком: без неё «поправь третий слайд» означало бы новую колоду.
    expect(prompt).toContain('Итоги квартала');
    expect(prompt).toContain('выросла вдвое');
    expect(prompt).toContain('третий слайд короче');
    expect(prompt).toContain('ВСЯ колода после правки');
    // Правила режима из каталога — в той же просьбе: у агента системного
    // сообщения нет, и второго места для правил не существует.
    expect(prompt).toContain('Раскладки');
  });

  it('колоды на диске уже нет — 404 словами, а не молчаливая новая колода', () => {
    expect(() => deckRevisePrompt(deps(), 'f'.repeat(20), 'поправь')).toThrow(/уже нет/);
  });

  it('правка помнит, что она правка, а прежние файлы остаются на диске', async () => {
    const previous = await made();

    const revised = await deckFromBlock(deps(), {
      chatId: 'chat-1',
      prompt: 'итоги квартала',
      block: JSON.stringify({ ...DECK, title: 'Итоги квартала — коротко' }),
      model: 'claude-opus-5',
      reviseOf: previous.id,
    });

    expect(revised.revisionOf).toBe(previous.id);
    // Неудачная правка не забирает с собой показанное: прежние файлы живут до
    // потолка хранилища.
    expect(existsSync(deckFilePath(appData, previous.id, 'html'))).toBe(true);
    expect(readDeckRecord(appData, previous.id)?.title).toBe('Итоги квартала');
  });

  it('чужой `pictureId` в ответе модели выбрасывается, свой — сохраняется', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    const fetchImpl: PlatformFetch = () => Promise.resolve(drawn());

    // Первая сборка рисует картинку сама — её имя придумала панель.
    const first = await deckFromBlock(deps({ fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify({
        ...DECK,
        slides: [{ ...DECK.slides[0], illustration: 'график выручки' }],
      }),
      model: '',
    });
    expect(first.drawnPictures).toBe(1);
    const mine = readDeckRecord(appData, first.id)?.deck.slides[0]?.pictureId ?? '';
    expect(mine).not.toBe('');

    const revised = await deckFromBlock(deps({ fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify({
        ...DECK,
        slides: [
          { ...DECK.slides[0], pictureId: mine },
          // Имя, которого в ПРОШЛОЙ колоде не было: так в колоду вписали бы
          // чужой файл хранилища, и он уехал бы байтами в PPTX.
          { ...DECK.slides[1], pictureId: 'ab'.repeat(8) },
        ],
      }),
      model: '',
      reviseOf: first.id,
    });

    const slides = readDeckRecord(appData, revised.id)?.deck.slides ?? [];
    expect(slides[0]?.pictureId).toBe(mine);
    expect(slides[1]?.pictureId).toBeUndefined();
    // Своя картинка перешла в правку, а не была нарисована заново: запрос к
    // ключу стоит денег, и правка текста их не тратит.
    expect(revised.drawnPictures).toBeUndefined();
  });
});

describe('картинки слайдам: панель рисует своей дорогой', () => {
  const WITH_ILLUSTRATIONS = {
    ...DECK,
    slides: [
      { title: 'Раз', bullets: ['первый'], notes: '', illustration: 'рассвет над городом' },
      { title: 'Два', bullets: ['второй'], notes: '', illustration: 'стол с ноутбуком' },
      { title: 'Три', bullets: ['третий'], notes: '', illustration: 'третья картинка' },
    ],
  };

  it('рисует по потолку панели, а не по числу просьб модели', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    let asked = 0;
    const fetchImpl: PlatformFetch = () => {
      asked += 1;
      return Promise.resolve(drawn());
    };

    const deck = await deckFromBlock(deps({ fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify(WITH_ILLUSTRATIONS),
      model: '',
    });

    // Три просьбы, потолок два: каждая картинка — запрос наверх и деньги ключа.
    expect(asked).toBe(DECK_MAX_RASTER);
    expect(deck.drawnPictures).toBe(DECK_MAX_RASTER);
    expect(deck.pictureReason).toBeUndefined();
    const slides = readDeckRecord(appData, deck.id)?.deck.slides ?? [];
    expect(slides.filter((slide) => slide.pictureId).length).toBe(DECK_MAX_RASTER);
    // Картинки уезжают в файл байтами: страница колоды отдаётся с запретом сети.
    const html = (await deckFile(deps(), deck.id, 'html')).bytes.toString('utf8');
    expect(html).toContain('data:image/png;base64,');
  });

  it('растровой дороги нет — колода собирается, а причина едет в запись', async () => {
    const deck = await deckFromBlock(deps(), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify(WITH_ILLUSTRATIONS),
      model: '',
    });

    expect(deck.drawnPictures).toBeUndefined();
    expect(deck.pictureReason).toBe('no-route');
    // Файлы на месте: отсутствие снимков не отказ колоды.
    expect(existsSync(deckFilePath(appData, deck.id, 'html'))).toBe(true);
  });

  it('первая неудача останавливает остальные и называется причиной', async () => {
    store.updateSettings({
      endpointProfiles: [profile({ imagesUrl: 'http://127.0.0.1:11434/v1/images/generations' })],
    });
    let asked = 0;
    const fetchImpl: PlatformFetch = () => {
      asked += 1;
      return Promise.resolve(
        new Response('{"error":{"message":"квота"}}', {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };

    const deck = await deckFromBlock(deps({ fetchImpl }), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify(WITH_ILLUSTRATIONS),
      model: '',
    });

    // Ключ, отказавший один раз, откажет и на второй — ждать ещё минуты незачем.
    expect(asked).toBe(1);
    expect(deck.drawnPictures).toBeUndefined();
    expect(deck.pictureReason).toBe('draw-failed');
  });
});

describe('deckFile: отдать файл', () => {
  async function madeDeck(env: NodeJS.ProcessEnv = {}): Promise<string> {
    const deck = await deckFromBlock(deps({ env }), {
      chatId: '',
      prompt: 'итоги',
      block: JSON.stringify(DECK),
      model: '',
    });
    return deck.id;
  }

  it('HTML и PPTX читаются с диска', async () => {
    const id = await madeDeck();

    const html = await deckFile(deps(), id, 'html');
    const pptx = await deckFile(deps(), id, 'pptx');

    expect(html.bytes.toString('utf8')).toContain('Итоги квартала');
    expect(pptx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(html.record.title).toBe('Итоги квартала');
  });

  it('чужого идентификатора не существует, и путь им не построить', async () => {
    const missing = await deckFile(deps(), 'a'.repeat(20), 'html').catch(
      (thrown: unknown) => thrown as MediaError,
    );
    expect((missing as MediaError).status).toBe(404);

    // Часть пути из запроса иначе вывела бы чтение за каталог данных.
    const escape = await deckFile(deps(), '../../state', 'html').catch(
      (thrown: unknown) => thrown as MediaError,
    );
    expect((escape as MediaError).status).toBe(400);
  });

  it('печатать нечем — отказ называет браузеры и напоминает про HTML с PPTX', async () => {
    const id = await madeDeck();

    const error = await deckFile(deps(), id, 'pdf').catch(
      (thrown: unknown) => thrown as MediaError,
    );

    expect((error as MediaError).status).toBe(409);
    expect((error as MediaError).message).toContain('Chrome');
    expect((error as MediaError).message).toContain('PPTX');
  });

  it.skipIf(!canPrintPdf())(
    'живая печать по требованию: PDF остаётся рядом и второй раз не печатается',
    async () => {
      const live = (): MediaDeps => deps({ env: process.env });
      const id = await madeDeck(process.env);
      expect(hasDeckFile(appData, id, 'pdf')).toBe(false);

      const first = await deckFile(live(), id, 'pdf');
      expect(first.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(hasDeckFile(appData, id, 'pdf')).toBe(true);

      // Второй спрос читает файл, а не запускает браузер снова. Доказательство —
      // байт в байт тот же файл: печать дважды дала бы другую дату внутри PDF.
      const second = await deckFile(live(), id, 'pdf');
      expect(second.bytes).toEqual(first.bytes);
    },
    120_000,
  );
});
