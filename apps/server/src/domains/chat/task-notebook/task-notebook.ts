import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUN_DIR, ensureRunDir } from '../../../lib/run-dir/run-dir.ts';

/**
 * Тетрадь задачи (9.2 плана экономии, 17.10.2026): один файл фактов группы в
 * её копии — вход на стенд, команды, порты, места, решения. Замер 16.10:
 * после сжатия группа выясняла всё заново — навык перечитывался до пяти раз,
 * журналы гейтов до восьми. Резюме сжатия теряет мелочи, а файл в копии — нет,
 * и его видит любой CLI: это просто файл, без возможностей одного провайдера.
 *
 * Панель заводит тетрадь при старте группы и кладёт в неё то, что разбор уже
 * нашёл (карта мест и общая подготовка, 8.3/8.4) — так это переживает и
 * сжатие, и смену звена. Дальше её ведёт сам агент (правило расхода группы).
 */
export const TASK_NOTEBOOK = `${RUN_DIR}/notebook.agent.md`;

/**
 * Прежнее имя. Агентский `.md` без суффикса `.agent.md` слой правил не даёт
 * писать через Write, а `echo >>` в Markdown — через шелл: группа тратила три
 * хода и уходила писать факты в чужой файл, мимо тетради (19.10.2026).
 */
const LEGACY_NOTEBOOK = `${RUN_DIR}/notebook.md`;

const HEADER =
  '# Task notebook\n\n' +
  'Facts this task had to find out — one line each, never a secret. ' +
  'Read before searching again; add a line when you find something new.\n';

/**
 * Завести тетрадь в каталоге группы и положить в неё посев этой группы — своим
 * разделом с названием группы. Записанное не трогается: группу перезапускают и
 * поднимают, а записанное агентом дороже повторного посева, поэтому раздел,
 * который уже есть, второй раз не пишется. В проекте без git группы работают в
 * одном каталоге (копий нет) и делят одну тетрадь: раздел каждой дописывается
 * к ней, а не теряется за первым (ревью A1-F6/B1-F4).
 *
 * Папка прячет себя от git сама (`.gitignore` со звёздочкой ловит и себя),
 * поэтому `.git/info/exclude` проекта не трогается, а `git add -A` доставки
 * тетрадь не захватит. Ошибка записи — не повод не запускать группу: вызывающий
 * её только пишет в журнал.
 */
export function seedTaskNotebook(cwd: string, notes: string | undefined, group: string): boolean {
  const file = join(cwd, TASK_NOTEBOOK);
  const heading = `## From the panel at the start — ${group.replace(/\s+/g, ' ').trim()}`;
  const seed = notes?.trim() ? `\n${heading}\n\n${notes.trim()}\n` : '';
  // Копия, заведённая до переименования, держит тетрадь под старым именем:
  // записанное в ней переезжает целиком, а не заводится заново пустым.
  const legacy = join(cwd, LEGACY_NOTEBOOK);
  if (!existsSync(file) && existsSync(legacy)) renameSync(legacy, file);
  if (!existsSync(file)) {
    ensureRunDir(cwd);
    writeFileSync(file, HEADER + seed);
    return true;
  }
  if (!seed || readFileSync(file, 'utf8').split(/\r?\n/).includes(heading)) return false;
  appendFileSync(file, seed);
  return true;
}
