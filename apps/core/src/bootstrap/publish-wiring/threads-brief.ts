import type { BriefSection, StepCtx } from '../../conductor/run/run.types.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import { threadsBrief } from '../../publisher/after/after.ts';
import type { ForgeAccess } from './attempt.ts';
import { unitViewOf } from './unit-view.ts';

const FROM = 'publisher/after';

/**
 * Секция `threads` шага `answer-reviewers`: единственное чтение при открытии MR хранит в журнале
 * только id нитей, тексты читаются у форжа здесь, перед шагом. Не прочиталось — секция называет
 * причину: шаг без текста нитей отвечал бы вслепую, а молчание выглядело бы как «нитей нет».
 */
export async function threadsSection(
  deps: { git: GitOptions; forgeFor: (url: string) => ForgeAccess | null },
  task: LiveTask,
  s: StepCtx,
): Promise<BriefSection | null> {
  if (s.def.kind !== 'answer-reviewers') return null;
  const read = publicationOf(task.state, s.unitId).read;
  if (!read || !read.threads.some((t) => !t.resolved)) return null;
  const unread = (why: string): BriefSection => ({
    id: 'threads',
    text: `Reviewer threads of MR !${read.mrIid} could not be read: ${why}. Do not guess their content.`,
    from: FROM,
  });
  const view = await unitViewOf(task, s.unitId, deps.git);
  if (!('value' in view)) return unread(view.unknown);
  const access = deps.forgeFor(view.value.url);
  if (!access) return unread(`no forge configured for ${view.value.repoKey}`);
  const [me, threads] = await Promise.all([access.port.whoAmI(), access.port.threads(read.mrIid)]);
  if (!('value' in me)) return unread(`forge account: ${'unknown' in me ? me.unknown : 'absent'}`);
  if (!('value' in threads))
    return unread(`threads: ${'unknown' in threads ? threads.unknown : 'absent'}`);
  const text = threadsBrief(threads.value, me.value.username);
  return text ? { id: 'threads', text, from: FROM } : null;
}
