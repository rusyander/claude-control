import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { registerRuleRoutes } from './entity/rule-routes.ts';
import { registerHookRoutes } from './entity/hook-routes.ts';
import { registerSkillRoutes } from './entity/skill-routes.ts';
import { registerMcpRoutes } from './entity/mcp-routes.ts';
import { registerPermissionRoutes } from './entity/permission-routes.ts';
import { registerEnvRoutes } from './entity/env-routes.ts';
import { registerEntityToggleRoutes } from './entity/toggle-routes.ts';

/**
 * Маршруты сущностей. Ответ на изменение всегда содержит needsRestart:
 * почти всё, что мы правим, Claude Code перечитывает только при старте, и
 * интерфейс должен честно об этом предупреждать.
 *
 * Сам набор разложен по разделам панели (`entity/*`) — здесь только сборка;
 * порядок регистрации тот же, что и был одним файлом.
 */
export function registerEntityRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerRuleRoutes(app, ctx);
  registerHookRoutes(app, ctx);
  registerSkillRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerPermissionRoutes(app, ctx);
  registerEnvRoutes(app, ctx);
  registerEntityToggleRoutes(app, ctx);
}
