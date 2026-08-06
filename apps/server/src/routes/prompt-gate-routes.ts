import type { FastifyInstance } from 'fastify';
import type { PromptGateInfo, PromptGateSettings } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { applyPromptGate, describePromptGate, type GateLocation } from '../domains/prompt-gate.ts';

/**
 * Гейт на промпте: состояние и одно действие «привести в соответствие».
 *
 * Настройки и диск меняются ОДНИМ запросом намеренно. Разведи их на общий
 * `PATCH /api/settings` и отдельную установку — и появится состояние, где в
 * настройках гейт включён, а хука в `settings.json` нет: панель показывала бы
 * защиту, которой на диске не существует.
 *
 * - `GET /api/prompt-gate` — настройки, что лежит на диске, сколько правил.
 * - `PUT /api/prompt-gate` — сохранить настройки и установить/снять хук.
 */
export function registerPromptGateRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const location = (): GateLocation => ({
    hooksDir: ctx.location.paths.hooks,
    settingsPath: ctx.location.paths.settings,
    appDataDir: ctx.location.paths.appData,
  });

  app.get('/api/prompt-gate', () => {
    return describePromptGate(ctx.store, location()) satisfies PromptGateInfo;
  });

  app.put<{ Body: unknown }>('/api/prompt-gate', (request, reply) => {
    const body = request.body as { enabled?: unknown; action?: unknown; force?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_body', message: 'Ожидается поле enabled.' });
    }
    if (body.action !== 'block' && body.action !== 'warn') {
      return reply.code(400).send({ error: 'invalid_body', message: 'Действие: block или warn.' });
    }

    const settings: PromptGateSettings = { enabled: body.enabled, action: body.action };
    ctx.store.updateSettings({ promptGate: settings });

    try {
      return applyPromptGate(ctx.store, location(), settings, {
        force: body.force === true,
        backupDir: ctx.backupDir,
      }) satisfies PromptGateInfo;
    } catch (error) {
      // Настройка уже сохранена, а диск — нет. Возвращаем настройки обратно,
      // чтобы панель не показывала включённый гейт без хука.
      ctx.store.updateSettings({ promptGate: { ...settings, enabled: false } });
      return reply.code(500).send({
        error: 'prompt_gate_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
