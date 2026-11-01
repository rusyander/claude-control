import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import {
  copyWithTimes,
  linkOnTheWay,
  listFilesUnder,
  notOlderThan,
  sourceKind,
} from '../../platform/copy-fs.ts';
import { localLayerLists, setIndexFlags, type CopyGitOptions } from '../../platform/copy-git.ts';
import { isCopyEnvFile } from '../../verifier/env/index.ts';
import type { MirrorReport, MirrorSettings } from './copy.types.ts';
import {
  MIRROR_SIZE_LIMIT,
  NEVER_DIRS,
  parseFlagged,
  parsePaths,
  planMirror,
} from './mirror-plan.ts';

/**
 * Перенос локального слоя основной копии в копию единицы (04:97). Каждый файл читается назад
 * (размер); не лёг — второй перенос, не лёг и он — назван на единице (готовность копии, перенесено
 * из панели `copy-readiness.ts` в форме «одна попытка добора»). Флаг git ставится только на
 * перенесённое.
 *
 * `newerOnly` — повторное зеркало (G20, логика панели `mirror-local.ts`): копия, выложенная при
 * оценке, ждёт запуска, а человек тем временем правит свой `.env.local`. Перед первым шагом работы
 * переписывается только то, что в основной копии СВЕЖЕЕ (запас 1 с — точность времени файла у ФС
 * разная); время переносится вместе с файлом, поэтому второй проход ничего не трогает, а правка в
 * самой копии (она новее) не затирается.
 */
/** Имя файла окружения в смысле списка зеркала (`.env`, `.env.*`, `*.env`). */
function envLike(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || name.endsWith('.env');
}

/** Его читает переписывание копии (`rewriteEnv`), или это образец без настоящих адресов. */
function envRewritable(name: string): boolean {
  return isCopyEnvFile(name) || /\.(example|sample|template|dist)$/.test(name);
}

export async function mirrorLocalLayer(
  main: string,
  copy: string,
  settings: MirrorSettings | undefined,
  options: CopyGitOptions = {},
  mode: { newerOnly?: boolean } = {},
): Promise<Fact<MirrorReport>> {
  const lists = await localLayerLists(main, options);
  if (!('value' in lists)) return lists;
  const plan = planMirror({
    flagged: parseFlagged(lists.value.flagged),
    ignored: parsePaths(lists.value.ignored),
    others: parsePaths(lists.value.others),
    modified: parsePaths(lists.value.modified),
    settings,
    listDir: (dir) => listFilesUnder(main, dir, NEVER_DIRS),
  });
  const report: MirrorReport = {
    mirrored: [],
    skipped: [],
    unlisted: plan.unlisted,
    built: plan.built,
    flagsFailed: [],
    ...(mode.newerOnly ? { kept: [] } : {}),
  };
  for (const rel of plan.files) {
    const src = join(main, rel);
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    if (envLike(name) && !envRewritable(name)) {
      // Адрес настоящей базы в `prod.env` переписывание копии не увидит (P84): такой файл не
      // кладётся вовсе и называется на единице.
      report.skipped.push({
        path: rel,
        why: 'env file the copy env rewrite does not read: never mirrored',
      });
      continue;
    }
    const kind = sourceKind(src);
    if (kind.kind === 'absent') {
      report.skipped.push({ path: rel, why: 'absent in the main checkout' });
      continue;
    }
    if (kind.kind === 'link') {
      report.skipped.push({ path: rel, why: 'symbolic link: never followed into the copy' });
      continue;
    }
    if (kind.kind !== 'file') {
      report.skipped.push({ path: rel, why: 'not a regular file' });
      continue;
    }
    const link = linkOnTheWay(copy, rel);
    if (link) {
      report.skipped.push({ path: rel, why: `link in the copy at ${link}: never written through` });
      continue;
    }
    if (kind.size > MIRROR_SIZE_LIMIT) {
      report.skipped.push({
        path: rel,
        why: `larger than 8 MB (${Math.round(kind.size / 1024 / 1024)} MB)`,
      });
      continue;
    }
    if (mode.newerOnly && notOlderThan(src, join(copy, rel))) {
      report.kept?.push(rel);
      continue;
    }
    let copied = copyWithTimes(src, join(copy, rel));
    if (!copied.ok) copied = copyWithTimes(src, join(copy, rel));
    if (copied.ok) report.mirrored.push(rel);
    else report.skipped.push({ path: rel, why: `not read back after two copies: ${copied.why}` });
  }
  const done = new Set(report.mirrored);
  report.flagsFailed = await setIndexFlags(
    copy,
    plan.flagged.filter((entry) => done.has(entry.path)),
    options,
  );
  return { value: report };
}
