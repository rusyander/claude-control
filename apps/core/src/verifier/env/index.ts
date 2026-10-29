import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ServiceEndpoint } from '@agentdeck/contracts/core/records';
import { listDir, readTextFact } from '../../platform/safe-io/files.ts';
import { writeFileAtomic } from '../../platform/safe-io/atomic-write.ts';
import { rewriteEnvText, type EnvLineChange } from './rewrite.ts';

export { classifyEnv, parseEnvText, type EnvSample, type EphemeralHost } from './classify.ts';
export { rewriteEnvText, type EnvLineChange, type EnvTextRewrite } from './rewrite.ts';

/**
 * `rewriteEnv(copyDir, endpoints)` (04:93, P84): файлы окружения копии (`.env`, `.env.*`, кроме
 * образцов) в корне копии и в корнях стеков. Нечитаемый файл — `unknown` всего ответа: копия,
 * в которой один `.env` не проверен, может держать адрес настоящей базы, и зелёный на ней —
 * ложный (вызывающий отвечает `no-verdict(env)`). Настройка копии целиком — отдельный этап (G7).
 */

export interface EnvFileReport {
  file: string; // от корня копии, прямые слеши
  changes: EnvLineChange[];
}

export interface EnvRewriteIo {
  list(dir: string): Fact<string[]>;
  read(path: string): Promise<Fact<string>>;
  write(path: string, text: string): void;
}

const realIo: EnvRewriteIo = {
  list: listDir,
  read: readTextFact,
  write: (path, text) => writeFileAtomic(path, text),
};

export function isCopyEnvFile(name: string): boolean {
  return /^\.env(\.[\w-]+)*$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);
}

export async function rewriteEnv(
  copyDir: string,
  endpoints: readonly ServiceEndpoint[],
  roots: readonly string[] = [''],
  io: EnvRewriteIo = realIo,
): Promise<Fact<EnvFileReport[]>> {
  // Сначала всё прочитать: непрочитанный файл — ничего не записано, половина копии не переписана.
  const rootFiles: { dir: string; files: { name: string; rel: string; text: string }[] }[] = [];
  for (const root of [...new Set(roots)].sort()) {
    const dir = root === '' ? copyDir : join(copyDir, root);
    const names = io.list(dir);
    if ('absent' in names) continue; // корня стека в копии нет — переписывать нечего
    if ('unknown' in names) return { unknown: `env dir '${root || '.'}': ${names.unknown}` };
    const files: { name: string; rel: string; text: string }[] = [];
    for (const name of names.value.filter(isCopyEnvFile).sort()) {
      const rel = root === '' ? name : `${root}/${name}`;
      const text = await io.read(join(dir, name));
      if ('absent' in text) continue; // исчез между листингом и чтением — его и нет
      if ('unknown' in text) return { unknown: `env file '${rel}': ${text.unknown}` };
      files.push({ name, rel, text: text.value });
    }
    rootFiles.push({ dir, files });
  }
  const reports: EnvFileReport[] = [];
  for (const { dir, files } of rootFiles) {
    for (const file of files) {
      // Остальные файлы корня — для пары хост/порт и учётки семейства, разнесённых по файлам.
      const siblings = files.filter((f) => f !== file).map((f) => f.text);
      const next = rewriteEnvText(file.text, endpoints, siblings);
      if (next.changes.length === 0) continue;
      io.write(join(dir, file.name), next.text);
      reports.push({ file: file.rel, changes: next.changes });
    }
  }
  return { value: reports };
}
