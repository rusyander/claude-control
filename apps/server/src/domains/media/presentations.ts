import { randomBytes } from 'node:crypto';
import type {
  Deck,
  DeckPictureBlocker,
  MediaDeck,
  MediaDeckBlocker,
  MediaDeckFormat,
  MediaDeckPlan,
  MediaDeckSource,
  Platform,
} from '@agentdeck/contracts';
import {
  deckBlockRequest,
  deckReviseRequest,
  parseDeckAnswer,
  parseDeckBlock,
  stripReasoning,
} from '@agentdeck/contracts/media-block';
import { DECK_MAX_RASTER } from '@agentdeck/contracts/media-deck';
import { createCaFetch, type PlatformFetch } from '../platform/ca-fetch.ts';
import { defaultModelOf } from '../platform/models.ts';
import {
  defaultPlatformTransport,
  platformRequestUrl,
} from '@agentdeck/contracts/platform-transport';
import { readEndpointToken } from '../endpoints.ts';
import { promptText } from '../prompts.ts';
import { MediaError } from './errors.ts';
import {
  activeContour,
  askUpstream,
  EXCERPT,
  gatewayUrl,
  isRecord,
  ownProfiles,
  readCapped,
  refusalOf,
  type MediaDeps,
} from './upstream.ts';
import { renderDeckHtml } from './deck/html.ts';
import { renderDeckPptx } from './deck/pptx.ts';
import { canPrintPdf, printDeckPdf } from './deck/pdf.ts';
import { deckAssets } from './deck/assets.ts';
import { generateImage, planImage } from './images.ts';
import { readImageRecord } from './store.ts';
import { isMediaError } from './errors.ts';
import {
  cacheDeckPdf,
  hasDeckFile,
  readDeckFile,
  readDeckRecord,
  saveDeck,
  type StoredDeck,
} from './deck/store.ts';

/**
 * Презентация по просьбе человека из чата.
 *
 * compromise: media-by-capability — режим доступен там, где возможность объявлена, и недоступность называется словами
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ КАРТИНОК. Там дорога решала, чем рисовать, и без
 * объявленной возможности рисовать было нечем. Здесь надиктовать структуру умеет
 * любая текстовая модель, поэтому первой идёт дорога, которая есть ВСЕГДА:
 *
 *   1. `agent` — агент самого разговора. Панель отправляет просьбу обычным
 *      сообщением (промпт каталога + строка протокола) и принимает блок
 *      `agentdeck:deck` из ответа. Ни контура, ни ключа, ни особой
 *      возможности не нужно — работает у Claude и у любого чужого CLI. Цена,
 *      которую панель платит осознанно: блок остаётся в переписке и весит
 *      несколько килобайт контекста;
 *   2. `contour` — активный контур через СВОЙ ЖЕ шлюз (диалект OpenAI). Нужен,
 *      когда разговора нет вовсе: черновик, телефон, `curl`;
 *   3. `endpoint` — свой эндпоинт человека OpenAI-вида.
 *
 * Файл во всех трёх случаях собирает ПАНЕЛЬ из структуры, а не модель. Иначе
 * пришлось бы открывать в предпросмотре чужую разметку со ссылками на CDN (и
 * молча пустую без сети), а PPTX не получился бы вовсе.
 */

/** Сколько панель ждёт колоду. Это обычный ответ модели, не рисование. */
const DECK_TIMEOUT_MS = 120_000;

/** Потолок чтения ответа: колода — это килобайты текста, не мегабайты. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Что панель знает о месте, из которого просят презентацию. */
export interface DeckPlanContext {
  /** Есть ли агент, которого можно попросить. Факт от клиента, решение — здесь. */
  agent?: boolean;
}

function blocked(
  deps: MediaDeps,
  reason: MediaDeckBlocker,
  title: string,
  model = '',
): MediaDeckPlan {
  return {
    available: false,
    title,
    model,
    reason,
    pdf: pdfState(deps),
    compromise: 'media-by-capability',
  };
}

/**
 * Получится ли PDF. Это факт файловой системы (нашёлся ли браузер), а не
 * догадка: не нашёлся — причина названа, HTML и PPTX остаются на месте.
 */
function pdfState(deps: MediaDeps): MediaDeckPlan['pdf'] {
  return canPrintPdf(deps.env) ? { available: true } : { available: false, reason: 'no-browser' };
}

/** Кто соберёт колоду и получится ли PDF. Решение принимает сервер — один раз. */
export function planDeck(deps: MediaDeps, context: DeckPlanContext = {}): MediaDeckPlan {
  // compromise: media-by-capability — режим доступен там, где есть кому диктовать: агент разговора, контур или свой эндпоинт; недоступность называется словами
  if (context.agent) {
    return {
      available: true,
      source: 'agent',
      title: '',
      // Модель разговора известна клиенту, а не панели: диктовать будет тот
      // агент, которому человек и так пишет. Подпись карточки получит её при
      // приёме блока.
      model: '',
      pdf: pdfState(deps),
      compromise: 'media-by-capability',
    };
  }

  const contour = activeContour(deps.store);
  const viaContour = contour ? contourPlan(deps, contour) : undefined;
  if (viaContour?.available) return viaContour;

  const viaEndpoint = endpointPlan(deps);
  if (viaEndpoint.available) return viaEndpoint;

  // Причина — та, которую человек может снять: свой тумблер шлюза ближе, чем
  // чужая настройка контура; профиль эндпоинта — его собственное поле.
  if (viaContour?.reason === 'gateway-off') return viaContour;
  if (ownProfiles(deps.store).length > 0) return viaEndpoint;
  return viaContour ?? viaEndpoint;
}

function contourPlan(deps: MediaDeps, contour: Platform): MediaDeckPlan {
  const model = contourModel(deps, contour);
  if (!model) return blocked(deps, 'no-model', contour.title);
  if (!gatewayUrl(deps, contour, 'v1/chat/completions')) {
    return blocked(deps, 'gateway-off', contour.title, model);
  }
  return {
    available: true,
    source: 'contour',
    title: contour.title,
    model,
    pdf: pdfState(deps),
    compromise: 'media-by-capability',
  };
}

/**
 * Модель для запроса колоды — модель контура по умолчанию (`defaultModelOf`),
 * тем же правилом, что у прогонов. Своя копия выбора брала первую строку
 * каталога как есть и уводила колоду в эмбеддинг или в модель рисования (аудит
 * MD-05). Флага возможности здесь нет и быть не может — диктовать текст умеет
 * любая модель, и требовать объявления значило бы запереть режим на пустом месте.
 */
function contourModel(deps: MediaDeps, contour: Platform): string {
  return defaultModelOf(deps.store, contour).model;
}

function endpointPlan(deps: MediaDeps): MediaDeckPlan {
  const profiles = ownProfiles(deps.store);
  if (profiles.length === 0) return blocked(deps, 'no-route', '');

  const compatible = profiles.filter((profile) => profile.apiKind === 'openai-compat');
  if (compatible.length === 0) return blocked(deps, 'endpoint-api-kind', profiles[0]?.name ?? '');

  const ready = compatible[0]!;
  return {
    available: true,
    source: 'endpoint',
    title: ready.name,
    model: ready.model,
    pdf: pdfState(deps),
    compromise: 'media-by-capability',
  };
}

/** Отказ словами для тех, у кого нет нашего экрана (телефон, `curl`). */
const REFUSAL: Record<MediaDeckBlocker, string> = {
  'no-route': 'Собирать некому: ни разговора с агентом, ни контура, ни своего эндпоинта.',
  'no-model': 'У контура не выбрана модель, и каталог ключа пуст.',
  'gateway-off': 'Шлюз панели не поднят: запрос в контур идёт через него.',
  'endpoint-api-kind': 'Разговор с моделью идёт только через эндпоинт OpenAI-вида.',
};

/** Просьба к агенту: правила из каталога промптов + тема. Собирает клиент. */
export function deckPromptRules(appDataDir: string): string {
  return promptText(appDataDir, 'presentation');
}

/**
 * Собрать презентацию своим запросом (дороги `contour` и `endpoint`).
 *
 * Дорога агента сюда не приходит — там панель принимает готовый блок
 * (`deckFromBlock`): просить модель через свой шлюз, когда рядом сидит агент
 * разговора, значило бы платить ключом за то, что уже оплачено подпиской.
 */
export async function generateDeck(
  deps: MediaDeps,
  request: { chatId: string; prompt: string; reviseOf?: string },
): Promise<MediaDeck> {
  const plan = planDeck(deps);
  if (!plan.available || !plan.source || plan.source === 'agent') {
    const reason = plan.reason ?? 'no-route';
    throw new MediaError(409, REFUSAL[reason], reason);
  }

  const prompt = request.prompt.trim();
  const previous = previousDeck(deps, request.reviseOf);
  const dictated = await dictate(deps, plan.source, plan.model, prompt, previous?.deck);
  return await assemble(deps, {
    chatId: request.chatId,
    prompt,
    model: plan.model,
    source: plan.source,
    deck: dictated.deck,
    truncated: dictated.truncated,
    ...(previous ? { previous } : {}),
  });
}

/**
 * Прежняя колода для правки.
 *
 * Пропала — отказ, а не тихая сборка заново: человек просил «поправь третий
 * слайд», и новая колода по той же теме, но с другим текстом везде, выглядела бы
 * как испорченная правка. Потолок хранилища (`DECK_KEEP_FILES`) — единственная
 * причина, по которой запись может исчезнуть, и об этом стоит сказать словами.
 */
function previousDeck(deps: MediaDeps, id: string | undefined): StoredDeck | undefined {
  const wanted = (id ?? '').trim();
  if (!wanted) return undefined;
  const record = readDeckRecord(deps.appDataDir, wanted);
  if (!record) {
    throw new MediaError(404, 'Той презентации, которую просят поправить, у панели уже нет.');
  }
  return record;
}

/**
 * Готовая просьба поправить колоду — для дороги агента: панель сама наверх не
 * идёт, а структуру прежней колоды агенту всё равно кто-то должен дать.
 */
export function deckRevisePrompt(deps: MediaDeps, id: string, instruction: string): string {
  const previous = previousDeck(deps, id);
  if (!previous) throw new MediaError(400, 'Не сказано, какую презентацию править.');
  return deckReviseRequest(deckPromptRules(deps.appDataDir), previous.deck, instruction);
}

/**
 * Принять колоду, которую надиктовал агент разговора (дорога `agent`).
 *
 * Разбор тот же, которым лента решала, прятать ли блок: два понимания формата
 * разошлись бы, и человек видел бы карточку там, где панель ничего не приняла.
 */
export async function deckFromBlock(
  deps: MediaDeps,
  request: {
    chatId: string;
    prompt: string;
    block: string;
    model: string;
    reviseOf?: string;
  },
): Promise<MediaDeck> {
  const parsed = parseDeckBlock(request.block);
  if (!parsed.deck) {
    throw new MediaError(400, 'В блоке не колода: нет заголовка или ни одного слайда.');
  }
  const previous = previousDeck(deps, request.reviseOf);
  return await assemble(deps, {
    chatId: request.chatId,
    prompt: request.prompt.trim(),
    model: request.model.trim(),
    source: 'agent',
    deck: parsed.deck,
    truncated: parsed.truncated,
    ...(previous ? { previous } : {}),
  });
}

/** Собрать файлы и записать колоду. Одна дорога на все три источника. */
async function assemble(
  deps: MediaDeps,
  input: {
    chatId: string;
    prompt: string;
    model: string;
    source: MediaDeckSource;
    deck: Deck;
    truncated?: boolean;
    /** Колода, которую эта правит. Её картинки переходят в новую. */
    previous?: StoredDeck;
  },
): Promise<MediaDeck> {
  const kept = keepPictures(deps, input.deck, input.previous?.deck);
  const illustrated = await drawIllustrations(deps, kept);
  const deck = illustrated.deck;

  // Картинки уезжают в файлы БАЙТАМИ, а не ссылкой: страница колоды отдаётся с
  // запретом сети, а PPTX вообще открывают на другой машине.
  const assets = deckAssets(deps.appDataDir, deck);
  const html = Buffer.from(renderDeckHtml(deck, assets), 'utf8');
  const pptx = await renderDeckPptx(deck, assets);

  const id = randomBytes(10).toString('hex');
  const formats: MediaDeckFormat[] = ['html', 'pptx'];
  // PDF обещаем только там, где есть чем печатать: кнопка, которая ответит
  // отказом, — то же самое, что спрятанная причина.
  if (canPrintPdf(deps.env)) formats.push('pdf');

  const record: MediaDeck = {
    id,
    chatId: input.chatId,
    title: deck.title,
    slideCount: deck.slides.length + 1,
    prompt: input.prompt,
    model: input.model,
    source: input.source,
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    formats,
    sizeBytes: html.length,
    ...(input.previous ? { revisionOf: input.previous.id } : {}),
    ...(illustrated.drawn > 0 ? { drawnPictures: illustrated.drawn } : {}),
    ...(illustrated.reason ? { pictureReason: illustrated.reason } : {}),
    ...(input.truncated ? { truncated: true } : {}),
  };
  return saveDeck(deps.appDataDir, record, deck, { html, pptx });
}

/**
 * Картинки, нарисованные для ПРОШЛОЙ колоды, переходят в правку — но только они.
 *
 * Идентификатор приходит в ответе модели (панель сама отправила его вниз вместе
 * со структурой), а значит, это чужой ввод: принимаем лишь те имена, которые
 * панель рисовала для ЭТОЙ колоды и файлы которых ещё на диске. Иначе в колоду
 * можно было бы вписать любой файл хранилища — и он уехал бы байтами в PPTX.
 */
function keepPictures(deps: MediaDeps, deck: Deck, previous?: Deck): Deck {
  const allowed = new Set(
    (previous?.slides ?? []).flatMap((slide) => (slide.pictureId ? [slide.pictureId] : [])),
  );
  let changed = false;
  const slides = deck.slides.map((slide) => {
    if (!slide.pictureId) return slide;
    if (allowed.has(slide.pictureId) && hasPicture(deps, slide.pictureId)) return slide;
    changed = true;
    const { pictureId: _dropped, ...rest } = slide;
    return rest;
  });
  return changed ? { ...deck, slides } : deck;
}

function hasPicture(deps: MediaDeps, id: string): boolean {
  try {
    return Boolean(readImageRecord(deps.appDataDir, id));
  } catch {
    return false;
  }
}

/** Что вышло из растровой дороги: колода с картинками, их число и причина отказа. */
interface Illustrated {
  deck: Deck;
  drawn: number;
  reason?: DeckPictureBlocker;
}

/**
 * Дорисовать слайдам растровые картинки СВОЕЙ дорогой.
 *
 * Владелец 13.09.2026 выбрал именно такую смесь: «вектор от модели + растр своей
 * дорогой». Схему модель рисует кодом (`figure`) — это бесплатно и работает
 * всюду; снимок рисует панель по описанию слайда (`illustration`) — и только там,
 * где растровая дорога есть.
 *
 * Потолок низкий (`DECK_MAX_RASTER`) и назван человеку: каждая картинка — запрос
 * наверх и минуты ожидания, а колода из сорока слайдов заказала бы сорок.
 * Первая неудача останавливает остальные: ключ, который отказал один раз,
 * откажет и на второй, а ждать ещё три минуты незачем.
 */
async function drawIllustrations(deps: MediaDeps, deck: Deck): Promise<Illustrated> {
  const budget = DECK_MAX_RASTER - deck.slides.filter((slide) => slide.pictureId).length;
  const wanted = deck.slides.filter((slide) => slide.illustration && !slide.pictureId);
  if (wanted.length === 0 || budget <= 0) return { deck, drawn: 0 };

  const plan = planImage(deps);
  if (!plan.available || !plan.source || plan.source === 'agent') {
    // Растровой дороги нет — это не отказ колоды: слайды остаются со схемами и
    // текстом, а причина едет в запись и оттуда на карточку.
    return { deck, drawn: 0, reason: plan.rasterReason ?? plan.reason ?? 'no-route' };
  }

  const slides = [...deck.slides];
  let drawn = 0;
  let reason: DeckPictureBlocker | undefined;
  for (const [index, slide] of slides.entries()) {
    if (drawn >= budget) break;
    if (!slide.illustration || slide.pictureId) continue;
    try {
      const image = await generateImage(deps, { chatId: '', prompt: slide.illustration });
      slides[index] = { ...slide, pictureId: image.id };
      drawn += 1;
    } catch (error) {
      reason = (isMediaError(error) ? error.reason : undefined) ?? 'draw-failed';
      break;
    }
  }
  return {
    deck: drawn > 0 ? { ...deck, slides } : deck,
    drawn,
    ...(reason ? { reason } : {}),
  };
}

/** Файл колоды. PDF печатается при первом спросе и остаётся рядом. */
export async function deckFile(
  deps: MediaDeps,
  id: string,
  format: MediaDeckFormat,
): Promise<{ record: StoredDeck; bytes: Buffer }> {
  const record = readDeckRecord(deps.appDataDir, id);
  if (!record) throw new MediaError(404, 'Такой презентации у панели нет.');

  if (format === 'pdf' && !hasDeckFile(deps.appDataDir, id, 'pdf')) {
    const assets = deckAssets(deps.appDataDir, record.deck);
    const bytes = await printDeckPdf(renderDeckHtml(record.deck, assets), deps.env);
    cacheDeckPdf(deps.appDataDir, id, bytes);
    return { record, bytes };
  }
  return { record, bytes: readDeckFile(deps.appDataDir, id, format) };
}

/**
 * Спросить модель и получить колоду. Ответ — JSON или наш блок вокруг него.
 *
 * Правила едут СИСТЕМНЫМ сообщением, а конверт (язык блока, запрет вопросов,
 * прежняя колода при правке) — пользовательским: конверт тот же, что у дороги
 * агента, и собирается он одной функцией на оба случая, поэтому «как просить»
 * не может разойтись между дорогами.
 */
async function dictate(
  deps: MediaDeps,
  source: 'contour' | 'endpoint',
  model: string,
  prompt: string,
  previous?: Deck,
): Promise<{ deck: Deck; truncated: boolean }> {
  const target = source === 'contour' ? contourTarget(deps, model) : endpointTarget(deps);
  const fetchImpl = target.fetchImpl ?? deps.fetchImpl ?? (globalThis.fetch as PlatformFetch);
  // Вопросов на этой дороге не задают: отвечать на них некому — запрос одиночный.
  const ask = previous
    ? deckReviseRequest('', previous, prompt)
    : deckBlockRequest('', prompt, false);

  const response = await askUpstream(
    fetchImpl,
    target.url,
    target.headers,
    {
      model,
      stream: false,
      messages: [
        { role: 'system', content: deckPromptRules(deps.appDataDir) },
        { role: 'user', content: ask },
      ],
    },
    DECK_TIMEOUT_MS,
    'Колоды',
  );

  const body = await readCapped(response, MAX_READ_BYTES);
  if (!response.ok) throw new MediaError(502, refusalOf(body, response.status));

  const text = answerText(body);
  const parsed = parseDeckAnswer(text);
  if (parsed.deck) return { deck: parsed.deck, truncated: parsed.truncated };

  // Модель ответила не структурой — обычное дело для слабой модели. Это не
  // поломка панели, и её слова в отказе: без них человек чинит настройки вместо
  // того, чтобы сменить модель. Слова — ответа, а не размышлений: начало
  // `<think>` в отказе ничего не объясняет.
  const said = stripReasoning(text) || text;
  throw new MediaError(
    502,
    said
      ? `Модель ответила не колодой: «${said.slice(0, EXCERPT)}»`
      : 'Модель не вернула ни колоды, ни текста',
  );
}

function contourTarget(
  deps: MediaDeps,
  model: string,
): { url: string; headers: Record<string, string>; fetchImpl?: PlatformFetch } {
  const contour = activeContour(deps.store);
  if (!contour) throw new MediaError(409, REFUSAL['no-route'], 'no-route');
  const url = gatewayUrl(deps, contour, 'v1/chat/completions');
  if (!url) throw new MediaError(409, REFUSAL['gateway-off'], 'gateway-off');
  if (!model) throw new MediaError(409, REFUSAL['no-model'], 'no-model');
  // К своему шлюзу — обычным `fetch`: он слушает 127.0.0.1, и сертификат
  // контура здесь ни при чём (его предъявляет уже шлюз, уезжая наверх).
  return { url, headers: {} };
}

function endpointTarget(deps: MediaDeps): {
  url: string;
  headers: Record<string, string>;
  fetchImpl?: PlatformFetch;
} {
  const profile = ownProfiles(deps.store).find((item) => item.apiKind === 'openai-compat');
  if (!profile) throw new MediaError(409, REFUSAL['endpoint-api-kind'], 'endpoint-api-kind');
  const token = readEndpointToken(deps.appDataDir, profile.id) ?? '';
  return {
    url:
      platformRequestUrl(profile.baseUrl, defaultPlatformTransport(), 'chat/completions') ??
      profile.baseUrl,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(deps.fetchImpl ? {} : { fetchImpl: createCaFetch('') }),
  };
}

/** Текст ответа `chat/completions` без потока. */
function answerText(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Не JSON — возможно, это сразу текст модели; пусть разбирается разбор блока.
    return body.trim();
  }
  const choices = (parsed as { choices?: unknown }).choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const content = isRecord(message) ? message.content : undefined;

  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}
