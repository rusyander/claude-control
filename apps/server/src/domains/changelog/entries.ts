import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { changelogEntryFileSchema } from '@agentdeck/contracts/changelog';
import type { CuratedFile } from './build.ts';

/**
 * Файлы описаний `changelog/entries/*.json`. Битый файл не роняет ленту: он
 * попадает в `invalid` с причиной, и вкладка называет его человеку.
 */

/** `2026-10-12-changelog-tab` — дата, дефис, имя; общий вид, по которому файл узнаётся. */
export const ENTRY_ID = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

interface EntriesRead {
  curated: CuratedFile[];
  invalid: { file: string; error: string }[];
}

function describe(error: unknown): string {
  if (error instanceof Error && 'issues' in error) {
    const issues = (error as { issues: { path: PropertyKey[]; message: string }[] }).issues;
    return issues
      .slice(0, 3)
      .map((issue) => `${issue.path.map(String).join('.') || '(корень)'}: ${issue.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

export async function readEntries(repoRoot: string): Promise<EntriesRead> {
  const dir = join(repoRoot, 'changelog', 'entries');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return { curated: [], invalid: [] };
  }
  const curated: CuratedFile[] = [];
  const invalid: EntriesRead['invalid'] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    try {
      if (!ENTRY_ID.test(id)) throw new Error('имя файла не вида ГГГГ-ММ-ДД-имя');
      const path = join(dir, name);
      const parsed = changelogEntryFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      curated.push({ id, entry: parsed, mtime: (await stat(path)).mtime.toISOString() });
    } catch (error) {
      invalid.push({ file: name, error: describe(error) });
    }
  }
  return { curated, invalid };
}
