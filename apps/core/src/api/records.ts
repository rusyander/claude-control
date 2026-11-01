import type { FastifyInstance } from 'fastify';
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { RecordReply } from '@agentdeck/contracts/core/panel-api';
import type { CheckRecord } from '@agentdeck/contracts/core/records';
import { commonDirSync } from '../platform/git.ts';
import { createRecordStore, loadVerifyKey, RECORD_ID, storeRoot } from '../verifier/store/index.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';
import { readTask } from './task-read.ts';
import { checksOf } from './task-view.ts';

/**
 * `GET /v1/records/:id?task=<taskId>` (07:3-16, F7) — запись проверки, на которой стоит вердикт
 * в ленте задачи. Чтение ПРИВЯЗАНО к задаче: отдаётся только запись, которую журнал этой задачи
 * называет (ссылка проверки в виде задачи или её `check.recorded`). Иначе чужая задача читала бы
 * записи любого репозитория машины, подбирая ключ. Хранилище — у репозиториев задачи
 * (`<common>/agentdeck-verify/v2`), подпись сверяется ключом дома ядра: запись с чужой подписью
 * не отдаётся никогда — это отказ `record-unreadable`, а не «записи нет».
 */

/** Записи, которые называет журнал задачи: ссылки ленты и записанные ею прогоны. */
function recordsNamed(lines: readonly JournalLine[]): Set<string> {
  const named = new Set<string>();
  for (const check of checksOf(lines)) if (check.recordId) named.add(check.recordId);
  for (const line of lines) {
    if (line.kind === 'check.recorded')
      named.add((line as JournalLine<'check.recorded'>).data.recordId);
  }
  return named;
}

type Found = { record: CheckRecord } | { absent: true } | { unknown: string };

function findRecord(repos: readonly { path: string }[], id: string, home: string): Found {
  const roots = new Set<string>();
  const problems: string[] = [];
  for (const repo of repos) {
    const common = commonDirSync(repo.path);
    if ('value' in common) roots.add(storeRoot(common.value));
    else if ('unknown' in common) problems.push(`${repo.path}: ${common.unknown}`);
  }
  if (roots.size === 0)
    return problems.length > 0 ? { unknown: problems.join('; ') } : { absent: true };
  const key = loadVerifyKey(home);
  if (!('value' in key))
    return { unknown: `verify key: ${'unknown' in key ? key.unknown : 'absent'}` };
  for (const root of [...roots].sort()) {
    const fact = createRecordStore({ root, key: key.value }).record(id);
    if ('value' in fact) return { record: fact.value };
    if ('unknown' in fact) problems.push(fact.unknown);
  }
  // Ни в одном хранилище нет, но какое-то не прочиталось: «нет» не доказано.
  return problems.length > 0 ? { unknown: problems.join('; ') } : { absent: true };
}

export function registerRecords(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string }; Querystring: { task?: string } }>(
    '/v1/records/:id',
    async (request, reply) => {
      if (!ctx.requireRead(request, reply)) return reply;
      const { id } = request.params;
      if (!RECORD_ID.test(id)) {
        return reply.code(400).send(apiError('bad-id', 'id записи — <ключ sha256>.<попытка>'));
      }
      const task = readTask(ctx.registry, request.query.task, reply);
      if (!task) return reply;
      if (!recordsNamed(task.lines).has(id)) {
        return reply.code(404).send(apiError('no-record', 'Задача не ссылается на эту запись'));
      }
      const found = findRecord(task.state.created?.repos ?? [], id, ctx.env.layout.root);
      if ('unknown' in found) {
        return reply.code(500).send(apiError('record-unreadable', found.unknown));
      }
      if ('absent' in found) {
        return reply.code(404).send(apiError('no-record', 'Записи нет в хранилище репозитория'));
      }
      const body: RecordReply = { record: found.record };
      return body;
    },
  );
}
