import type { ClaudePaths, Overview } from '@claude-control/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { readRules } from './rules.ts';
import { readHooks } from './hooks.ts';
import { readSkills } from './skills.ts';
import { readMcpServers } from './mcp.ts';
import { readPermissions } from './permissions.ts';
import { readScripts } from './scripts.ts';

/**
 * Сводка главной страницы: сколько чего заведено и сколько из этого действует.
 *
 * Собирается из тех же читателей, что и сами разделы, — иначе обзор и раздел
 * расходились бы в цифрах. Считаем, а не отдаём списки: страница показывает
 * счётчики, и гнать через сеть весь конфиг ради них незачем.
 */
export function buildOverview(paths: ClaudePaths, store: AppStore): Overview {
  const rules = readRules(paths.claudeMd, store);
  // Обзор отвечает на вопрос «что сейчас действует», поэтому локальные
  // настройки считаются наравне с основными.
  const hooks = readHooks(paths.settings, store, paths.settingsLocal);
  const skills = readSkills(paths.skills, store);
  const servers = readMcpServers(paths.mcpConfig, store);
  const permissions = readPermissions(paths.settings, store, paths.settingsLocal);
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
    groups: { total: store.getGroups().length },
  };
}
