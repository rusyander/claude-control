import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  ProviderSkill,
  ProviderSkillSummary,
  ProviderSkillsIgnoredDir,
  ProviderSkillsInfo,
} from '@claude-control/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { SECTION_MAX_ENTRIES, SECTION_MAX_FILE_BYTES, fileSizeOf } from '../../lib/section-fs.ts';
import { SKILL_FILE_NAME, SkillFormatError, readOpencodeSkill } from '../../lib/opencode-skill.ts';
import { SkillNotEditableError, SkillNotFoundError } from './errors.ts';
import { resolveSkillPath, toRelative } from './paths.ts';
import type { ProviderSkillsTarget } from './types.ts';

/** Папки каталога: со `SKILL.md` — скиллы, без него — прочие (показываем, не трогаем). */
function walkSkillsDir(target: ProviderSkillsTarget): { skills: string[]; ignored: string[] } {
  const skills: string[] = [];
  const ignored: string[] = [];
  let seen = 0;

  for (const entry of readdirSync(target.skillsDir, { withFileTypes: true })) {
    if (seen >= SECTION_MAX_ENTRIES) break;
    // Символические ссылки не обходим вовсе: они могут вести наружу каталога, а
    // правку по такому пути защита всё равно отклонит — показывать нечестно.
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    seen += 1;
    const dir = join(target.skillsDir, entry.name);
    if (existsSync(join(dir, SKILL_FILE_NAME))) skills.push(dir);
    else ignored.push(dir);
  }

  return { skills, ignored };
}

function summarize(target: ProviderSkillsTarget, skillDir: string): ProviderSkillSummary {
  const fullPath = join(skillDir, SKILL_FILE_NAME);
  const dirName = basename(skillDir);
  const base = {
    dirName,
    path: toRelative(target, fullPath),
    fullPath,
    size: fileSizeOf(fullPath),
  };

  try {
    const { fields } = readOpencodeSkill(readTextFile(fullPath));
    return {
      ...base,
      name: fields.name,
      description: fields.description,
      frontmatterOk: true,
      nameMismatch: fields.name !== dirName,
    };
  } catch (error) {
    if (error instanceof SkillFormatError) {
      // Имя папки — единственное, что известно наверняка у нечитаемой шапки.
      return {
        ...base,
        name: dirName,
        frontmatterOk: false,
        problem: error.problem,
        nameMismatch: false,
      };
    }
    throw error;
  }
}

/** Сводка раздела: скиллы, папки без `SKILL.md` и путь каталога. */
export function readProviderSkillsInfo(target: ProviderSkillsTarget): ProviderSkillsInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    skillsDir: target.skillsDir,
    dirExists: existsSync(target.skillsDir),
    externalDirs: target.externalDirs.map((path) => ({ path, exists: existsSync(path) })),
  };

  if (!base.dirExists) return { ...base, skills: [], ignored: [], readOnly: false };

  try {
    const walked = walkSkillsDir(target);
    return {
      ...base,
      skills: walked.skills
        .map((dir) => summarize(target, dir))
        .sort((a, b) => a.dirName.localeCompare(b.dirName)),
      ignored: walked.ignored
        .map((dir): ProviderSkillsIgnoredDir => ({ dirName: basename(dir), fullPath: dir }))
        .sort((a, b) => a.dirName.localeCompare(b.dirName)),
      readOnly: false,
    };
  } catch (error) {
    // Каталог не читается (права, гонка с удалением) — раздел на чтение, но
    // писать в него вслепую нельзя: fail-closed.
    return {
      ...base,
      skills: [],
      ignored: [],
      readOnly: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Прочитать ОДИН скилл: поля шапки отдельно от markdown-тела. Шапка не разобрана
 * (или её нет) → файл отдаётся ЦЕЛИКОМ как тело с пометкой `readOnly` —
 * прочитать можно, переписать нельзя.
 */
export function readProviderSkill(target: ProviderSkillsTarget, rawPath: string): ProviderSkill {
  const fullPath = resolveSkillPath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new SkillNotFoundError(rawPath);
  }
  if (fileSizeOf(fullPath) > SECTION_MAX_FILE_BYTES) {
    throw new SkillNotEditableError(
      rawPath,
      'malformed',
      `Файл ${fullPath} слишком большой для правки в панели.`,
    );
  }

  const text = readTextFile(fullPath);
  const dirName = basename(dirname(fullPath));
  const base = { path: toRelative(target, fullPath), fullPath, dirName };

  try {
    const skill = readOpencodeSkill(text);
    return {
      ...base,
      name: skill.fields.name,
      description: skill.fields.description,
      body: skill.body,
      otherKeys: skill.otherKeys,
      readOnly: false,
    };
  } catch (error) {
    if (error instanceof SkillFormatError) {
      return {
        ...base,
        name: dirName,
        description: '',
        body: text,
        otherKeys: [],
        readOnly: true,
        problem: error.problem,
      };
    }
    throw error;
  }
}
