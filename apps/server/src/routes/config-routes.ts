import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { AppSettings, Overview } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { readRules } from '../domains/rules.ts';
import { readHooks } from '../domains/hooks.ts';
import { readSkills } from '../domains/skills.ts';
import { readMcpServers } from '../domains/mcp.ts';
import { readPermissions } from '../domains/permissions.ts';
import { readAccount } from '../domains/account.ts';
import { readScripts } from '../domains/scripts.ts';

/** Маршруты про само приложение: расположение конфигов, настройки, сводка. */
export function registerConfigRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/location', () => ctx.location);

  app.post<{ Body: { path: string } }>('/api/location', (request) => {
    const result = ctx.relocate(request.body.path);
    if (result.isValid) ctx.store.updateSettings({ claudeDirOverride: request.body.path });
    return result;
  });

  app.get('/api/settings', () => ctx.store.getSettings());

  app.get('/api/account', () => readAccount(ctx.location.paths.mcpConfig));

  /**
   * Сведения о системе. Нужны разделу прав: набор опасных команд и вид путей
   * зависят от операционной системы, и подсказки должны быть под неё.
   */
  app.get('/api/system', () => ({
    platform: process.platform,
    osName:
      process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    homeDir: homedir(),
    nodeVersion: process.version,
    shell: process.platform === 'win32' ? 'PowerShell / cmd' : (process.env.SHELL ?? 'sh'),
  }));

  app.patch<{ Body: Partial<AppSettings> }>('/api/settings', (request) => {
    const settings = ctx.store.updateSettings(request.body);
    // Смена каталога через настройки применяется сразу же, а не после перезапуска.
    if (request.body.claudeDirOverride !== undefined) ctx.relocate(request.body.claudeDirOverride);
    return settings;
  });

  app.get('/api/overview', (): Overview => {
    const { paths } = ctx.location;
    const rules = readRules(paths.claudeMd, ctx.store);
    const hooks = readHooks(paths.settings, ctx.store);
    const skills = readSkills(paths.skills, ctx.store);
    const servers = readMcpServers(paths.mcpConfig, ctx.store);
    const permissions = readPermissions(paths.settings, ctx.store);
    const scripts = readScripts(
      paths.hooks,
      hooks.map((hook) => hook.scriptPath).filter((path): path is string => Boolean(path)),
    );

    return {
      rules: { total: rules.length, enabled: rules.filter((item) => item.isEnabled).length },
      hooks: {
        total: hooks.length,
        enabled: hooks.filter((item) => item.isEnabled).length,
        // Хук с несуществующим скриптом молча не сработает — такие важно видеть.
        broken: hooks.filter((item) => item.scriptPath && item.scriptExists === false).length,
      },
      skills: { total: skills.length, enabled: skills.filter((item) => item.isEnabled).length },
      scripts: {
        total: scripts.length,
        unused: scripts.filter((item) => !item.isUsed).length,
      },
      mcp: {
        total: servers.length,
        enabled: servers.filter((item) => item.isEnabled).length,
        connected: servers.filter((item) => item.health === 'connected').length,
        failed: servers.filter((item) => item.health === 'failed').length,
      },
      permissions: {
        allow: permissions.filter((item) => item.decision === 'allow').length,
        ask: permissions.filter((item) => item.decision === 'ask').length,
        deny: permissions.filter((item) => item.decision === 'deny').length,
      },
      groups: { total: ctx.store.getGroups().length },
    };
  });
}
