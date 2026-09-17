import { randomBytes } from 'node:crypto';
import type { MediaImage, MediaImagePlan, MediaImageBlocker, Platform } from '@agentdeck/contracts';
import { MEDIA_SVG_MIME } from '@agentdeck/contracts/media';
import { checkPicture } from '@agentdeck/contracts/media-block';
import { createCaFetch, type PlatformFetch } from '../platform/ca-fetch.ts';
import { driverOf } from '../platform/drivers/index.ts';
import { readEndpointToken } from '../endpoints.ts';
import { promptText } from '../prompts.ts';
import { decodeBase64Image, decodeDataUrl } from './decode.ts';
import { MediaError } from './errors.ts';
import { extensionFor, saveImage } from './store.ts';
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

/**
 * Картинка по просьбе человека из чата.
 *
 * compromise: media-by-capability — режим доступен ровно там, где возможность объявлена, и недоступность называется словами
 *
 * Три дороги, и выбирает их СЕРВЕР, один раз, до нажатия (`planImage`):
 *   1. активный контур, который рисует моделью (`driver.images = 'chat-part'`) —
 *      обычный `chat/completions` ЧЕРЕЗ СВОЙ ШЛЮЗ, той же дорогой, которой идёт
 *      пробный запрос (`platform/activation.ts`). Через шлюз, а не напрямую,
 *      ради трёх вещей, которые иначе пришлось бы писать заново: след запроса,
 *      учёт расхода ключа и перевод отказов контура (451 проверок содержимого) в
 *      понятный ответ. Диалект спрашивается OpenAI-вида намеренно: в своём
 *      диалекте кадр уходит клиенту байт в байт вместе с картинкой, а мост в
 *      Anthropic её не переносит (`gateway/frames.ts → #contentText`);
 *   2. отдельная ручка картинок OpenAI-вида у контура (`images: { api }`) —
 *      адрес складывается из адреса контура и пути, ОБЪЯВЛЕННОГО манифестом, как
 *      и адрес списка моделей. Модель — только объявившая рисование в каталоге
 *      ключа; нет такой — поле не шлётся, и выбирает сама ручка. С 17.09.2026 и
 *      эта дорога идёт ЧЕРЕЗ СВОЙ ШЛЮЗ (`gateway/images.ts`): до того она шла
 *      напрямую ключом контура, и рисунок корпоративным ключом не оставлял ни
 *      следа, ни расхода, ни защиты данных (решение владельца). Ни один
 *      встроенный драйвер её не объявляет — включает её только путь ручки,
 *      вписанный в манифест;
 *   3. свой эндпоинт человека (решение В4) — адрес объявлен ПОЛЕМ профиля.
 *      Угадывать его из `baseUrl` нельзя: совместимый сервер вправе не иметь
 *      этой ручки вовсе, и угаданный адрес дал бы 404 вместо честного «адрес не
 *      задан». У контура по-другому только потому, что там форму ручки объявляет
 *      драйвер, а у профиля драйвера нет.
 *
 * ЧЕТВЁРТАЯ дорога живёт рядом и работает иначе: агент разговора рисует вектором
 * и отдаёт его блоком в ответе (`savePicture`). Панель там никуда не ходит, и
 * возможность провайдера ей не нужна вовсе — поэтому режим доступен при любом
 * CLI и без контура, а прежние шесть причин объясняют лишь отсутствие РАСТРА.
 *
 * Чего здесь нет: похода по адресу, который назвала модель. Ручка вправе
 * ответить ссылкой вместо байтов — такой ответ становится отказом с причиной
 * (`decode.ts`), потому что скачивание по чужому адресу нашими правами — это
 * запрос, которого человек не делал.
 */

/** Тип из общего транспорта — маршруты и тесты берут его отсюда с Т9. */
export type { MediaDeps } from './upstream.ts';

/** Сколько панель ждёт картинку. Рисование — минуты, а не секунды. */
const IMAGE_TIMEOUT_MS = 180_000;

/**
 * Потолок ЧТЕНИЯ ответа. Больше самой картинки, потому что base64 в потоке
 * длиннее байтов примерно на треть, а вокруг него ещё кадры.
 */
const MAX_READ_BYTES = 16 * 1024 * 1024;

function blocked(
  reason: MediaImageBlocker,
  title: string,
  model = '',
  promptSent = false,
): MediaImagePlan {
  return {
    available: false,
    title,
    model,
    promptSent,
    reason,
    compromise: 'media-by-capability',
  };
}

/** Что панель знает о месте, из которого просят картинку. */
export interface ImagePlanContext {
  /**
   * Есть ли в этом месте агент, которого можно попросить. Факт от клиента, а
   * РЕШЕНИЕ по-прежнему за сервером: страница знает, что у неё есть разговор,
   * но не знает, какая дорога дешевле и что объявил драйвер.
   */
  agent?: boolean;
}

/**
 * Чем панель нарисует и почему нет. Считается на сервере целиком: ответ
 * собирается из драйвера, каталога пробы и профилей эндпоинтов, и второй такой
 * расчёт на клиенте разошёлся бы с настоящим маршрутом — ровно та болезнь,
 * которую в Т6 вылечил один общий `chooseRunModel`.
 *
 * Порядок дорог: сначала РАСТР (контур с объявленным рисованием, затем свой
 * эндпоинт), и только потом агент. Не потому что агент хуже, а потому что
 * продукт другой: агент рисует вектором кодом, а просят обычно снимок. Зато
 * агент есть всюду, и именно он снял прежнюю неправду «рисовать некому» —
 * рисовать было чем и без контура (дописано владельцем 13.09.2026).
 */
export function planImage(deps: MediaDeps, context: ImagePlanContext = {}): MediaImagePlan {
  const contour = activeContour(deps.store);
  const viaContour = contour ? contourPlan(deps, contour) : undefined;
  if (viaContour?.available) return viaContour;

  // Активный контур, который не рисует, не запирает дорогу профиля: он выбран для
  // прогонов агента, а не для картинок, и «нельзя» из-за него было бы неправдой —
  // рисовать-то есть чем.
  const viaEndpoint = endpointPlan(deps);
  if (viaEndpoint.available) return viaEndpoint;

  // Растровой дороги нет. Причина, которую человек может снять, называется
  // ВСЁ РАВНО — но рядом с рабочей дорогой агента, а не вместо неё: «у этого
  // контура нет генерации картинок» правда, «панель не умеет» — нет.
  const rasterReason = rasterBlocker(deps, viaContour, viaEndpoint);
  if (context.agent) {
    return {
      available: true,
      source: 'agent',
      title: '',
      // Модель разговора панели здесь неизвестна и не нужна: рисовать будет тот
      // агент, которому человек и так пишет, на своей модели. Подпись карточки
      // получит её от клиента при приёме блока.
      model: '',
      promptSent: true,
      ...(rasterReason ? { rasterReason } : {}),
      compromise: 'media-by-capability',
    };
  }

  // Агента нет — вот теперь режим действительно заперт, и причина этому ОДНА:
  // просить некого. Растровая причина уезжает рядом, потому что чинится именно
  // она; подменять ею «нет разговора» значило бы послать человека настраивать
  // контур там, где хватило бы открыть чат.
  const locked = blockedPlan(deps, viaContour, viaEndpoint);
  return {
    ...locked,
    reason: 'no-agent',
    ...(locked.reason ? { rasterReason: locked.reason } : {}),
  };
}

/** Причина отсутствия РАСТРА — та же, что назвал бы запертый режим. */
function rasterBlocker(
  deps: MediaDeps,
  viaContour: MediaImagePlan | undefined,
  viaEndpoint: MediaImagePlan,
): MediaImageBlocker | undefined {
  return blockedPlan(deps, viaContour, viaEndpoint).reason;
}

/**
 * Запертый режим: называем ту причину, которую человек может снять. Шлюз
 * выключен — это его тумблер, и он ближе всего к делу; иначе про контур сказать
 * нечего (каталог ключа и драйвер не его), а вот адрес в профиле — его поле.
 */
function blockedPlan(
  deps: MediaDeps,
  viaContour: MediaImagePlan | undefined,
  viaEndpoint: MediaImagePlan,
): MediaImagePlan {
  if (viaContour?.reason === 'gateway-off') return viaContour;
  if (ownProfiles(deps.store).length > 0) return viaEndpoint;
  return viaContour ?? viaEndpoint;
}

function contourPlan(deps: MediaDeps, contour: Platform): MediaImagePlan {
  const driver = driverOf(contour);
  const catalog = deps.store.getPlatformHealth()[contour.id]?.models ?? [];
  const drawing = catalog.find((model) => model.imageGeneration === true);

  // compromise: media-by-capability — режим доступен там, где возможность ОБЪЯВЛЕНА: манифест драйвера плюс флаг каталога ключа, недоступность называется словами
  if (driver.images === 'none') return blocked('driver-none', contour.title);

  if (driver.images === 'chat-part') {
    // Флаг рисования читается из каталога ключа и только оттуда: имя модели
    // объявлением не является (`drivers/driver.ts → FLAG_FIELDS`).
    if (!drawing) return blocked('no-model', contour.title);
    const port = deps.gatewayPort?.() ?? 0;
    if (port <= 0) return blocked('gateway-off', contour.title, drawing.id, true);
    return {
      available: true,
      source: 'contour-chat',
      title: contour.title,
      model: drawing.id,
      promptSent: true,
      compromise: 'media-by-capability',
    };
  }

  // Ручка контура — тоже через свой шлюз: погашенный шлюз запирает её той же
  // причиной, что и дорогу «частью ответа».
  const imagesPort = deps.gatewayPort?.() ?? 0;
  if (imagesPort <= 0) return blocked('gateway-off', contour.title, drawing?.id ?? '', false);

  return {
    available: true,
    source: 'contour-images',
    title: contour.title,
    // Не модель контура по умолчанию: это модель ЧАТА, и ручка картинок её
    // отвергает. Без объявленной рисующей поле уходит пустым, и модель по
    // умолчанию выбирает сама ручка.
    model: drawing?.id ?? '',
    // У ручки картинок системного сообщения нет вовсе, и промпт режима туда не
    // уезжает. Сказать это человеку обязательно: иначе его правка промпта
    // выглядит как не сработавшая настройка.
    promptSent: false,
    compromise: 'media-by-capability',
  };
}

function endpointPlan(deps: MediaDeps): MediaImagePlan {
  const profiles = ownProfiles(deps.store);
  if (profiles.length === 0) return blocked('no-route', '');

  const compatible = profiles.filter((profile) => profile.apiKind === 'openai-compat');
  if (compatible.length === 0) return blocked('endpoint-api-kind', profiles[0]?.name ?? '');

  const ready = compatible.find((profile) => profile.imagesUrl.trim());
  if (!ready) {
    const first = compatible[0];
    return blocked('endpoint-no-url', first?.name ?? '', first?.model ?? '');
  }

  return {
    available: true,
    source: 'endpoint',
    title: ready.name,
    model: ready.model,
    promptSent: false,
    compromise: 'media-by-capability',
  };
}

/** Отказ словами для тех, у кого нет нашего экрана (телефон, `curl`). */
const REFUSAL: Record<MediaImageBlocker, string> = {
  'no-route': 'Рисовать некому: ни активного контура, ни своего эндпоинта.',
  'driver-none': 'У этого контура генерации картинок нет.',
  'no-model': 'Ни одна модель ключа не объявила рисование.',
  'endpoint-no-url': 'У профиля эндпоинта не задан адрес генерации картинок.',
  'endpoint-api-kind': 'Картинки умеет только эндпоинт OpenAI-вида.',
  'gateway-off': 'Шлюз панели не поднят: запрос в контур идёт через него.',
  'no-agent': 'Рисовать некому: нет ни растровой дороги, ни разговора с агентом.',
};

/** Отказ рисунка из блока — своими словами, потому что причина другая. */
const PICTURE_REFUSAL: Record<string, string> = {
  'not-svg': 'В блоке не рисунок SVG.',
  'too-big': 'Рисунок больше полумиллиона знаков — панель такой не открывает.',
  'active-content': 'В рисунке есть скрипт или обработчик события — панель такой не сохраняет.',
  'remote-ref': 'Рисунок ссылается наружу; он обязан быть самодостаточным.',
};

/**
 * Рисунок, который надиктовал агент разговора (дорога `agent`).
 *
 * Панель никуда не ходит: она принимает то, что агент уже сказал блоком, и
 * относится к нему как к чужому файлу — проверяет тем же разбором, которым лента
 * решала, прятать ли блок (`media-block.ts → checkPicture`), и только потом
 * кладёт на диск. Разбор ОДИН на оба места намеренно: два понимания «что такое
 * годный SVG» разошлись бы, и в ленте блок исчезал бы, а на диск не попадал.
 */
export function savePicture(
  deps: MediaDeps,
  request: { chatId: string; prompt: string; block: string; model: string },
): MediaImage {
  const checked = checkPicture(request.block);
  if (!checked.svg) {
    const problem = checked.problem ?? 'not-svg';
    throw new MediaError(400, PICTURE_REFUSAL[problem] ?? PICTURE_REFUSAL['not-svg']!);
  }

  const bytes = Buffer.from(checked.svg, 'utf8');
  const id = randomBytes(10).toString('hex');
  const image: MediaImage = {
    id,
    chatId: request.chatId,
    name: `picture-${id}.svg`,
    mime: MEDIA_SVG_MIME,
    sizeBytes: bytes.length,
    prompt: request.prompt.trim(),
    model: request.model.trim(),
    source: 'agent',
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
  };
  return saveImage(deps.appDataDir, image, bytes);
}

/**
 * Очередь рисования на каталог данных панели: один запрос наверх за раз.
 *
 * Справка обещает «второй запрос ждёт первого», а держала это обещание только
 * погашенная кнопка ОДНОЙ страницы: две вкладки, телефон или `curl` рядом с
 * панелью заказывали два рисунка разом — два списания с ключа (ревью Т9,
 * MINOR 8). Ключ — каталог данных, а не процесс: в тестах панелей несколько, и
 * общая очередь сцепила бы чужие прогоны.
 */
const drawQueues = new Map<string, Promise<unknown>>();

/**
 * Нарисовать и сохранить. Возвращает запись; байты уходят на диск и в ответ
 * не попадают — карточка забирает их отдельным запросом, как файл.
 */
export function generateImage(
  deps: MediaDeps,
  request: { chatId: string; prompt: string },
): Promise<MediaImage> {
  const key = deps.appDataDir;
  const before = drawQueues.get(key) ?? Promise.resolve();
  // Отказ предыдущего — не причина отказать следующему: ждём его конца, каким
  // бы он ни был. План спрашивается уже В СВОЮ очередь — за минуты ожидания
  // контур могли выключить.
  const turn = before.then(
    () => drawNow(deps, request),
    () => drawNow(deps, request),
  );
  const settled = turn.catch(() => undefined);
  drawQueues.set(key, settled);
  // Хвост очереди убирается за собой: иначе карта держала бы по записи на
  // каждый каталог, где хоть раз рисовали.
  void settled.then(() => {
    if (drawQueues.get(key) === settled) drawQueues.delete(key);
  });
  return turn;
}

async function drawNow(
  deps: MediaDeps,
  request: { chatId: string; prompt: string },
): Promise<MediaImage> {
  const plan = planImage(deps);
  if (!plan.available || !plan.source) {
    // Здесь спрашивают РАСТР (у этого адреса другого товара нет), поэтому и
    // причина называется растровая: «нет разговора» тому, кто пришёл телефоном
    // или `curl`, не говорит ничего, а «у профиля не задан адрес генерации» он
    // чинит сам.
    const reason = plan.rasterReason ?? plan.reason ?? 'no-route';
    throw new MediaError(409, REFUSAL[reason], reason);
  }

  // Дорога агента сюда не приходит: там панель не рисует, а ПРИНИМАЕТ блок
  // (`savePicture`). Проверка не декоративная — плана с `agent` здесь быть не
  // может по построению (`planImage` без контекста его не выбирает), и если он
  // однажды появится, отказ назовёт причину вместо запроса в пустоту.
  if (plan.source === 'agent') {
    throw new MediaError(409, 'Рисунок агента панель не заказывает — он приходит блоком в ответе.');
  }

  const prompt = request.prompt.trim();
  const drawn =
    plan.source === 'contour-chat'
      ? await viaGateway(deps, plan.model, prompt)
      : await viaImagesApi(deps, plan.source, plan.model, prompt);

  const id = randomBytes(10).toString('hex');
  const at = (deps.now?.() ?? new Date()).toISOString();
  const image: MediaImage = {
    id,
    chatId: request.chatId,
    name: `image-${id}.${extensionFor(drawn.mime)}`,
    mime: drawn.mime,
    sizeBytes: drawn.bytes.length,
    ...(drawn.width ? { width: drawn.width } : {}),
    ...(drawn.height ? { height: drawn.height } : {}),
    prompt,
    model: plan.model,
    source: plan.source,
    createdAt: at,
  };
  return saveImage(deps.appDataDir, image, drawn.bytes);
}

/** Запрос к чужой стороне с потолком ожидания — общий транспорт режимов. */
function ask(
  fetchImpl: PlatformFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return askUpstream(fetchImpl, url, headers, body, IMAGE_TIMEOUT_MS, 'Картинки');
}

/**
 * Контур, который рисует моделью: обычный `chat/completions` через свой шлюз,
 * потоком и в диалекте OpenAI (см. шапку файла — в мосте Anthropic картинки нет).
 */
async function viaGateway(
  deps: MediaDeps,
  model: string,
  prompt: string,
): Promise<ReturnType<typeof decodeDataUrl>> {
  const contour = activeContour(deps.store);
  const port = deps.gatewayPort?.() ?? 0;
  if (!contour || port <= 0) throw new MediaError(409, REFUSAL['gateway-off'], 'gateway-off');

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as PlatformFetch);
  const response = await ask(
    fetchImpl,
    `http://127.0.0.1:${port}/${contour.id}/v1/chat/completions`,
    {},
    {
      model,
      stream: true,
      messages: [
        { role: 'system', content: promptText(deps.appDataDir, 'image') },
        { role: 'user', content: prompt },
      ],
    },
  );

  const body = await readCapped(response, MAX_READ_BYTES);
  if (!response.ok) throw new MediaError(502, refusalOf(body, response.status));

  const found = findImagePart(body);
  if (found.url) return decodeDataUrl(found.url);

  // Модель ответила словами — обычное дело для чат-модели, которую попросили
  // рисовать. Это не поломка панели, и текст её ответа в отказе: без него
  // человек чинит настройки вместо того, чтобы сменить модель.
  throw new MediaError(
    502,
    found.text
      ? `Модель ответила текстом, а не картинкой: «${found.text.slice(0, EXCERPT)}»`
      : 'Модель не вернула ни картинки, ни текста',
  );
}

/** Ручка картинок OpenAI-вида: у контура или у профиля человека. */
async function viaImagesApi(
  deps: MediaDeps,
  source: 'contour-images' | 'endpoint',
  model: string,
  prompt: string,
): Promise<ReturnType<typeof decodeBase64Image>> {
  const target =
    source === 'contour-images' ? contourImagesTarget(deps) : endpointImagesTarget(deps);

  // До своего шлюза корневой сертификат компании отношения не имеет: его знает
  // шлюз, который и ходит в контур.
  const fetchImpl =
    deps.fetchImpl ??
    (source === 'contour-images'
      ? (globalThis.fetch as PlatformFetch)
      : createCaFetch(target.caCertPath));
  const response = await ask(fetchImpl, target.url, target.headers, {
    ...(model ? { model } : {}),
    prompt,
    n: 1,
    // Просим САМИ БАЙТЫ. Ссылку панель не скачивает (`decode.ts`), и без этого
    // поля половина серверов отвечает именно ссылкой.
    response_format: 'b64_json',
  });

  const body = await readCapped(response, MAX_READ_BYTES);
  if (!response.ok) throw new MediaError(502, refusalOf(body, response.status));

  const first = firstImageRow(body);
  if (typeof first?.b64_json === 'string') return decodeBase64Image(first.b64_json);
  if (typeof first?.url === 'string') return decodeDataUrl(first.url);
  throw new MediaError(502, 'В ответе ручки картинок нет ни байтов, ни адреса');
}

function contourImagesTarget(deps: MediaDeps): {
  url: string;
  headers: Record<string, string>;
  caCertPath: string;
} {
  const contour = activeContour(deps.store);
  if (!contour) throw new MediaError(409, REFUSAL['no-route'], 'no-route');
  const { images } = driverOf(contour);
  if (typeof images !== 'object') throw new MediaError(409, REFUSAL['driver-none'], 'driver-none');
  // Ключа здесь нет и не будет: адрес — свой шлюз, ключ контура подставляет он
  // (`gateway/images.ts`), и там же след, расход, защита данных и перевод отказов.
  const url = gatewayUrl(deps, contour, 'v1/images/generations');
  if (!url) throw new MediaError(409, REFUSAL['gateway-off'], 'gateway-off');
  return { url, headers: {}, caCertPath: '' };
}

function endpointImagesTarget(deps: MediaDeps): {
  url: string;
  headers: Record<string, string>;
  caCertPath: string;
} {
  const profile = ownProfiles(deps.store).find(
    (item) => item.apiKind === 'openai-compat' && item.imagesUrl.trim(),
  );
  if (!profile) throw new MediaError(409, REFUSAL['endpoint-no-url'], 'endpoint-no-url');
  const token = readEndpointToken(deps.appDataDir, profile.id) ?? '';
  return {
    url: profile.imagesUrl.trim(),
    headers: token ? { authorization: `Bearer ${token}` } : {},
    caCertPath: '',
  };
}

/** Первая строка `data` из ответа ручки картинок. */
function firstImageRow(body: string): { b64_json?: unknown; url?: unknown } | undefined {
  try {
    const parsed = JSON.parse(body) as { data?: unknown };
    const rows = Array.isArray(parsed.data) ? parsed.data : [];
    const first = rows[0];
    return first && typeof first === 'object'
      ? (first as { b64_json?: unknown; url?: unknown })
      : undefined;
  } catch {
    throw new MediaError(502, 'Ответ ручки картинок — не JSON');
  }
}

/**
 * Картинка и текст из потока `chat/completions`.
 *
 * Читаются кадры целиком, а не «первая подходящая строка»: картинка приезжает
 * частью содержимого одного кадра, а текст — по кускам, и отказ обязан нести
 * именно то, что модель сказала.
 */
function findImagePart(body: string): { url?: string; text: string } {
  let text = '';
  let url: string | undefined;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let frame: unknown;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue;
    }
    const choices = (frame as { choices?: unknown }).choices;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = first && typeof first === 'object' ? (first as Record<string, unknown>) : {};
    const content =
      (isRecord(message.delta) ? message.delta.content : undefined) ??
      (isRecord(message.message) ? message.message.content : undefined);

    if (typeof content === 'string') {
      text += content;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === 'string') text += part.text;
      const image = isRecord(part.image_url) ? part.image_url.url : undefined;
      if (!url && typeof image === 'string') url = image;
    }
  }

  return { ...(url ? { url } : {}), text: text.trim() };
}
