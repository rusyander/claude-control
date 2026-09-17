import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { canPrintPdf } from '../domains/media/deck/pdf.ts';
import { registerMediaRoutes } from './media-routes.ts';

/**
 * Картинки поверх НАСТОЯЩИХ маршрутов и настоящей сети.
 *
 * Подставлена ровно одна вещь — чужая сторона: вместо ручки картинок поднят свой
 * http-сервер на случайном порту. Всё остальное настоящее, потому что вопрос
 * ровно в этом: что панель отправила в сокет, что она приняла обратно, какими
 * заголовками отдаёт файл и что отвечает на чужой идентификатор. Транспорт здесь
 * не подменён ничем — `fetch` панели идёт по настоящему TCP.
 */
describe('маршруты картинок: своя сеть, свои заголовки', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let upstream: Server;
  let upstreamUrl: string;
  let asked: Array<{ url: string; body: string; auth?: string }>;
  /** Чем ответит поддельная ручка: тело и код задаёт каждый тест сам. */
  let answer: { status: number; body: string };

  const PNG = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    (() => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(13, 0);
      head.write('IHDR', 4, 'latin1');
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(8, 0);
      ihdr.writeUInt32BE(4, 4);
      return Buffer.concat([head, ihdr, Buffer.alloc(4)]);
    })(),
    Buffer.alloc(16),
  ]);

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-media-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    asked = [];
    answer = {
      status: 200,
      body: JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }),
    };

    upstream = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      request.on('end', () => {
        asked.push({
          url: request.url ?? '',
          body,
          ...(request.headers.authorization ? { auth: request.headers.authorization } : {}),
        });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    upstreamUrl = `http://127.0.0.1:${port}/v1/images/generations`;

    store.updateSettings({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Своя модель',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKind: 'openai-compat',
          model: 'sd-xl',
          writeToken: false,
          imagesUrl: upstreamUrl,
          ownerPlatformId: '',
        },
      ],
    });

    const ctx = {
      store,
      location: { paths: { root, appData: join(root, 'agentdeck') } },
    } as unknown as ServerContext;
    app = Fastify();
    // Порт шлюза 0 — он в этих проверках не участвует: дорога здесь ручка
    // профиля, и именно её адрес обязан уехать в сокет.
    registerMediaRoutes(app, ctx, () => 0);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('план называет дорогу до нажатия', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/media/images/plan' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      available: true,
      source: 'endpoint',
      title: 'Своя модель',
      model: 'sd-xl',
      promptSent: false,
      compromise: 'media-by-capability',
    });
  });

  it('запрос уходит на адрес из профиля и просит сами байты', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/images',
      payload: { chatId: 'chat-7', prompt: 'кот на подоконнике' },
    });

    expect(response.statusCode).toBe(200);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.url).toBe('/v1/images/generations');
    expect(JSON.parse(asked[0]?.body ?? '{}')).toMatchObject({
      model: 'sd-xl',
      prompt: 'кот на подоконнике',
      response_format: 'b64_json',
    });
    const image = response.json();
    expect(image).toMatchObject({
      chatId: 'chat-7',
      mime: 'image/png',
      source: 'endpoint',
      width: 8,
      height: 4,
      sizeBytes: PNG.length,
    });
    // Байтов в ответе нет: карточка забирает их отдельным запросом, как файл.
    expect(JSON.stringify(image)).not.toContain(PNG.toString('base64').slice(0, 16));
  });

  it('файл отдаётся тем же адресом — с запретом угадывания типа', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/media/images',
      payload: { prompt: 'кот' },
    });
    const { id, name } = created.json() as { id: string; name: string };

    const file = await app.inject({ method: 'GET', url: `/api/media/images/${id}` });

    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    // Файл пришёл из чужого ответа, и право решать, что он такое, панель браузеру
    // не передаёт. `inline` + имя — один адрес и для показа, и для сохранения.
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.headers['content-disposition']).toBe(`inline; filename="${name}"`);
    expect(Buffer.from(file.rawPayload)).toEqual(PNG);
  });

  it('чужой идентификатор не выводит чтение за каталог данных', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/media/images/..%2F..%2Fstate' });
    const missing = await app.inject({ method: 'GET', url: '/api/media/images/0123456789abcdef' });

    expect(bad.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toContain('Такой картинки у панели нет');
  });

  it('пустое описание отклоняется словами, а не молча', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/media/images',
      payload: { prompt: '  ' },
    });

    // Пробелы — это не описание, и отказ приходит ДО сети: иначе чужая сторона
    // отклоняет пустой запрос, а деньги ключа за него уже списаны.
    expect(asked).toHaveLength(0);
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('опишите картинку');
  });

  it('отказ чужой ручки доезжает её словами и кодом 502', async () => {
    answer = { status: 400, body: JSON.stringify({ error: { message: 'model is loading' } }) };

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/images',
      payload: { prompt: 'кот' },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().message).toContain('model is loading');
  });

  it('нет дороги — 409 с машинной причиной, и наружу не уходит ничего', async () => {
    store.updateSettings({ endpointProfiles: [] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/media/images',
      payload: { prompt: 'кот' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().reason).toBe('no-route');
    expect(asked).toHaveLength(0);
  });

  describe('дорога агента и презентации: панель наружу не ходит вовсе', () => {
    /** Тело блока с колодой — то же, что агент присылает в ответе. */
    const DECK = JSON.stringify({
      title: 'Итоги квартала',
      subtitle: 'Отдел продаж',
      slides: [{ title: 'Выручка', bullets: ['выросла вдвое'], notes: 'вслух' }],
    });

    const SVG = '<svg viewBox="0 0 4 4" xmlns="http://www.w3.org/2000/svg"><rect width="4"/></svg>';

    /** Колода из блока: возвращает то, что уехало клиенту. */
    async function makeDeck(block = DECK): Promise<{ id: string; formats: string[] }> {
      const created = await app.inject({
        method: 'POST',
        url: '/api/media/decks/block',
        payload: { chatId: 'chat-1', prompt: 'итоги', block, model: 'claude-opus-5' },
      });
      expect(created.statusCode).toBe(200);
      return created.json() as { id: string; formats: string[] };
    }

    it('признак разговора доезжает до плана — и режим доступен без всякой дороги', async () => {
      store.updateSettings({ endpointProfiles: [] });

      const locked = await app.inject({ method: 'GET', url: '/api/media/images/plan' });
      const withAgent = await app.inject({ method: 'GET', url: '/api/media/images/plan?agent=1' });

      // Ровно то, что просил владелец: без контура и без профиля картинки
      // работают, а причина отсутствия РАСТРА при этом названа.
      expect(locked.json()).toMatchObject({ available: false, reason: 'no-agent' });
      expect(withAgent.json()).toMatchObject({
        available: true,
        source: 'agent',
        rasterReason: 'no-route',
      });
    });

    it('рисунок агента ложится файлом и отдаётся вектором с запретами', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/media/images/block',
        payload: { chatId: 'c', prompt: 'схема', block: SVG, model: 'claude-opus-5' },
      });
      expect(created.statusCode).toBe(200);
      const { id, name } = created.json() as { id: string; name: string };

      const file = await app.inject({ method: 'GET', url: `/api/media/images/${id}` });

      expect(asked).toHaveLength(0);
      expect(file.headers['content-type']).toBe('image/svg+xml');
      // Вектор — исполняемый документ, и запрет стоит на ВЫДАЧЕ, где его не обойти.
      expect(String(file.headers['content-security-policy'])).toContain("default-src 'none'");
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-disposition']).toBe(`inline; filename="${name}"`);
      expect(file.rawPayload.toString('utf8')).toBe(SVG);
    });

    it('скрипт в блоке отклоняется словами, а файла не появляется', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/media/images/block',
        payload: { block: '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('скрипт');
    });

    it('потолок рисунка — в знаках: не-латинский рисунок под ним принимается, а не режется телом', async () => {
      // Ревью Т9, MINOR 7: 400 тысяч иероглифов — под потолком в знаках, но
      // 1,2 МБ тела, и Fastify по умолчанию отвечал 413 по-английски раньше
      // проверки панели.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${'漢'.repeat(400_000)}</text></svg>`;
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/media/images/block',
        payload: { chatId: 'c', prompt: 'иероглифы', block: svg, model: 'm' },
      });
      expect(accepted.statusCode).toBe(200);

      // Больше знакового потолка — отказ панели словами, а не фреймворка.
      const tooMany = await app.inject({
        method: 'POST',
        url: '/api/media/images/block',
        payload: {
          block: `<svg xmlns="http://www.w3.org/2000/svg"><text>${'ы'.repeat(600_000)}</text></svg>`,
        },
      });
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().message).toContain('полумиллиона знаков');

      // Тело больше любого законного рисунка — тоже по-русски.
      const huge = await app.inject({
        method: 'POST',
        url: '/api/media/images/block',
        payload: { block: 'ы'.repeat(2_000_000) },
      });
      expect(huge.statusCode).toBe(413);
      expect(huge.json().message).toBe('Блок слишком велик — панель такой не принимает.');
    });

    it('колода из блока собирается панелью: HTML без сети, PPTX вложением', async () => {
      const deck = await makeDeck();
      expect(asked).toHaveLength(0);
      expect(deck.formats).toContain('html');
      expect(deck.formats).toContain('pptx');

      const html = await app.inject({ method: 'GET', url: `/api/media/decks/${deck.id}/html` });
      const pptx = await app.inject({ method: 'GET', url: `/api/media/decks/${deck.id}/pptx` });

      expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
      // Обещание «никаких CDN» проверяется заголовком, а не словами в документации.
      expect(String(html.headers['content-security-policy'])).toContain("default-src 'none'");
      // Имя русское, а значение заголовка обязано быть latin1: настоящее имя
      // уезжает в `filename*` (RFC 5987), латинская подмена — в `filename`. Без
      // этого Node отвергает заголовок целиком (`ERR_INVALID_CHAR`), и самая
      // обычная русская колода не скачивается вовсе.
      expect(html.headers['content-disposition']).toBe(
        `inline; filename="deck-${deck.id}.html"; ` +
          `filename*=UTF-8''${encodeURIComponent('Итоги квартала.html')}`,
      );
      expect(html.rawPayload.toString('utf8')).toContain('Итоги квартала');

      // PPTX человек открывает своей программой, а не окном браузера.
      expect(pptx.headers['content-type']).toBe(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      expect(pptx.headers['content-disposition']).toBe(
        `attachment; filename="deck-${deck.id}.pptx"; ` +
          `filename*=UTF-8''${encodeURIComponent('Итоги квартала.pptx')}`,
      );
      expect(pptx.rawPayload.subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('заголовок от модели не ломает заголовок ответа', async () => {
      const deck = await makeDeck(
        JSON.stringify({
          // Кавычка и перевод строки в имени файла сломали бы сам заголовок.
          title: 'Итоги "2026"\r\nX-Sneak: 1',
          slides: [{ title: 'Раз', bullets: ['первое'] }],
        }),
      );

      const html = await app.inject({ method: 'GET', url: `/api/media/decks/${deck.id}/html` });

      const disposition = String(html.headers['content-disposition']);
      // Ни кавычки, ни перевода строки: иначе заголовок кончался бы раньше, а
      // хвост читался бы как ещё один заголовок ответа.
      expect(disposition).not.toMatch(/[\r\n]/);
      expect(disposition).not.toContain('X-Sneak: 1');
      // Кавычки выброшены чисткой, двоеточие стало пробелом — имя осталось именем.
      expect(disposition).toBe(
        `inline; filename="2026 X-Sneak 1.html"; ` +
          `filename*=UTF-8''${encodeURIComponent('Итоги 2026 X-Sneak 1.html')}`,
      );
      expect(html.headers['x-sneak']).toBeUndefined();
    });

    it('неизвестный вид файла и чужой идентификатор — 400 и 404', async () => {
      const deck = await makeDeck();

      const odd = await app.inject({ method: 'GET', url: `/api/media/decks/${deck.id}/docx` });
      const missing = await app.inject({
        method: 'GET',
        url: '/api/media/decks/0123456789abcdef/html',
      });

      expect(odd.statusCode).toBe(400);
      expect(missing.statusCode).toBe(404);
    });

    it('в блоке не колода — 400 с причиной', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/media/decks/block',
        payload: { block: '{"title":"без слайдов"}' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('ни одного слайда');
    });

    it('просьбу для агента собирает сервер — с правилами из каталога промптов', async () => {
      const deck = await app.inject({
        method: 'POST',
        url: '/api/media/prompt',
        payload: { kind: 'deck', topic: 'итоги квартала' },
      });
      const picture = await app.inject({
        method: 'POST',
        url: '/api/media/prompt',
        payload: { kind: 'picture', topic: 'схема потоков' },
      });

      // Текст правил живёт в каталоге промптов, а строка протокола — в контракте:
      // вторая сборка на клиенте разошлась бы с ними после первой правки.
      expect(deck.json().prompt).toContain('agentdeck:deck');
      expect(deck.json().prompt).toContain('итоги квартала');
      expect(picture.json().prompt).toContain('agentdeck:svg');
      expect(picture.json().prompt).toContain('схема потоков');
    });

    it('просьба без темы и с неизвестным видом отклоняется словами', async () => {
      const empty = await app.inject({
        method: 'POST',
        url: '/api/media/prompt',
        payload: { kind: 'deck', topic: '   ' },
      });
      const odd = await app.inject({
        method: 'POST',
        url: '/api/media/prompt',
        payload: { kind: 'song', topic: 'итоги' },
      });

      expect(empty.statusCode).toBe(400);
      expect(odd.statusCode).toBe(400);
    });

    it.skipIf(!canPrintPdf())(
      'PDF печатается по первому спросу и уходит с типом application/pdf',
      async () => {
        const deck = await makeDeck();

        const pdf = await app.inject({ method: 'GET', url: `/api/media/decks/${deck.id}/pdf` });

        expect(pdf.statusCode).toBe(200);
        expect(pdf.headers['content-type']).toBe('application/pdf');
        expect(pdf.headers['content-disposition']).toBe(
          `inline; filename="deck-${deck.id}.pdf"; ` +
            `filename*=UTF-8''${encodeURIComponent('Итоги квартала.pdf')}`,
        );
        expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      },
      120_000,
    );
  });
});
