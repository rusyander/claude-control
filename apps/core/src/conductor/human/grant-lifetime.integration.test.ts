import { describe, expect, it } from 'vitest';
import { mapClaudePermission } from '../../adapters/claude/permission.ts';
import { answerHookCall } from '../../api/session-hook.ts';
import { CREATED, openFresh, tempDir } from '../../journal/__fixtures__/journal-harness.ts';
import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { PermitContext } from '../../policy/permit/permit.types.ts';
import { processCommand } from '../commands.ts';
import { commandEnv } from '../commands/__fixtures__/command-env.ts';
import { seedSession, toolDeps } from '../model-tools/__fixtures__/seed.ts';
import { bindingOf } from '../model-tools/binding.ts';
import { handleModelTool } from '../model-tools/model-tools.ts';
import { envelope, HUMAN_PROOF } from '../scenario/__fixtures__/scenario-harness.ts';

/**
 * P85 (06 §grantRequired, фаза 7): правка под `grantRequired` отказана на хуке ядра — пункт
 * человека 5; блокирующий `ask_human` модели вне закрытого списка её НЕ открывает (развилка в
 * отчёт, не ответ человека); грант человека командой с доказательством открывает её посреди
 * шага; следующая задача снова закрыта — грант живёт одну задачу. Дорога настоящая: сырой вызов
 * `Edit` → `answerHookCall` (сопоставление Claude + `decidePermit` + гранты журнала).
 */

const open: LiveTask[] = [];

function context(copyRoot: string): PermitContext {
  return {
    copyRoot,
    ownedPaths: [],
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platformPaths: [tempDir('home-')],
    endpointSources: [],
    grantRequired: [{ globs: ['migrations/**'], ops: ['edit'] }],
    grants: [],
  };
}

async function freshTask() {
  const { task } = await openFresh();
  open.push(task);
  task.append({ kind: 'task.created', actor: 'core', data: CREATED });
  const seeded = seedSession(task, { stepKind: 'work' });
  const bound = bindingOf(task, seeded.sessionId);
  if (!('binding' in bound)) throw new Error(bound.reason);
  const deps = { mapPermission: mapClaudePermission, context: context(tempDir('copy-')) };
  const edit = (file: string) =>
    answerHookCall(task, bound.binding, { tool: 'Edit', input: { file_path: file } }, deps);
  return { task, b: bound.binding, edit, ...seeded };
}

const lastPermit = (task: LiveTask) =>
  readJournalLines(task.dir, task.taskId)
    .lines.filter((l) => l.kind === 'decision' && (l.data as { class: string }).class === 'permit')
    .at(-1)?.data as unknown as { output: { allow: boolean; code?: string; humanPoint?: number } };

describe('P85 grantRequired: blocked at the hook, granted for one task only', () => {
  it('denied at point 5; an off-list blocking ask never unblocks; the grant opens it; a new task is closed again', async () => {
    const a = await freshTask();
    // Модель «просит разрешения» вопросом вне списка: развилка, не пункт и не ожидание.
    const ask = handleModelTool(
      a.task,
      a.b,
      'ask_human',
      {
        question: 'May I edit migrations/1.sql? I will wait for your answer.',
        options: ['yes', 'no'],
        recommendation: 'yes',
        blocking: true,
      },
      toolDeps(),
    );
    expect(ask).toMatchObject({ ok: true, result: { humanPoint: false, blocking: false } });
    expect(a.edit('migrations/1.sql')).toMatchObject({ allow: false });
    expect(lastPermit(a.task).output).toMatchObject({
      allow: false,
      code: 'grant-required',
      humanPoint: 5,
    });
    const asked = readJournalLines(a.task.dir, a.task.taskId).lines.filter(
      (l) => l.kind === 'human.asked',
    );
    expect(asked.map((l) => (l.data as { point: number }).point)).toEqual([5]);
    // Вопрос модели после отказа — тоже не ответ человека: правка закрыта.
    handleModelTool(
      a.task,
      a.b,
      'ask_human',
      { question: 'Unblock me?', options: ['yes'], recommendation: 'yes', blocking: true },
      toolDeps(),
    );
    expect(a.edit('migrations/1.sql')).toMatchObject({ allow: false });

    const granted = await processCommand(
      a.task,
      envelope(a.task, 'grant', { project: 'r1', globs: ['migrations/**'], ops: ['edit'] }),
      HUMAN_PROOF,
      commandEnv(),
    );
    expect(granted).toMatchObject({ status: 'applied' });
    expect(a.edit('migrations/1.sql')).toMatchObject({ allow: true });

    const b = await freshTask();
    expect(b.edit('migrations/1.sql')).toMatchObject({ allow: false });
    expect(lastPermit(b.task).output).toMatchObject({ code: 'grant-required', humanPoint: 5 });
    for (const t of open.splice(0)) t.close();
  });
});
