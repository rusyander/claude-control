import { useEffect } from 'react';
import type { AgentRun } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';
import { autoGrantDraft, decideCorePermit, sendInOrder } from '../lib/corePermit';

type CoreTaskRef = NonNullable<AgentRun['coreTask']>;

/** Задачи, которым это окно уже выдало грант: ход за ходом одной задачи — один грант. */
const granted = new Set<string>();

/**
 * Задача ядра чата по его ключам (временный `new-…`, номер разговора). Прогон законченного хода
 * стор убирает, как только ответ лёг в историю (`useRunLifecycle`), — а с ним и `coreTask`; без
 * этой памяти тумблер, щёлкнутый между ходами, ждал бы следующего хода, и его первый вызов модели
 * успевал бы спросить право.
 */
const knownTasks = new Map<string, CoreTaskRef>();

/** Запомнить задачу ядра прогона под ключом чата и номером разговора. */
export function rememberCoreTask(
  chatId: string | undefined,
  run: Pick<AgentRun, 'coreTask' | 'sessionId'>,
): void {
  if (!run.coreTask) return;
  for (const key of [chatId, run.sessionId]) if (key) knownTasks.set(key, run.coreTask);
}

/** Задача ядра чата: идущего прогона, а нет его — последняя, что видело это окно. */
export function coreTaskOf(
  chatId: string | undefined,
  run: Pick<AgentRun, 'coreTask' | 'sessionId'>,
): CoreTaskRef | undefined {
  return (
    run.coreTask ??
    (chatId ? knownTasks.get(chatId) : undefined) ??
    (run.sessionId ? knownTasks.get(run.sessionId) : undefined)
  );
}

/**
 * Автоподтверждение чата `/chat`, идущего задачей ядра (этап 10, F2b): тумблер включён — окно само
 * выдаёт задаче грант правки всему репозиторию командой ядра с числом страницы, и вопросы права
 * пункта 5 не возникают. Сервер панели этого сделать не может: грант у ядра — human-strict
 * (06 §Authority). Вопрос, поднятый раньше гранта (первый вызов модели обогнал команду), — тем же
 * окном отвечается «Разрешить».
 */
export function useCoreAutoGrant(
  chatId: string | undefined,
  run: Pick<AgentRun, 'coreTask' | 'permissions' | 'sessionId'>,
  enabled: boolean,
): void {
  rememberCoreTask(chatId, run);
  const task = coreTaskOf(chatId, run);
  const taskId = task?.taskId;
  const project = task?.project;
  useEffect(() => {
    if (!enabled || !taskId || !project || granted.has(taskId)) return;
    granted.add(taskId);
    void sendInOrder([autoGrantDraft(taskId, project)]).then((refused) => {
      if (refused === null) return;
      granted.delete(taskId);
      toast.error(i18n.t('chat.coreGrantRefused', { reason: refused }));
    });
  }, [enabled, taskId, project]);

  const raced = run.permissions.filter((p) => p.core?.options.includes('grant'));
  const racedKey = raced.map((p) => p.toolUseId).join(',');
  useEffect(() => {
    if (!enabled) return;
    for (const permission of raced) {
      if (permission.core) void decideCorePermit(permission.core, 'allow');
    }
    // Состав висящих вопросов — ключ; сам массив пересобирается каждым кадром.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, racedKey]);
}
