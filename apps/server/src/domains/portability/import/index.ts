import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import { agentEnvironment } from '../canon.ts';
import { sectionTargets } from '../project.ts';
import { UnknownImportProviderError, type ImportDeps, type Importer } from '../types.ts';
import { importAiderEnvironment } from './aider.ts';
import { importClaudeEnvironment } from './claude.ts';
import { importCodexEnvironment } from './codex.ts';
import { importContinueEnvironment } from './continue.ts';
import { importCursorEnvironment } from './cursor.ts';
import { importGeminiEnvironment } from './gemini.ts';
import { importGooseEnvironment } from './goose.ts';
import { importKimiEnvironment } from './kimi.ts';
import { importOpencodeEnvironment } from './opencode.ts';
import { importQwenEnvironment } from './qwen.ts';

/**
 * Реестр импортёров: идентификатор провайдера → его файл.
 *
 * Это ЕДИНСТВЕННОЕ место, где идентификатор CLI решает, какой код позвать. Ни в
 * одном импортёре нет ветки `if (provider === …)`: различие провайдеров
 * выражается каталогом возможностей, а девять чужих CLI собраны одними и теми же
 * этапами `sections.ts`.
 *
 * Одиннадцатый CLI без своего файла — не молчание и не пустой паспорт, а
 * `UnknownImportProviderError`: сказать «среда пуста» про CLI, которого мы не
 * умеем читать, было бы ложью о среде.
 */
const IMPORTERS: Readonly<Record<string, Importer>> = {
  claude: importClaudeEnvironment,
  codex: importCodexEnvironment,
  gemini: importGeminiEnvironment,
  cursor: importCursorEnvironment,
  qwen: importQwenEnvironment,
  kimi: importKimiEnvironment,
  opencode: importOpencodeEnvironment,
  goose: importGooseEnvironment,
  continue: importContinueEnvironment,
  aider: importAiderEnvironment,
};

/** Заведён ли импортёр для этого провайдера. */
export function hasImporter(providerId: string): boolean {
  return Object.hasOwn(IMPORTERS, providerId);
}

/** Идентификаторы всех заведённых импортёров — по ним же идёт проверка полноты. */
export function importerProviderIds(): string[] {
  return Object.keys(IMPORTERS).sort();
}

/**
 * Собрать паспорт среды одного провайдера на одном уровне.
 *
 * Раздела нет или он не прочитан — это пропуск с причиной внутри паспорта, а не
 * исключение: среда без хуков законна, и падать на ней значило бы соврать о
 * поломке. Исключение здесь ровно одно — провайдер, для которого импортёра нет.
 */
export function importEnvironment(deps: ImportDeps): AgentEnvironment {
  const importer = IMPORTERS[deps.provider.id];
  if (!importer) throw new UnknownImportProviderError(deps.provider.id);

  const { items, skipped, sectionStates } = importer(deps);
  return agentEnvironment({
    provider: deps.provider.id,
    scope: deps.scope,
    root: rootOf(deps),
    items,
    skipped,
    sectionStates,
  });
}

/**
 * Корень среды — корень УРОВНЯ, а не дома (П2.5).
 *
 * Считается тем же резолвером, что и цели разделов: паспорт проекта, назвавший
 * корнем домашний каталог, соврал бы о происхождении каждой своей записи — а
 * этот корень человек читает на экране и видит в имени резервной копии.
 * Провайдер-данные, у которого `paths()` бросает (файлы читаются fail-closed),
 * даёт пустой корень внутри резолвера — это пропуск с причиной, а не падение.
 */
function rootOf(deps: ImportDeps): string {
  return sectionTargets(deps.provider, deps.scope, {
    override: deps.override,
    projectRoot: deps.projectRoot,
  }).root;
}
