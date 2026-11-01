import type { ForgePort } from '@agentdeck/contracts/core/forge';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { buildMrDescription } from '../../publisher/mr/description.ts';
import { syncMrBody } from '../../publisher/mr/mr.ts';
import type { OutboxPort } from '../../publisher/push/push.types.ts';
import { unitMessageOf } from './compose.ts';

/**
 * Описание MR единицы из журнала (05 §Push and MR): заголовок задачи, требования с вердиктом,
 * связанные MR остальных единиц (P76). Детерминировано по журналу: то же состояние — тот же хеш
 * тела, поэтому правка тела соседнего MR уходит только когда появился новый MR.
 */

export function describeUnit(task: LiveTask, unitId: string): { title: string; body: string } {
  const st = task.state;
  const linked = Object.keys(st.units)
    .filter((id) => id !== unitId)
    .map((id) => ({ id, mr: publicationOf(st, id).mr }))
    .filter((x) => x.mr !== null)
    .map((x) => ({ name: st.units[x.id]?.name ?? x.id, url: x.mr!.url }));
  return buildMrDescription({
    title: unitMessageOf(task, unitId),
    summary: '',
    requirements: Object.values(st.requirements)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => ({ text: r.text, verdict: r.verdict, checks: [] })),
    linked,
    testing: [],
  });
}

/** Тела уже открытых MR остальных единиц — с новым списком связанных (правка через outbox). */
export async function syncSiblingBodies(
  task: LiveTask,
  deps: { forge: ForgePort; outbox: OutboxPort },
  url: string,
  repoKey: string,
): Promise<void> {
  // Порт форжа — одного репозитория; MR единиц другого репозитория правит их собственная попытка.
  for (const [id, unit] of Object.entries(task.state.units)) {
    if (unit.repoKey !== repoKey) continue;
    const mr = publicationOf(task.state, id).mr;
    if (!mr) continue;
    // MR, который создала не эта задача (ответы ревьюерам получили его личность от задачи-
    // источника, 05:77): заголовок и описание — того, кто его открыл; ответ их не переписывает.
    if (!Object.hasOwn(task.state.actions, mr.actionId)) continue;
    const d = describeUnit(task, id);
    await syncMrBody(deps, { url, iid: mr.mrIid, title: d.title, body: d.body });
  }
}
