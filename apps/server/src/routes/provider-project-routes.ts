import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { registerProviderProjectInfoRoutes } from './provider-project/info-routes.ts';
import { registerProviderProjectInstructionsRoutes } from './provider-project/instructions-routes.ts';
import { registerProviderProjectRulesRoutes } from './provider-project/rules-routes.ts';
import { registerProviderProjectMcpRoutes } from './provider-project/mcp-routes.ts';
import { registerProviderProjectEnvRoutes } from './provider-project/env-routes.ts';
import { registerProviderProjectPermissionsRoutes } from './provider-project/permissions-routes.ts';
import { registerProviderProjectHooksRoutes } from './provider-project/hooks-routes.ts';
import { registerProviderProjectPluginsRoutes } from './provider-project/plugins-routes.ts';
import { registerProviderProjectSkillsRoutes } from './provider-project/skills-routes.ts';

/**
 * Проектный уровень конфигурации у НЕ-Claude провайдеров (COMMON-2).
 *
 * Реестр проектов общий (`/api/projects` — раздел самой панели), а вот файлы
 * проекта у каждого провайдера свои. Claude обслуживается прежними маршрутами
 * `/api/projects/:id/{rules,mcp,permissions}` — они не тронуты (регресс-ноль);
 * здесь живёт универсальная ветка `/api/projects/:id/provider/*`.
 *
 * FAIL-CLOSED на каждом шаге:
 *  - провайдер без `projects=ready`/`projectConfig` (включая claude) → 400
 *    `section_unsupported`;
 *  - проект не в реестре → 404; каталог проекта исчез → 400 `invalid_project`;
 *  - раздела нет у этого провайдера (у Cursor нет проектных инструкций) → 400;
 *  - путь вышел бы за пределы проекта → 400 `unsafe_path` (запись не делается);
 *  - формат файла не распознан → чтение отдаёт `readOnly`, запись 422.
 *
 * Сами разделы разложены по `provider-project/*` (общие для них проверка цели и
 * тексты отказов — в `target.ts` и `messages.ts`); здесь только сборка.
 */
export function registerProviderProjectRoutes(app: FastifyInstance, ctx: ServerContext): void {
  registerProviderProjectInfoRoutes(app, ctx);
  registerProviderProjectInstructionsRoutes(app, ctx);
  registerProviderProjectRulesRoutes(app, ctx);
  registerProviderProjectMcpRoutes(app, ctx);
  registerProviderProjectEnvRoutes(app, ctx);
  registerProviderProjectPermissionsRoutes(app, ctx);
  registerProviderProjectHooksRoutes(app, ctx);
  registerProviderProjectPluginsRoutes(app, ctx);
  registerProviderProjectSkillsRoutes(app, ctx);
}
