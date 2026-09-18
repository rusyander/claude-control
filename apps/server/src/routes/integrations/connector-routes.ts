import type { FastifyInstance } from 'fastify';
import type { ZodType } from 'zod';
import type { IntegrationId, IntegrationsSettings } from '@agentdeck/contracts';
import { parseBody } from '../../lib/request-body.ts';
import { integrationSettingsSchemas } from '../../providers/settings-validation.ts';
import { checkIntegration } from '../../domains/integrations/check.ts';
import {
  describeIntegration,
  describeIntegrations,
  forgetIntegration,
  isIntegrationId,
  writeSettings,
  writeToken,
} from '../../domains/integrations/store.ts';
import { appDataOf, fail, type IntegrationsDeps } from './shared.ts';
import { attachTextCodes } from '../../lib/server-texts.ts';

/**
 * Пять карточек интеграций: показать, сохранить, проверить связь, забыть.
 *
 * ГЛАВНОЕ СВОЙСТВО РАЗДЕЛА: ни один ответ здесь не содержит токена. Наружу
 * уходит только маска (`abc…4f21`) и признак «ключ сохранён» — этого хватает,
 * чтобы человек узнал свой ключ, и не хватает, чтобы им воспользоваться.
 * Поэтому же токен приходит отдельным полем и только когда его ТРОНУЛИ: форма,
 * присылающая настройку без поля токена, ничего с ключом не делает.
 */
export function registerIntegrationConnectorRoutes(
  app: FastifyInstance,
  deps: IntegrationsDeps,
): void {
  const store = (): typeof deps.ctx.store => deps.ctx.store;

  // Подпись проверки собрана строкой (`serverText`): код к ней восстанавливается
  // разбором — и у свежей проверки, и у записи, которая лежит в состоянии давно.
  app.get('/api/integrations', () =>
    attachTextCodes(describeIntegrations(store(), appDataOf(deps))),
  );

  /**
   * Сохранить карточку. Токен необязателен: пустая строка СТИРАЕТ сохранённый —
   * это осознанное «выкинуть ключ», а не пустое сохранение формы.
   */
  app.put<{ Params: { id: string }; Body: unknown }>('/api/integrations/:id', (request, reply) => {
    const id = request.params.id;
    if (!isIntegrationId(id)) {
      return reply.code(404).send({
        code: 'integration_not_found',
        message: `Интеграции «${id}» не существует.`,
        messageCode: 'integration-not-found',
        params: { id },
      });
    }

    const body = request.body as { settings?: unknown; token?: unknown } | undefined;
    const schema: ZodType<unknown> = integrationSettingsSchemas[id];
    const settings = parseBody(schema, body?.settings, reply);
    if (settings === undefined) return reply;

    try {
      writeSettings(store(), id, settings as IntegrationsSettings[IntegrationId]);
      if (typeof body?.token === 'string') writeToken(appDataOf(deps), id, body.token.trim());
      return attachTextCodes(describeIntegration(store(), appDataOf(deps), id));
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * Живая проверка. Никогда не отвечает отказом: неудача — это состояние
   * карточки с причиной, а не 502 в консоли браузера.
   */
  app.post<{ Params: { id: string } }>('/api/integrations/:id/check', async (request, reply) => {
    const id = request.params.id;
    if (!isIntegrationId(id)) {
      return reply.code(404).send({
        code: 'integration_not_found',
        message: `Интеграции «${id}» не существует.`,
        messageCode: 'integration-not-found',
        params: { id },
      });
    }
    return attachTextCodes(await checkIntegration(store(), appDataOf(deps), id));
  });

  /** Забыть: токен стирается, карточка гасится. Адрес и почта остаются. */
  app.delete<{ Params: { id: string } }>('/api/integrations/:id', (request, reply) => {
    const id = request.params.id;
    if (!isIntegrationId(id)) {
      return reply.code(404).send({
        code: 'integration_not_found',
        message: `Интеграции «${id}» не существует.`,
        messageCode: 'integration-not-found',
        params: { id },
      });
    }
    return forgetIntegration(store(), appDataOf(deps), id);
  });
}
