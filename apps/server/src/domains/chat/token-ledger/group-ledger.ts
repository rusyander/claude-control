import { existsSync, readFileSync } from 'node:fs';
import type {
  ChatLink,
  SplitPlanGroupRecord,
  SplitPlanRecord,
  SplitTokenLedger,
} from '../../../lib/app-store/app-store.types.ts';
import { findTranscript, streamLines } from '../ChatTranscriptFile/ChatTranscriptFile.ts';
import {
  DEFAULT_PROVIDER_ID,
  getProvider,
  isKnownProviderId,
} from '../../../providers/registry.ts';
import { sectionTargets } from '../../portability/project/project.ts';
import { measureClaudeGroup, measureForeignGroup } from './token-ledger.ts';

/** Что счёту группы нужно от панели: связи звеньев и каталог транскриптов. */
export interface GroupLedgerDeps {
  links: () => Record<string, ChatLink>;
  projectsDir: () => string;
  now?: () => Date;
}

/**
 * Разговоры группы: её первый чат и каждое звено цепочки — у звена своя
 * связь с тем же родителем и номером группы. Ключ связи бывает временным
 * (`new-…`), тогда транскрипта под ним нет — его найдёт копия под `sessionId`.
 */
export function groupChatIds(
  links: Record<string, ChatLink>,
  record: SplitPlanRecord,
  group: SplitPlanGroupRecord,
): string[] {
  const ids = new Set<string>(group.chatId ? [group.chatId] : []);
  for (const [chatId, link] of Object.entries(links)) {
    if (link.parentChatId === record.parentChatId && link.groupIndex === group.index) {
      ids.add(chatId);
    }
  }
  return [...ids];
}

function readText(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Файлы инструкций чужого CLI для копии группы: домашний и проектный. */
function foreignInstructionFiles(providerId: string, projectRoot: string | undefined): string[] {
  if (!isKnownProviderId(providerId)) return [];
  const provider = getProvider(providerId);
  const files: string[] = [];
  const global = sectionTargets(provider, 'global').instructionsFile;
  if (global) files.push(global);
  if (projectRoot) {
    try {
      const project = sectionTargets(provider, 'project', { projectRoot }).instructionsFile;
      if (project) files.push(project);
    } catch {
      // Проектного уровня у CLI нет — читает он только домашний файл.
    }
  }
  return files;
}

/** Зависимость `tokenLedger` конвейера разделения (E4). */
export function groupTokenLedger(
  deps: GroupLedgerDeps,
): (
  record: SplitPlanRecord,
  group: SplitPlanGroupRecord,
  provider: string,
) => Promise<SplitTokenLedger | undefined> {
  return async (record, group, provider) => {
    const at = (deps.now?.() ?? new Date()).toISOString();
    if (provider !== DEFAULT_PROVIDER_ID) {
      return measureForeignGroup(foreignInstructionFiles(provider, group.path), readText, at);
    }
    const dir = deps.projectsDir();
    const transcripts = new Set<string>();
    for (const chatId of groupChatIds(deps.links(), record, group)) {
      const path = findTranscript(dir, chatId);
      if (path) transcripts.add(path);
    }
    return measureClaudeGroup([...transcripts], streamLines, at);
  };
}
