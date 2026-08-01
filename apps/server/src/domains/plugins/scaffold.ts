import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { PluginScaffoldRequest, PluginScaffoldResult } from '@claude-control/contracts';
import { writeTextFile } from '../../lib/safe-io.ts';
import {
  agentTemplate,
  commandTemplate,
  hooksTemplate,
  readmeTemplate,
  skillTemplate,
} from './templates.ts';

const MANIFEST_DIR = '.claude-plugin';

/**
 * Имя плагина → безопасное имя папки и поле `name` манифеста.
 *
 * Формат Claude Code: строчные буквы, цифры и дефис. Пробелы и разделители
 * схлопываются в дефис, остальное отбрасывается. Пусто на выходе — имя из
 * одних недопустимых символов, создавать по нему нечего.
 */
export function pluginSlug(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

/**
 * Каркас плагина в выбранной папке.
 *
 * Плагин создаётся подпапкой `<имя>` внутри выбранного каталога: так чужие
 * файлы каталога не смешиваются с плагином, а повторный запуск не затирает
 * готовый плагин без явного `force`. Формат манифеста и структуры — по докам
 * Claude Code (`.claude-plugin/plugin.json`, авто-обнаружение commands/, agents/,
 * skills/, hooks/hooks.json).
 */
export function scaffoldPlugin(request: PluginScaffoldRequest): PluginScaffoldResult {
  const fail = (error: string): PluginScaffoldResult => ({
    ok: false,
    path: '',
    created: [],
    error,
  });

  const slug = pluginSlug(request.name);
  if (!slug) return fail('Недопустимое имя плагина: оставьте буквы, цифры и дефис');

  // Каталог приходит из выбора пользователя (FolderPicker) — он и есть граница
  // доверия. Но требуем абсолютный существующий путь: относительный склеился бы
  // с рабочим каталогом сервера, а несуществующий — молча создал бы дерево не там.
  const dir = request.dir?.trim();
  if (!dir || !isAbsolute(dir)) return fail('Каталог должен быть абсолютным путём');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return fail('Выбранный каталог не найден');
  }

  const base = resolve(dir);
  const target = resolve(base, slug);
  // Имя уже очищено до [a-z0-9-], выйти из каталога им нельзя; проверка —
  // страховка на случай изменения правил слага.
  if (target !== join(base, slug) || !target.startsWith(`${base}${sep}`)) {
    return fail('Недопустимое имя плагина');
  }

  if (existsSync(target) && !request.force) {
    return fail('Плагин с таким именем уже существует в этой папке');
  }

  const author = request.author?.trim();
  const manifest = {
    name: slug,
    version: '0.1.0',
    description: request.description?.trim() || '',
    ...(author ? { author: { name: author } } : {}),
    license: 'MIT',
    keywords: [] as string[],
  };

  const files: Array<{ path: string; content: string }> = [
    { path: `${MANIFEST_DIR}/plugin.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'README.md', content: readmeTemplate(slug, manifest.description) },
  ];

  if (request.components.commands) {
    files.push({ path: 'commands/example.md', content: commandTemplate(slug) });
  }
  if (request.components.agents) {
    files.push({ path: 'agents/example.md', content: agentTemplate(slug) });
  }
  if (request.components.skills) {
    files.push({ path: `skills/${slug}/SKILL.md`, content: skillTemplate(slug) });
  }
  if (request.components.hooks) {
    files.push({ path: 'hooks/hooks.json', content: hooksTemplate() });
  }

  const created: string[] = [];
  for (const file of files) {
    // writeTextFile сам создаёт недостающие папки и пишет атомарно.
    writeTextFile(join(target, ...file.path.split('/')), file.content);
    created.push(file.path);
  }

  return { ok: true, path: target, created };
}
