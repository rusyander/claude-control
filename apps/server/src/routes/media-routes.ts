import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  mediaImageRequestSchema,
  mediaPictureBlockRequestSchema,
} from '@agentdeck/contracts/media';
import {
  mediaDeckBlockRequestSchema,
  mediaDeckFormats,
  mediaDeckRequestSchema,
  type MediaDeckFormat,
} from '@agentdeck/contracts/media-deck';
import {
  deckBlockRequest,
  pictureBlockRequest,
  PICTURE_MAX_CHARS,
} from '@agentdeck/contracts/media-block';
import type { ServerContext } from '../context.ts';
import { generateImage, planImageReady, savePicture } from '../domains/media/images.ts';
import type { MediaDeps } from '../domains/media/images.ts';
import {
  deckFile,
  deckFromBlock,
  deckRevisePrompt,
  generateDeck,
  planDeck,
} from '../domains/media/presentations.ts';
import { DECK_MIME } from '../domains/media/deck/store.ts';
import { isMediaError } from '../domains/media/errors.ts';
import { promptText } from '../domains/prompts.ts';
import { assertId, readImageBytes, readImageRecord } from '../domains/media/store.ts';
import { codeOf } from '../lib/server-text.ts';
import { issueBody } from '../lib/zod-issue-codes.ts';
import { serverText } from '../lib/server-texts.ts';

/**
 * Потолок тела у приёма блоков агента. Рисунок меряется в ЗНАКАХ
 * (`PICTURE_MAX_CHARS`), а Fastify по умолчанию режет тело на 1 МиБ — и законный
 * рисунок с текстом не латиницей (кириллица — два байта на знак, иероглиф —
 * три) умирал до проверки английским `Request body is too large` вместо отказа
 * панели словами (ревью Т9, MINOR 7). Худший законный случай — каждый знак
 * экранирован в JSON как `\uXXXX`, шесть байт, плюс описание и запас.
 */
const BLOCK_BODY_LIMIT = PICTURE_MAX_CHARS * 6 + 256 * 1024;

/** Отказ по размеру тела — своими словами, а не фреймворка. */
const BODY_TOO_LARGE = serverText('media-block-too-large');

/**
 * Параметры маршрута приёма блока: поднятый потолок и перехват отказа по
 * размеру. Тело больше потолка — заведомо больше любого законного рисунка, но и
 * тогда человек (или телефон, `curl`) читает причину по-русски.
 */
const blockRoute = {
  bodyLimit: BLOCK_BODY_LIMIT,
  errorHandler: (
    error: { code?: string; statusCode?: number },
    _request: unknown,
    reply: FastifyReply,
  ) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send({ message: BODY_TOO_LARGE, messageCode: 'media-block-too-large' });
    }
    return reply.send(error);
  },
};

/**
 * Картинки и презентации из чата: чем сделаем, сделать, отдать файлом.
 *
 * Списка сделанного здесь нет намеренно: галерея прямо вне объёма, а адрес
 * «покажи всё, что панель нарисовала» — это уже она, только без экрана.
 *
 * Скачивание отдельным адресом, а не полем ответа: base64 в JSON раздувает ответ
 * на треть, ломает кэш браузера и не даёт телефону сохранить файл средствами
 * системы. Тот же адрес, что у браузера, работает и на телефоне — своего
 * маршрута для него не заведено.
 *
 * ДОРОГА АГЕНТА (картинка кодом, колода структурой) видна здесь двумя вещами:
 * `POST /api/media/prompt` отдаёт готовую просьбу, которую страница отправит в
 * разговор, а `…/block` принимает то, что агент ответил. Панель сама к модели на
 * этой дороге не ходит — и именно поэтому режим работает при любом провайдере и
 * без контура.
 */
export function registerMediaRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  gatewayPort: () => number,
  /**
   * Подъём своего шлюза, когда его тумблер включён, а слушателя нет (A-1).
   * Приходит извне, потому что слушатель живёт дольше запроса; не задан —
   * маршруты отвечают по тому, что есть, как отвечали раньше.
   */
  gateway?: { raise: () => Promise<void>; failure: () => string | undefined },
): void {
  const deps = (): MediaDeps => ({
    appDataDir: ctx.location.paths.appData,
    store: ctx.store,
    gatewayPort,
    ...(gateway ? { raiseGateway: gateway.raise, gatewayFailure: gateway.failure } : {}),
  });

  const failed = (error: unknown, reply: FastifyReply): FastifyReply => {
    if (isMediaError(error)) {
      return reply.code(error.status).send({
        message: error.message,
        ...codeOf(error),
        ...(error.reason ? { reason: error.reason } : {}),
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({
      message: `Не получилось: ${reason}`,
      messageCode: 'media-failed',
      params: { reason },
    });
  };

  /**
   * Есть ли в месте, откуда спрашивают, агент. Факт от клиента: страница знает
   * про свой разговор, а решение по дороге всё равно принимает сервер.
   */
  const wantsAgent = (value: unknown): boolean => value === '1' || value === 'true';

  /**
   * Чем нарисуем и почему нет. Единственный маршрут плана, который ещё и
   * ДЕЙСТВУЕТ: погашенный слушатель своего шлюза панель поднимает сама (A-1) —
   * замок «шлюз не поднят» там, где панель умеет его поднять одним вызовом, был
   * отказом собственной работе. Тумблер при этом не трогается ни разу.
   */
  app.get<{ Querystring: { agent?: string } }>('/api/media/images/plan', (request) =>
    planImageReady(deps(), { agent: wantsAgent(request.query.agent) }),
  );

  app.post<{ Body: unknown }>('/api/media/images', async (request, reply) => {
    const parsed = mediaImageRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          issueBody(
            parsed.error.issues,
            'Запрос на картинку не разобран.',
            'media-image-request-invalid',
          ),
        );
    }
    try {
      return await generateImage(deps(), parsed.data);
    } catch (error) {
      return failed(error, reply);
    }
  });

  /** Рисунок из блока агента: панель его проверяет и кладёт файлом. */
  app.post<{ Body: unknown }>('/api/media/images/block', blockRoute, (request, reply) => {
    const parsed = mediaPictureBlockRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          issueBody(
            parsed.error.issues,
            'Блок с рисунком не разобран.',
            'media-picture-block-invalid',
          ),
        );
    }
    try {
      return savePicture(deps(), parsed.data);
    } catch (error) {
      return failed(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/api/media/images/:id', (request, reply) => {
    try {
      const id = assertId(request.params.id);
      const record = readImageRecord(ctx.location.paths.appData, id);
      if (!record) {
        return reply
          .code(404)
          .send({ message: 'Такой картинки у панели нет.', messageCode: 'media-image-not-found' });
      }
      const bytes = readImageBytes(ctx.location.paths.appData, record);
      return (
        reply
          .type(record.mime)
          // Тип — из записи, а запись хранит только то, что панель УЗНАЛА в самих
          // байтах (`domains/media/decode.ts`). Плюс запрет угадывания в браузере:
          // файл пришёл из чужого ответа, и право решать, что он такое, панель
          // никому не передаёт.
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'no-store')
          // Вектор — это документ, и открывают его в браузере: запрещаем ему всё,
          // кроме собственной разметки. Разбор при приёме уже отверг бы скрипт,
          // но здесь запрет стоит на выдаче, где его не обойти вовсе.
          .header('Content-Security-Policy', IMAGE_CSP)
          // Показ и сохранение одним адресом: `inline` даёт карточке нарисовать
          // картинку, а имя файла — браузеру и телефону сохранить её осмысленно.
          .header('Content-Disposition', `inline; filename="${record.name}"`)
          .send(bytes)
      );
    } catch (error) {
      return failed(error, reply);
    }
  });

  app.get<{ Querystring: { agent?: string } }>('/api/media/decks/plan', (request) =>
    planDeck(deps(), { agent: wantsAgent(request.query.agent) }),
  );

  app.post<{ Body: unknown }>('/api/media/decks', async (request, reply) => {
    const parsed = mediaDeckRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          issueBody(
            parsed.error.issues,
            'Запрос на презентацию не разобран.',
            'media-deck-request-invalid',
          ),
        );
    }
    try {
      return await generateDeck(deps(), parsed.data);
    } catch (error) {
      return failed(error, reply);
    }
  });

  /** Колода из блока агента. */
  app.post<{ Body: unknown }>('/api/media/decks/block', blockRoute, async (request, reply) => {
    const parsed = mediaDeckBlockRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send(
          issueBody(
            parsed.error.issues,
            'Блок с колодой не разобран.',
            'media-deck-block-body-invalid',
          ),
        );
    }
    try {
      return await deckFromBlock(deps(), parsed.data);
    } catch (error) {
      return failed(error, reply);
    }
  });

  app.get<{ Params: { id: string; format: string } }>(
    '/api/media/decks/:id/:format',
    async (request, reply) => {
      const format = request.params.format as MediaDeckFormat;
      if (!mediaDeckFormats.includes(format)) {
        return reply.code(400).send({
          message: 'Такого вида файла у презентации нет.',
          messageCode: 'media-deck-format-unknown',
        });
      }
      try {
        const { record, bytes } = await deckFile(deps(), request.params.id, format);
        const name = fileName(record.title, record.id, format);
        return (
          reply
            .type(DECK_MIME[format])
            .header('X-Content-Type-Options', 'nosniff')
            .header('Cache-Control', 'no-store')
            // Страница колоды собрана панелью, но текст в ней — от модели, и сеть
            // ей не нужна ни для чего: `default-src 'none'` делает обещание «без
            // CDN» проверяемым не обещанием, а заголовком.
            .header('Content-Security-Policy', format === 'html' ? DECK_HTML_CSP : IMAGE_CSP)
            // HTML и PDF человек смотрит, PPTX открывает своей программой —
            // поэтому третий приходит вложением, а не в окно браузера.
            .header(
              'Content-Disposition',
              disposition(format === 'pptx' ? 'attachment' : 'inline', name, record.id, format),
            )
            .send(bytes)
        );
      } catch (error) {
        return failed(error, reply);
      }
    },
  );

  /**
   * Готовая просьба для дороги агента. Собирает её сервер, а не страница: текст
   * правил живёт в каталоге промптов (единственное место, где человек их
   * правит), и вторая сборка на клиенте разошлась бы с ним после первой правки.
   */
  app.post<{ Body: { kind?: unknown; topic?: unknown; reviseOf?: unknown } }>(
    '/api/media/prompt',
    (request, reply) => {
      const topic = typeof request.body?.topic === 'string' ? request.body.topic.trim() : '';
      if (!topic) {
        return reply
          .code(400)
          .send({ message: 'Опишите, что нужно.', messageCode: 'media-topic-empty' });
      }

      const appData = ctx.location.paths.appData;
      if (request.body?.kind === 'deck') {
        return { prompt: deckBlockRequest(promptText(appData, 'presentation'), topic) };
      }
      /**
       * Правка: внутрь просьбы уезжает СТРУКТУРА прежней колоды, поэтому её
       * собирает сервер — у страницы этой структуры нет вовсе (в записи о колоде
       * её не отдают: это килобайты, которые экрану не нужны).
       */
      if (request.body?.kind === 'deck-revise') {
        const id = typeof request.body?.reviseOf === 'string' ? request.body.reviseOf.trim() : '';
        if (!id) {
          return reply.code(400).send({
            message: 'Не сказано, какую презентацию править.',
            messageCode: 'media-deck-revise-unspecified',
          });
        }
        try {
          return { prompt: deckRevisePrompt(deps(), id, topic) };
        } catch (error) {
          return failed(error, reply);
        }
      }
      if (request.body?.kind === 'picture') {
        return { prompt: pictureBlockRequest(promptText(appData, 'image-svg'), topic) };
      }
      return reply
        .code(400)
        .send({ message: 'Неизвестный вид просьбы.', messageCode: 'media-prompt-kind-unknown' });
    },
  );
}

/** Запрет всего, кроме собственной разметки: и вектору, и PDF сеть не нужна. */
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** То же для страницы колоды: стили у неё свои, картинок снаружи нет вовсе. */
const DECK_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/**
 * Имя файла для скачивания: заголовок колоды, приведённый к безопасному виду.
 *
 * Заголовок пишет модель, а имя уезжает в заголовок ответа — кавычка или перевод
 * строки в нём сломали бы сам заголовок. Поэтому остаются только буквы, цифры,
 * пробел и дефис; пусто после чистки — имя из идентификатора.
 */
function fileName(title: string, id: string, format: MediaDeckFormat): string {
  const safe = title
    .replace(/[^\p{L}\p{N} _-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${safe || `deck-${id}`}.${format}`;
}

/**
 * Заголовок `Content-Disposition` с русским именем файла.
 *
 * Двумя частями, и это не перестраховка: значение заголовка обязано быть latin1,
 * а заголовки колод у нас русские — `filename="Итоги квартала.pptx"` Node
 * отвергает как недопустимый символ (`ERR_INVALID_CHAR`), то есть скачивание
 * ломалось бы на самом обычном случае. Поэтому `filename` несёт латиницу (для
 * старых клиентов), а `filename*` — настоящее имя в UTF-8 по RFC 5987, и его
 * берут все нынешние браузеры.
 *
 * Экранировать в `filename*` больше нечего: имя уже прошло `fileName`, где от
 * заголовка модели остались только буквы, цифры, пробел, `_` и `-`.
 */
function disposition(
  kind: 'inline' | 'attachment',
  name: string,
  id: string,
  format: MediaDeckFormat,
): string {
  const stripped = name
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // От русского заголовка после чистки остаётся одно расширение, и файл с именем
  // «.pptx» старый клиент сохранит как безымянный. Тогда латинское имя собирается
  // из идентификатора — оно хотя бы опознаваемо.
  const ascii = /[a-z0-9]/i.test(stripped.replace(/\.[a-z]+$/i, ''))
    ? stripped
    : `deck-${id}.${format}`;
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
