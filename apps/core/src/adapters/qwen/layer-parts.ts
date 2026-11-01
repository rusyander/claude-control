import { basename, join } from 'node:path';
import type { UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import {
  agentModelOf,
  inventoryHash,
  listDirs,
  listFiles,
  nameOf,
  parseFrontmatter,
  readSource,
  skillFlowOf,
  type Source,
  type Unread,
} from '../layer-inventory.ts';
import { qwenHome } from './read-layer.ts';

/**
 * Опись слоя Qwen Code 0.24.3 (01:18, проба Q7): дом CLI (`QWEN_HOME` или `~/.qwen`) и `.qwen`
 * копии. Слой репозитория Qwen читает и в недоверенной копии (`repo-layer.ts`: ключи, чьё
 * действие держит ядро, грузятся) — поэтому опись берёт его всегда. Хуки — с ключами
 * `<событие>.<группа>.<хук>` в порядке файлов, как у Claude; записи `observe` у Qwen нет (G3).
 */

type Scope = Source['scope'];
type Hook = UserLayerInventory['hooks'][number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const md = (name: string): boolean => name.toLowerCase().endsWith('.md');
const command = (name: string): boolean => /\.(md|toml)$/i.test(name);

export function qwenInventory(pin: Record<string, string>, cwd: string): UserLayerInventory {
  const home = qwenHome(pin).path;
  const project = join(cwd, '.qwen');
  const sources: Source[] = [];
  const unread: Unread[] = [];
  const settings: Record<string, unknown> = {};
  const hooks: Hook[] = [];
  const skills: UserLayerInventory['skills'] = [];
  const agents: UserLayerInventory['agents'] = [];
  const groupsSeen: Record<string, number> = {};

  const take = (path: string, kind: Source['kind'], scope: Scope): string | null => {
    const got = readSource(path);
    if (!got) return null;
    if ('unread' in got) {
      unread.push({ path, reason: got.unread });
      return null;
    }
    sources.push({ kind, scope, path, sha256: got.sha256, bytes: got.bytes });
    return got.text;
  };

  for (const [path, scope] of [
    [join(home, 'settings.json'), 'user'],
    [join(project, 'settings.json'), 'project'],
  ] as [string, Scope][]) {
    const text = take(path, 'settings', scope);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      unread.push({ path, reason: 'not valid settings JSON' });
      continue;
    }
    settings[path] = parsed;
    const table = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : {};
    for (const [event, groups] of Object.entries(table)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups as unknown[]) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        const g = (groupsSeen[event] = (groupsSeen[event] ?? -1) + 1);
        (group.hooks as unknown[]).forEach((hook, h) => {
          if (!isRecord(hook)) return;
          hooks.push({
            key: `${event}.${g}.${h}`,
            event,
            matcher: typeof group.matcher === 'string' ? group.matcher : null,
            command: typeof hook.command === 'string' ? hook.command : '',
            sourcePath: path,
          });
        });
      }
    }
  }

  take(join(home, 'QWEN.md'), 'instructions', 'user');
  take(join(cwd, 'QWEN.md'), 'instructions', 'project');
  for (const [root, scope] of [
    [home, 'user'],
    [project, 'project'],
  ] as [string, Scope][]) {
    for (const path of listFiles(join(root, 'rules'), md, true, unread)) take(path, 'rules', scope);
    for (const dir of listDirs(join(root, 'skills'), unread)) {
      const path = join(dir, 'SKILL.md');
      const text = take(path, 'skill', scope);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      skills.push({ name: nameOf(fm, basename(dir)), path: dir, ...skillFlowOf(fm) });
    }
    for (const path of listFiles(join(root, 'commands'), command, true, unread)) {
      take(path, 'skill', scope);
    }
    for (const path of listFiles(join(root, 'agents'), md, false, unread)) {
      const text = take(path, 'agent', scope);
      if (text === null) continue;
      const fm = parseFrontmatter(text);
      agents.push({
        name: nameOf(fm, basename(path).replace(/\.md$/i, '')),
        model: agentModelOf(fm),
        path,
      });
    }
  }
  return {
    cli: 'qwen',
    hash: inventoryHash(sources, unread, settings),
    sources,
    hooks,
    skills,
    agents,
    unread,
  };
}
