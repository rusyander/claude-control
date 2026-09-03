import type { FastifyInstance } from 'fastify';
import type { DlpInfo, DlpPreviewResult } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  buildDlpRuntime,
  clearJournal,
  describeDlp,
  DlpConfigError,
  DlpRulesError,
  parseRules,
  readJournal,
  readRules,
  previewDlp,
  saveRules,
  validateRules,
  type DlpProxy,
} from '../domains/dlp.ts';

/**
 * Защита данных: правила, предпросмотр, журнал, запуск и остановка прокси.
 *
 * НАСТРОЙКИ раздела (порт, адрес наверх, политика неразобранного) правятся общим
 * `PATCH /api/settings` — второго пути записи нет намеренно, как и у профилей
 * эндпоинта. Здесь то, чего в настройках нет: сами правила (отдельный файл,
 * потому что в них персональные данные), журнал и состояние слушателя.
 *
 * - `GET /api/dlp` — настройки, правила, состояние.
 * - `PUT /api/dlp/rules` — заменить набор правил (проверка до записи).
 * - `POST /api/dlp/preview` — прогнать правила по пробному тексту, без сети.
 * - `POST /api/dlp/start` · `POST /api/dlp/stop` — слушатель.
 * - `GET /api/dlp/journal` · `DELETE /api/dlp/journal` — лента срабатываний.
 */
export function registerDlpRoutes(app: FastifyInstance, ctx: ServerContext, proxy: DlpProxy): void {
  const appDataDir = (): string => ctx.location.paths.appData;

  app.get('/api/dlp', () => {
    return describeDlp(ctx.store, appDataDir(), proxy) satisfies DlpInfo;
  });

  app.put<{ Body: unknown }>('/api/dlp/rules', (request, reply) => {
    const rules = rulesOf(request.body);
    if (!rules) {
      return reply.code(400).send({ error: 'invalid_body', message: 'Ожидается список правил.' });
    }

    // Форма проверяется до всего остального: `null` вместо правила или словарь
    // без поля `terms` раньше падали в 500 уже внутри смысловой проверки.
    const problem = validateRules(rules);
    if (problem) return reply.code(400).send({ error: 'invalid_rule', message: problem });

    try {
      saveRules(appDataDir(), rules);
    } catch (error) {
      if (error instanceof DlpRulesError) {
        return reply.code(400).send({ error: 'invalid_rule', message: error.message });
      }
      throw error;
    }

    // Правила поменялись, а прокси уже работает со старым набором. Перезапуск
    // здесь, а не «применится потом»: пока не перезапустили, панель показывала
    // бы одни правила, а фильтровались бы другие.
    if (proxy.running) void restart(ctx, appDataDir(), proxy);
    return { ok: true };
  });

  app.post<{ Body: unknown }>('/api/dlp/preview', (request, reply) => {
    const body = request.body as { text?: unknown; rules?: unknown } | null;
    if (!body || typeof body.text !== 'string') {
      return reply.code(400).send({ error: 'invalid_body', message: 'Ожидается поле text.' });
    }

    // Правила можно прислать в теле — тогда видно результат ЧЕРНОВИКА, до
    // сохранения. Черновик может быть незаполненным (пустой словарь, выражение
    // без закрытой скобки) — такое правило просто ничего не найдёт; отказ
    // только на неверную форму. Без правил в теле берём сохранённые.
    const draft = rulesOf(body);
    let rules;
    if (draft) {
      const parsed = parseRules(draft);
      if (parsed instanceof DlpRulesError) {
        return reply.code(400).send({ error: 'invalid_rule', message: parsed.message });
      }
      rules = parsed;
    } else {
      rules = safeRules(appDataDir());
    }
    return previewDlp(body.text, rules) satisfies DlpPreviewResult;
  });

  // Тумблер «включено» в настройках и живой слушатель — одно состояние, но
  // страница шлёт их двумя запросами. Связь закрепляет сервер: клиент, знающий
  // только /dlp/start, иначе получал бы прокси, который не переживёт перезапуск
  // панели (на старте читается settings.dlp.enabled), а не дошедший PATCH —
  // тумблер «выключено» при работающем слушателе.
  const rememberEnabled = (enabled: boolean): void => {
    const settings = ctx.store.getSettings();
    if (settings.dlp.enabled === enabled) return;
    ctx.store.updateSettings({ dlp: { ...settings.dlp, enabled } });
  };

  app.post('/api/dlp/start', async (_request, reply) => {
    try {
      await proxy.start(buildDlpRuntime(ctx.store, appDataDir()));
      rememberEnabled(true);
    } catch (error) {
      if (error instanceof DlpConfigError || error instanceof DlpRulesError) {
        return reply.code(400).send({ error: 'dlp_misconfigured', message: error.message });
      }
      // Занятый порт и отказ привязки — самая частая причина; текст системы
      // понятнее любой нашей формулировки.
      return reply.code(409).send({
        error: 'dlp_start_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return describeDlp(ctx.store, appDataDir(), proxy) satisfies DlpInfo;
  });

  app.post('/api/dlp/stop', async () => {
    await proxy.stop();
    rememberEnabled(false);
    return describeDlp(ctx.store, appDataDir(), proxy) satisfies DlpInfo;
  });

  app.get<{ Querystring: { limit?: string } }>('/api/dlp/journal', (request) => {
    // Ноль и отрицательное — не «ничего» и не «всё, кроме первых»: лимит либо
    // положительное число, либо значение по умолчанию.
    const limit = Math.floor(Number(request.query.limit));
    return {
      entries: readJournal(appDataDir(), Number.isFinite(limit) && limit > 0 ? limit : undefined),
    };
  });

  app.delete('/api/dlp/journal', () => {
    clearJournal(appDataDir());
    return { ok: true };
  });
}

/** Правила из тела запроса. Не массив — отказ, а не «считаем, что правил нет». */
function rulesOf(body: unknown): unknown[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const rules = (body as { rules?: unknown }).rules;
  return Array.isArray(rules) ? rules : undefined;
}

/** Правила для предпросмотра: битый файл здесь не повод отказывать в проверке текста. */
function safeRules(appDataDir: string) {
  try {
    return readRules(appDataDir);
  } catch {
    return [];
  }
}

async function restart(ctx: ServerContext, appDataDir: string, proxy: DlpProxy): Promise<void> {
  try {
    await proxy.start(buildDlpRuntime(ctx.store, appDataDir));
  } catch {
    // Причина уже видна в статусе; ронять ответ на сохранение правил из-за
    // неудачного перезапуска нельзя — правила-то сохранились.
    await proxy.stop();
  }
}
