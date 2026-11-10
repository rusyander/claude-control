import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LayerRun, SessionLayerCarry } from '../adapter.types.ts';

/**
 * Перенос слоя панели в Claude Code (G6): каталоги плагинов набора и сужение источников.
 *
 * Сеанс ядра держит MCP строгим списком (`--strict-mcp-config` + свой `--mcp-config`), а плагин
 * с серверами MCP добавил бы свои мимо этого списка и мимо выбора `mcpPicks` — такой плагин
 * отказан, как и каталог, которого нет (CLI молча пропустил бы его, и набор не встал бы).
 * Хуки плагина идут при слое человека `on` и при `observe`, до которого `on` снизило недоверие к
 * папке (G13: набор — каталог панели, не репозитория). В `observe`/`off`, попрошенном шагом, хуки
 * человека ядро не исполняет, а плагин исполнял бы свои — отказ по имени, а не урезанный сеанс.
 * Сужение источников вне `on` бессмысленно: ядро уже даёт CLI `--setting-sources ''`.
 */

const MANIFEST = join('.claude-plugin', 'plugin.json');

/** Почему каталог плагина не годится; `null` — годится. */
export function pluginDirProblem(dir: string): string | null {
  if (!isAbsolute(dir)) return `plugin dir is not absolute: ${dir}`;
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return `plugin dir missing: ${dir}`;
  if (existsSync(join(dir, '.mcp.json'))) {
    return `plugin declares MCP servers (.mcp.json), outside the session's strict MCP list: ${dir}`;
  }
  const manifest = join(dir, MANIFEST);
  if (!existsSync(manifest)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return `plugin manifest unreadable, its MCP servers cannot be ruled out: ${manifest}`;
  }
  if (typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed) {
    return `plugin declares MCP servers (plugin.json mcpServers), outside the session's strict MCP list: ${dir}`;
  }
  return null;
}

export function pluginCarryRefusal(
  carry: SessionLayerCarry | undefined,
  layer: Pick<LayerRun, 'asked' | 'ran'>,
): string | null {
  if (!carry) return null;
  // Недоверенная папка (F-86) снижает `on` до `observe` ради файлов РЕПОЗИТОРИЯ; набор панели —
  // её собственный каталог вне репозитория, и прежняя панель (`claude -p`, доверие CLI не
  // спрашивает) ставила его в любом проекте. Поэтому снижение доверием плагины не отказывает:
  // `--setting-sources` ядро и так держит `''` (у́же сужения набора), плагин едет как был. Отказ —
  // только когда `observe`/`off` попросил сам шаг: там хуки не должны действовать вовсе.
  const demotedByTrust = layer.asked === 'on' && layer.ran === 'observe';
  // Хуки профиля чата панели (s12) — команда из каталога панели, как плагин набора: тот же суд.
  const layered =
    (carry.plugins?.length ?? 0) > 0 ||
    carry.settingSources !== undefined ||
    Object.keys(carry.hooks ?? {}).length > 0;
  if (layered && layer.ran !== 'on' && !demotedByTrust) {
    return (
      `session-carry-needs-layer-on: plugins, panel hooks and setting sources ride the human ` +
      `layer, this step runs it '${layer.ran}' by its own mode`
    );
  }
  for (const dir of carry.plugins ?? []) {
    const problem = pluginDirProblem(dir);
    if (problem) return `session-carry-plugin: ${problem}`;
  }
  return null;
}
