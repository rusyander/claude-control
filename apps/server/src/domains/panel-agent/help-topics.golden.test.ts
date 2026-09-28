import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { registerPanelHelpRoutes } from '../../routes/panel-agent/help-routes.ts';

/**
 * Эталон поиска по справке: простой вопрос человека → нужная тема ПЕРВОЙ.
 *
 * Идёт настоящим маршрутом `GET /api/agent/help/search` (им пользуется действие
 * `search_help`) над настоящими текстами справки веба — теми, что человек
 * читает в панели. Прежний счёт «найденных слов в квадрате» без поправки на длину
 * отдавал первые места самым длинным темам (чат, тесты, контур), а служебные
 * слова («что», «такое», «для») считались наравне со смысловыми: «что такое хуки»
 * не находило хуки и в первой тройке.
 */
const GOLDEN: ReadonlyArray<{ lang: 'ru' | 'en'; query: string; topic: string }> = [
  { lang: 'ru', query: 'что такое хуки', topic: 'hooks' },
  { lang: 'ru', query: 'что такое MCP', topic: 'mcp' },
  { lang: 'ru', query: 'что это за правила, для чего они', topic: 'rules' },
  { lang: 'ru', query: 'как работает агент панели', topic: 'panelAgent' },
  { lang: 'ru', query: 'история изменений', topic: 'history' },
  { lang: 'ru', query: 'как разделить задачи по чатам', topic: 'chat' },
  { lang: 'ru', query: 'что Claude может делать без спроса', topic: 'permissions' },
  { lang: 'ru', query: 'как подключить контур по ключу', topic: 'platform' },
  { lang: 'ru', query: 'сколько токенов я потратил', topic: 'analytics' },
  { lang: 'ru', query: 'где хранятся токены и переменные окружения', topic: 'env' },
  { lang: 'ru', query: 'как запустить тесты проекта', topic: 'tests' },
  { lang: 'ru', query: 'зачем нужны скиллы', topic: 'skills' },
  { lang: 'ru', query: 'как подключить Jira', topic: 'integrations' },
  { lang: 'ru', query: 'приложение на телефоне', topic: 'phone' },
  { lang: 'ru', query: 'как подключить локальную модель вместо облака', topic: 'endpoints' },
  { lang: 'ru', query: 'какие команды можно вызвать через слэш', topic: 'commands' },
  { lang: 'ru', query: 'как установить плагин', topic: 'plugins' },
  // «права» (разрешения) и «правила» — разные разделы; совпадение по началу
  // слова их смешивало, сравнение основ — нет.
  { lang: 'ru', query: 'что такое права', topic: 'permissions' },
  { lang: 'ru', query: 'права Claude на команды', topic: 'permissions' },
  // Ни одного слова из заголовка: решает тело темы с поправкой на её длину.
  { lang: 'ru', query: 'как дать Claude доступ к базе данных', topic: 'mcp' },
  { lang: 'ru', query: 'как запретить удаление файлов', topic: 'permissions' },
  { lang: 'en', query: 'what are hooks', topic: 'hooks' },
  { lang: 'en', query: 'what is MCP', topic: 'mcp' },
  { lang: 'en', query: 'what are these rules for', topic: 'rules' },
  { lang: 'en', query: 'how does the panel agent work', topic: 'panelAgent' },
  { lang: 'en', query: 'change history', topic: 'history' },
  { lang: 'en', query: 'how do I split tasks across chats', topic: 'chat' },
  { lang: 'en', query: 'how much did I spend on tokens', topic: 'analytics' },
  { lang: 'en', query: 'how to connect a contour', topic: 'platform' },
  { lang: 'en', query: 'how do I run the project tests', topic: 'tests' },
  { lang: 'en', query: 'what can Claude do without asking', topic: 'permissions' },
  { lang: 'en', query: 'how to install a plugin', topic: 'plugins' },
  { lang: 'en', query: 'how to give Claude access to a database', topic: 'mcp' },
  // Ревью 28.09, m8: вопросы словами человека, не словами заголовка.
  { lang: 'en', query: 'forbid deleting files', topic: 'permissions' },
  { lang: 'ru', query: 'откатить правку', topic: 'history' },
  { lang: 'en', query: 'roll back a config edit', topic: 'history' },
];

describe('поиск по справке: простой вопрос → нужная тема первой', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    const ctx = { store: { getSettings: () => ({ language: 'ru' }) } } as unknown as ServerContext;
    registerPanelHelpRoutes(app, ctx);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const top = async (lang: string, query: string): Promise<string[]> => {
    const answer = await app.inject({
      method: 'GET',
      url: `/api/agent/help/search?q=${encodeURIComponent(query)}&lang=${lang}&limit=3`,
    });
    expect(answer.statusCode).toBe(200);
    return (answer.json() as { hits: Array<{ id: string }> }).hits.map((hit) => hit.id);
  };

  it('каждый вопрос эталона ставит свою тему первой', async () => {
    // Весь эталон одним сравнением: красный прогон называет ВСЕ промахи сразу.
    const misses: string[] = [];
    for (const item of GOLDEN) {
      const ids = await top(item.lang, item.query);
      if (ids[0] !== item.topic)
        misses.push(`${item.lang} «${item.query}» → ${ids.join(', ')} (ждали ${item.topic})`);
    }
    expect(misses).toEqual([]);
  });

  it('служебные слова сами по себе ничего не находят: «что это такое» — не вся справка', async () => {
    const answer = await app.inject({
      method: 'GET',
      url: `/api/agent/help/search?q=${encodeURIComponent('что это такое')}&lang=ru`,
    });
    const body = answer.json() as { total: number };
    expect(body.total).toBeLessThan(5);
  });
});
