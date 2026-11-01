import { join } from 'node:path';
import type { SkillMode } from '@agentdeck/contracts/core/user-layer';
import type { LayerMode } from '../adapter.types.ts';
import type { ClaudeLayerParts, LayerEntry } from './layer-parts.ts';

/**
 * Подача слоя человека без его хуков (P87, G-b, проба Q4). `--setting-sources ''` в `observe` и
 * `off` снимает не только хуки, но и инструкции, правила, навыки, агенты и команды — каждую
 * часть ядро возвращает дорогой, которая хуков не исполняет:
 * - инструкции и правила репозитория — `--add-dir <cwd>` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`
 *   (cwd и так рабочий каталог: доступ не шире);
 * - инструкции и правила человека — склейкой в файл брифа (`--add-dir` на дом открыл бы весь дом);
 * - навыки, команды, агенты — копиями в плагин сеанса (`--plugin-dir`), имя получает префикс.
 * Чего дорога не несёт — потеря, своей строкой в `losses` (её видят LayerRun, решение
 * `layer-run`, сигнал `layer-loss` и экран запуска), не молча.
 */

export const LAYER_PLUGIN = 'user-layer';
const ADD_DIR_MD = 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD';

export interface LayerSupply {
  args: string[];
  env: Record<string, string>;
  /** Хвост файла брифа: инструкции человека склейкой. */
  briefTail: string;
  /** Копии в каталог сеанса: путь-источник → путь относительно каталога сеанса. */
  copies: { from: string; to: string }[];
  files: Record<string, string>;
  /** Подмены, по одной строке, без `; ` внутри. */
  detail: string[];
  /** Потери — части слоя, которые ни одна дорога не несёт; по одной строке. */
  losses: string[];
}

const label = (path: string): string => path.replace(/;/g, ',');

/**
 * Копии плагина без конфликтов имён: первый взятый побеждает (порядок старшинства передаёт
 * вызывающий); с хуками — потеря.
 */
function pick(
  entries: readonly LayerEntry[],
  kind: 'skill' | 'command' | 'agent',
  into: string,
  out: LayerSupply,
): number {
  const taken = new Set<string>();
  let copied = 0;
  for (const entry of entries) {
    if (taken.has(entry.rel.toLowerCase())) continue;
    taken.add(entry.rel.toLowerCase());
    if (entry.hooks) {
      out.losses.push(`${kind} ${entry.name} carries its own hooks, not re-supplied`);
      continue;
    }
    out.copies.push({ from: entry.path, to: join(into, entry.rel) });
    copied++;
  }
  return copied;
}

const byScope = (entries: readonly LayerEntry[], first: 'user' | 'project'): LayerEntry[] => [
  ...entries.filter((e) => e.scope === first),
  ...entries.filter((e) => e.scope !== first),
];

export function claudeLayerSupply(
  parts: ClaudeLayerParts,
  mode: LayerMode,
  skills: SkillMode,
  cwd: string,
  pluginDir: string,
): LayerSupply {
  const out: LayerSupply = {
    args: [],
    env: {},
    briefTail: '',
    copies: [],
    files: {},
    detail: [],
    losses: [],
  };
  // Навыки выключены — флаг CLI снимает инструмент `Skill`, все навыки и команды (Q6).
  if (skills === 'off') out.args.push('--disable-slash-commands');
  if (mode === 'on') return out;

  if (parts.projectInstructions.length > 0) {
    out.args.push('--add-dir', cwd);
    out.env[ADD_DIR_MD] = '1';
  }
  if (parts.userInstructions.length > 0) {
    out.briefTail = parts.userInstructions
      .map((file) => `\n\n<!-- user instructions: ${label(file.path)} -->\n${file.text.trimEnd()}`)
      .join('');
    for (const file of parts.userInstructions) {
      if (file.imports) {
        out.losses.push(`@imports in ${label(file.path)} are not resolved`);
      }
      if (file.pathScoped) {
        out.detail.push(`${mode}: path-scoped rule ${label(file.path)} loads unconditionally`);
      }
    }
  }

  // Навыки человека старше навыков репозитория, агенты репозитория старше агентов человека —
  // как у самого CLI.
  let copied = 0;
  if (skills === 'on') {
    copied += pick(byScope(parts.skills, 'user'), 'skill', join(pluginDir, 'skills'), out);
    copied += pick(byScope(parts.commands, 'user'), 'command', join(pluginDir, 'commands'), out);
  }
  copied += pick(byScope(parts.agents, 'project'), 'agent', join(pluginDir, 'agents'), out);
  if (copied > 0) {
    out.files[join(pluginDir, '.claude-plugin', 'plugin.json')] = JSON.stringify({
      name: LAYER_PLUGIN,
      version: '0.0.0',
      description: 'User skills, commands and agents re-supplied by the core without hooks',
    });
    out.detail.push(`${mode}: skills, commands and agents re-supplied as ${LAYER_PLUGIN}:<name>`);
  }
  return out;
}
