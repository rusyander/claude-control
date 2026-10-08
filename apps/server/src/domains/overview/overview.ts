import type { ClaudePaths, Overview } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store/app-store.ts';
import { readRules } from '../rules/rules.ts';
import { readHooks } from '../hooks/hooks.ts';
import { readSkills } from '../skills/skills.ts';
import { readMcpServers } from '../mcp/mcp.ts';
import { readPermissions } from '../permissions/permissions.ts';
import { readScripts } from '../scripts/scripts.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { buildProviderSectionCounts, overviewProvider } from '../overview-provider.ts';

/**
 * Сводка главной страницы: сколько чего заведено и сколько из этого действует.
 *
 * Собирается из тех же читателей, что и сами разделы, — иначе обзор и раздел
 * расходились бы в цифрах. Считаем, а не отдаём списки: страница показывает
 * счётчики, и гнать через сеть весь конфиг ради них незачем.
 */
export function buildOverview(paths: ClaudePaths, store: AppStore): Overview {
  const provider = getActiveProvider(store);
  // Активен другой CLI — разделы считаются по ЕГО файлам. Раньше обзор под Qwen
  // показывал цифры из `~/.claude`, а на машине без Claude — нули с чужой подписью.
  // «Скрипты» и группы — разделы самой панели, они от провайдера не зависят.
  if (provider.id !== 'claude') {
    return {
      provider: overviewProvider(provider),
      ...buildProviderSectionCounts(store),
      // Привязку скрипта к событию знают только хуки Claude — «не привязан»
      // под другим CLI был бы ложной тревогой, поэтому только общее число.
      scripts: { total: readScripts(paths.hooks, []).length, unused: 0 },
      groups: { total: store.getGroups().length },
    };
  }
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
    provider: overviewProvider(provider),
    rules: { total: rules.length, enabled: rules.filter((item) => item.isEnabled).length },
    hooks: {
      total: hooks.length,
      enabled: hooks.filter((item) => item.isEnabled).length,
      // Хук с несуществующим скриптом молча не сработает — такие важно видеть.
      broken: hooks.filter((item) => item.scriptPath && item.scriptExists === false).length,
    },
    skills: { total: skills.length, enabled: skills.filter((item) => item.isEnabled).length },
    scripts: countScripts(scripts),
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

function countScripts(scripts: ReturnType<typeof readScripts>): Overview['scripts'] {
  return {
    total: scripts.length,
    // Тесты и фикстуры к хукам не привязывают по замыслу — они не «забытые».
    unused: scripts.filter((item) => !item.isUsed && !item.isTest).length,
  };
}
