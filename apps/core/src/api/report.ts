import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import type { ReportReply } from '@agentdeck/contracts/core/panel-api';
import { finalReportSchema } from '@agentdeck/contracts/core/report';
import { TASK_FILES } from '../journal/journal.types.ts';
import { sha256OfText } from '../journal/line.ts';
import { readBytesSync } from '../platform/safe-io/files.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';
import { readTask } from './task-read.ts';
import { reportOf } from './task-view.ts';

/**
 * `GET /v1/tasks/:id/report` (07:18-22, F7) — итоговый отчёт по ссылке из журнала: строка
 * `report.final` несёт sha256 и длину тела, тело лежит артефактом `<задача>/artifacts/<sha>.json`.
 * Отдаётся только тело, чей sha256 и длина равны ссылке журнала: файл артефакта правится мимо
 * ядра, а журнал защищён цепочкой хэшей — расхождение значит подмену, и панель показывает отказ
 * `report-tampered`, а не чужой текст под видом отчёта задачи (P96).
 */

export function registerReport(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { id: string } }>('/v1/tasks/:id/report', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const taskId = request.params.id;
    const task = readTask(ctx.registry, taskId, reply);
    if (!task) return reply;
    const ref = reportOf(task.state, task.lines);
    if (!ref) return reply.code(404).send(apiError('no-report', 'Итогового отчёта ещё нет'));
    const file = join(ctx.registry.tasksDir, taskId, TASK_FILES.artifacts, `${ref.sha256}.json`);
    const bytes = readBytesSync(file);
    if ('absent' in bytes) {
      return reply.code(404).send(apiError('no-report', 'Тела отчёта нет среди артефактов'));
    }
    if ('unknown' in bytes) {
      return reply.code(500).send(apiError('report-unreadable', bytes.unknown));
    }
    const text = bytes.value.toString('utf8');
    if (bytes.value.length !== ref.bytes || sha256OfText(text) !== ref.sha256) {
      return reply
        .code(409)
        .send(apiError('report-tampered', 'Тело отчёта не совпадает с отпечатком в журнале'));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = undefined;
    }
    const parsed = finalReportSchema.safeParse(raw);
    if (!parsed.success) {
      return reply
        .code(500)
        .send(apiError('report-unreadable', 'Тело отчёта не прошло схему контрактов'));
    }
    const body: ReportReply = { taskId, ref, report: parsed.data };
    return body;
  });
}
