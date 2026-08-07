import { existsSync, readFileSync, statSync } from 'node:fs';
import type { ProjectFileChanges } from '@claude-control/contracts';
import { diffLines } from '../history.ts';
import { MAX_CHANGED_FILES, MAX_DIFF_CHARS, MAX_FILE_BYTES } from './constants.ts';
import { looksBinary } from './content.ts';
import { rebuildBaseline, type CollectedEdits } from './edits.ts';
import { resolveProjectPath } from './paths.ts';

/**
 * Сводка «что агент поменял в этом разговоре»: по файлу на строку, с числом
 * добавленных и удалённых строк.
 *
 * Нужна дереву — отметить тронутые файлы — и списку «только изменённые».
 * Считается по тем же правилам, что и дифф одного файла, чтобы числа в дереве и
 * в редакторе не разошлись: разойдутся — верить перестанут обоим.
 */
export function readProjectChanges(root: string, collected: CollectedEdits): ProjectFileChanges {
  const files: ProjectFileChanges['files'] = [];
  let skipped = collected.skipped;

  for (const [path, edits] of collected.byFile) {
    if (files.length >= MAX_CHANGED_FILES) {
      skipped += 1;
      continue;
    }

    let full: string;
    try {
      full = resolveProjectPath(root, path);
    } catch {
      // Путь не прошёл проверку — в дерево он всё равно не попадёт.
      skipped += 1;
      continue;
    }

    if (!existsSync(full)) {
      files.push({ path, added: 0, removed: 0, missing: true });
      continue;
    }

    const stats = statSync(full);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      files.push({ path, added: 0, removed: 0, missing: false });
      continue;
    }

    const buffer = readFileSync(full);
    if (looksBinary(buffer)) {
      files.push({ path, added: 0, removed: 0, missing: false });
      continue;
    }

    const content = buffer.toString('utf8');
    const baseline = rebuildBaseline(content, edits);
    if (baseline.text === undefined || content.length > MAX_DIFF_CHARS) {
      files.push({ path, added: 0, removed: 0, missing: false });
      continue;
    }

    const diff = diffLines(baseline.text, content);
    files.push({ path, added: diff.added, removed: diff.removed, missing: false });
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'ru'));
  return { files, skipped };
}
