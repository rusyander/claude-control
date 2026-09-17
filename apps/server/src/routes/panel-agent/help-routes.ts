import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  loadHelpTopic,
  readHelpIndex,
  searchHelp,
  type HelpLanguage,
} from '../../domains/panel-agent/help-topics.ts';

/**
 * Справка для агента панели: поиск и чтение темы. Маршруты, а не вызов домена
 * из действия, — чтобы действия справки шли тем же путём, что и все остальные.
 */

/** Исходники веба рядом с сервером: справка живёт там и только там. */
export const DEFAULT_HELP_WEB_SRC = fileURLToPath(new URL('../../../../web/src/', import.meta.url));

const toInt = (value: string | undefined, fallback: number, max: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
};

export function registerPanelHelpRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  webSrc: string = DEFAULT_HELP_WEB_SRC,
): void {
  const languageOf = (value: string | undefined): HelpLanguage =>
    value === 'ru' || value === 'en' ? value : ctx.store.getSettings().language;

  app.get<{ Querystring: { q?: string; lang?: string; offset?: string; limit?: string } }>(
    '/api/agent/help/search',
    async (request, reply) => {
      const query = (request.query.q ?? '').trim();
      if (!query) return reply.code(400).send({ message: 'Пустой запрос к справке.' });
      const language = languageOf(request.query.lang);
      const found = await searchHelp(webSrc, language, query, {
        offset: toInt(request.query.offset, 0, 1000),
        limit: toInt(request.query.limit, 5, 20) || 5,
      });
      return { language, ...found };
    },
  );

  app.get<{ Querystring: { lang?: string } }>('/api/agent/help/topics', async (request) => {
    const language = languageOf(request.query.lang);
    const topics = [];
    for (const ref of readHelpIndex(webSrc)) {
      const topic = await loadHelpTopic(webSrc, language, ref.id);
      topics.push({
        id: ref.id,
        group: ref.group,
        pagePath: ref.pagePath,
        title: topic?.title ?? ref.id,
        summary: topic?.summary ?? '',
      });
    }
    return { language, topics };
  });

  app.get<{ Querystring: { id?: string; lang?: string; offset?: string; limit?: string } }>(
    '/api/agent/help/topic',
    async (request, reply) => {
      const id = request.query.id ?? '';
      const language = languageOf(request.query.lang);
      const topic = await loadHelpTopic(webSrc, language, id);
      if (!topic) {
        const known = readHelpIndex(webSrc).map((ref) => ref.id);
        return reply
          .code(404)
          .send({ message: `Темы справки «${id}» нет. Есть: ${known.join(', ')}.` });
      }
      // Окно по строкам документа: длинная тема читается частями.
      const offset = toInt(request.query.offset, 0, topic.lines.length);
      const limit = toInt(request.query.limit, 60, 200) || 60;
      return {
        language,
        id: topic.id,
        title: topic.title,
        summary: topic.summary,
        pagePath: topic.pagePath,
        totalLines: topic.lines.length,
        offset,
        lines: topic.lines.slice(offset, offset + limit),
        ...(offset + limit < topic.lines.length ? { nextOffset: offset + limit } : {}),
      };
    },
  );
}
