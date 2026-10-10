import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { fetchCiReport } from '../../domains/integrations/ci.ts';
import type { TmsKind } from '@agentdeck/contracts';
import { IntegrationError, invalidField } from '../../domains/integrations/errors.ts';
import {
  isConnected,
  readIntegrations,
  readToken,
  requireConnected,
  TMS_KINDS,
  tmsSettingsOf,
} from '../../domains/integrations/store/store.ts';
import { coded } from '../../lib/server-text/server-text.ts';
import { tmsClient } from '../../domains/integrations/tms/index.ts';
import { pullIntoGroup, pushRunToTms } from '../../domains/integrations/tms/sync.ts';
import { sendTelegramMessage } from '../../domains/notify/telegram.ts';
import { sendWebhook } from '../../domains/notify/webhook.ts';
import { importResults } from '../../domains/project-tests/import-results/import-results.ts';
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
/**
 * Какая система тест-кейсов: названная в теле, иначе единственная подключённая.
 * Подключены несколько и ни одна не названа — отказ с перечнем: угадать, куда
 * человек хотел отправить прогон, нельзя, а отправка не туда — чужой цикл.
 */
function tmsSystemFor(deps: IntegrationsDeps, requested: unknown): TmsKind {
  const named = TMS_KINDS.find((kind) => kind === requested);
  if (named) return named;
  const connected = TMS_KINDS.filter((kind) => isConnected(deps.ctx.store, appDataOf(deps), kind));
  if (connected.length === 1) return connected[0]!;
  if (connected.length === 0) {
    throw coded(
      new IntegrationError(
        'integration_not_found',
        'Ни одна система тест-кейсов не подключена: включите её и сохраните токен в настройках панели.',
      ),
      'integration-not-connected',
      { title: 'Zephyr / Xray / Test IT' },
    );
  }
  throw invalidField(
    'system',
    `подключено несколько систем тест-кейсов (${connected.join(', ')}) — укажите, какую`,
    'request-tms-system-ambiguous',
    { field: 'system', systems: connected.join(', ') },
  );
}

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
      const root = resolve(
        requireString(
          body?.path,
          'path',
          'не указан каталог проекта',
          'request-project-dir-missing',
          { field: 'path' },
        ),
      );
      const token = requireConnected(deps.ctx.store, appDataOf(deps), 'ci', 'CI');
      const settings = readIntegrations(deps.ctx.store);
      const baseUrl = settings.ci.kind ? settings[settings.ci.kind].baseUrl : '';

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
      const body = request.body as { path?: unknown; groupId?: unknown; system?: unknown } | null;
      const root = resolve(
        requireString(
          body?.path,
          'path',
          'не указан каталог проекта',
          'request-project-dir-missing',
          { field: 'path' },
        ),
      );
      const system = tmsSystemFor(deps, body?.system);
      const settings = tmsSettingsOf(deps.ctx.store, system);
      const token = requireConnected(deps.ctx.store, appDataOf(deps), system);
      // Группа из тела сильнее настройки: человек тянет кейсы в ту группу, что
      // открыта у него на экране, а настройка — это лишь значение по умолчанию.
      const groupId =
        optionalString(body?.groupId) ??
        requireString(
          settings.groupId,
          'groupId',
          'не указана группа тестов',
          'request-groupid-missing',
          { field: 'groupId' },
        );

      const batch = await tmsClient(settings, token).pullCases();
      const result = pullIntoGroup(root, groupId, batch.cases, new Date().toISOString());
      // Обрезанную выборку называем вслух: «привезено 2000» человек читает как
      // «это все кейсы проекта» и об остальных не узнает.
      return batch.truncated ? { ...result, truncated: true } : result;
    }),
  );

  /** Прогон панели — в тест-менеджмент отдельным циклом/выполнением. */
  app.post<{ Body: unknown }>('/api/integrations/tms/push', (request, reply) =>
    guard(reply, async () => {
      const body = request.body as { path?: unknown; runId?: unknown; system?: unknown } | null;
      const root = resolve(
        requireString(
          body?.path,
          'path',
          'не указан каталог проекта',
          'request-project-dir-missing',
          { field: 'path' },
        ),
      );
      const runId = requireString(body?.runId, 'runId', 'не указан прогон', 'request-run-missing', {
        field: 'runId',
      });
      const system = tmsSystemFor(deps, body?.system);
      const token = requireConnected(deps.ctx.store, appDataOf(deps), system);
      return pushRunToTms(tmsClient(tmsSettingsOf(deps.ctx.store, system), token), root, runId);
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
      const chatId = requireString(
        settings.chatId,
        'chatId',
        'не указан чат для уведомлений',
        'request-chat-id-missing',
        { field: 'chatId' },
      );
      await sendTelegramMessage(token, chatId, '🔔 Проверка связи из панели AgentDeck.');
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
      const url = requireString(
        settings.url,
        'url',
        'не указан адрес вебхука',
        'request-webhook-url-missing',
        { field: 'url' },
      );
      await sendWebhook(url, readToken(appDataOf(deps), 'webhook'), {
        event: 'test',
        text: 'Проверка связи из панели AgentDeck.',
        at: new Date().toISOString(),
      });
      return { ok: true };
    }),
  );
}
