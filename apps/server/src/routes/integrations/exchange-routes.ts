import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { fetchCiReport } from '../../domains/integrations/ci.ts';
import { readIntegrations, readToken, requireConnected } from '../../domains/integrations/store.ts';
import { tmsClient } from '../../domains/integrations/tms/index.ts';
import { pullIntoGroup, pushRunToTms } from '../../domains/integrations/tms/sync.ts';
import { sendTelegramMessage } from '../../domains/notify/telegram.ts';
import { sendWebhook } from '../../domains/notify/webhook.ts';
import { importResults } from '../../domains/project-tests/import-results.ts';
import {
  appDataOf,
  guard,
  optionalString,
  requireString,
  type IntegrationsDeps,
} from './shared.ts';

/**
 * Обмен с внешними системами: отчёт из CI, кейсы из тест-менеджмента, прогон
 * обратно туда же и проверка Telegram.
 *
 * Своего разбора форматов здесь НЕТ. Junit из CI уходит в тот же импорт, что и
 * файл, принесённый руками (`project-tests/import-results.ts`): второй разбор
 * того же формата разошёлся бы с первым на первой же нестандартной выгрузке.
 */
export function registerIntegrationExchangeRoutes(
  app: FastifyInstance,
  deps: IntegrationsDeps,
): void {
  /**
   * Забрать junit последнего прогона CI и разложить по кейсам.
   *
   * Адрес своей инсталляции берётся у форджа, когда вид совпадает: у карточки CI
   * своего адреса нет намеренно — один и тот же сервер человек рано или поздно
   * ввёл бы дважды и во второй раз с опечаткой.
   */
  app.post<{ Body: unknown }>('/api/integrations/ci/import', (request, reply) =>
    guard(reply, async () => {
      const body = request.body as { path?: unknown; environmentId?: unknown } | null;
      const root = resolve(requireString(body?.path, 'path', 'не указан каталог проекта'));
      const token = requireConnected(deps.ctx.store, appDataOf(deps), 'ci', 'CI');
      const settings = readIntegrations(deps.ctx.store);
      const baseUrl = settings.forge.kind === settings.ci.kind ? settings.forge.baseUrl : '';

      const report = await fetchCiReport(settings.ci, token, { projectRoot: root, baseUrl });
      const result = importResults(root, {
        format: 'junit',
        content: report.content,
        environmentId: optionalString(body?.environmentId),
      });
      return { ...result, source: report.source };
    }),
  );

  /** Кейсы из тест-менеджмента в группу панели. */
  app.post<{ Body: unknown }>('/api/integrations/tms/pull', (request, reply) =>
    guard(reply, async () => {
      const body = request.body as { path?: unknown; groupId?: unknown } | null;
      const root = resolve(requireString(body?.path, 'path', 'не указан каталог проекта'));
      const settings = readIntegrations(deps.ctx.store);
      const token = requireConnected(deps.ctx.store, appDataOf(deps), 'tms', 'Тест-менеджмент');
      // Группа из тела сильнее настройки: человек тянет кейсы в ту группу, что
      // открыта у него на экране, а настройка — это лишь значение по умолчанию.
      const groupId =
        optionalString(body?.groupId) ??
        requireString(settings.tms.groupId, 'groupId', 'не указана группа тестов');

      const batch = await tmsClient(settings.tms, token).pullCases();
      const result = pullIntoGroup(root, groupId, batch.cases, new Date().toISOString());
      // Обрезанную выборку называем вслух: «привезено 2000» человек читает как
      // «это все кейсы проекта» и об остальных не узнает.
      return batch.truncated ? { ...result, truncated: true } : result;
    }),
  );

  /** Прогон панели — в тест-менеджмент отдельным циклом/выполнением. */
  app.post<{ Body: unknown }>('/api/integrations/tms/push', (request, reply) =>
    guard(reply, async () => {
      const body = request.body as { path?: unknown; runId?: unknown } | null;
      const root = resolve(requireString(body?.path, 'path', 'не указан каталог проекта'));
      const runId = requireString(body?.runId, 'runId', 'не указан прогон');
      const settings = readIntegrations(deps.ctx.store);
      const token = requireConnected(deps.ctx.store, appDataOf(deps), 'tms', 'Тест-менеджмент');
      return pushRunToTms(tmsClient(settings.tms, token), root, runId);
    }),
  );

  /**
   * Проверка Telegram отправкой: `getMe` подтверждает только токен, а человека
   * интересует, дойдёт ли сообщение до ЕГО чата — бота могли не добавить в
   * группу или выкинуть из неё.
   */
  app.post('/api/integrations/telegram/test', (_request, reply) =>
    guard(reply, async () => {
      const token = requireConnected(deps.ctx.store, appDataOf(deps), 'telegram', 'Telegram');
      const settings = readIntegrations(deps.ctx.store).telegram;
      const chatId = requireString(settings.chatId, 'chatId', 'не указан чат для уведомлений');
      await sendTelegramMessage(token, chatId, '🔔 Проверка связи из панели agentdeck.');
      return { ok: true };
    }),
  );

  /**
   * Проверка вебхука тем же способом — настоящим POST на указанный адрес.
   *
   * Событие помечено `test`, чтобы приёмник мог его отличить и не завести по
   * нему дежурство. Секрет не обязателен: вебхук без подписи — обычный случай
   * внутренней шины, и требовать ключ там, где его негде взять, значит
   * заставить человека выключить проверку вовсе.
   */
  app.post('/api/integrations/webhook/test', (_request, reply) =>
    guard(reply, async () => {
      const settings = readIntegrations(deps.ctx.store).webhook;
      const url = requireString(settings.url, 'url', 'не указан адрес вебхука');
      await sendWebhook(url, readToken(appDataOf(deps), 'webhook'), {
        event: 'test',
        text: 'Проверка связи из панели agentdeck.',
        at: new Date().toISOString(),
      });
      return { ok: true };
    }),
  );
}
