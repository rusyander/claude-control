import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAssistantRoutes } from './assistant-routes.ts';

/** Маршрут окна для проверок, которым он не важен: контура нет, шлюз не поднят. */
const NO_ROUTE = { runRoute: () => ({ env: {} }), gatewayPort: () => 0 };

/**
 * Ревью 28.09 (F-204): картинки без реплики человека молча выбрасывались, и
 * ответ был 200 — модель отвечала, не увидев того, что ей прислали.
 */

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('POST /api/assistant/run — картинки', () => {
  it('картинки без реплики человека → 400, а не молчаливая потеря', async () => {
    app = Fastify();
    // Отказ обязан прийти до провайдера и модели: контекст им не нужен.
    registerAssistantRoutes(app, {} as never, NO_ROUTE);
    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/run',
      payload: {
        messages: [{ role: 'assistant', content: 'привет' }],
        images: [{ name: 'shot.png', mediaType: 'image/png', base64: PNG }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_images' });
  });
});
