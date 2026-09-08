import type { ProjectTestManualResultInput, ProjectTestStatus } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  acceptBaseline,
  compareBaseline,
  readBaselines,
  saveAttachment,
} from '../../domains/project-tests.ts';
import { assertUnlocked, guard, idList, requireRoot, type TestsDeps } from './shared.ts';

/** Статусы прохода. Список повторён здесь нарочно: приводить чужой ввод к
 * «unknown» молча нельзя — человек должен увидеть отказ, а не потерянный
 * результат. */
const STATUSES: ProjectTestStatus[] = ['unknown', 'passed', 'failed', 'skipped', 'blocked'];

/**
 * Ручной прогон: кейсы проходит ЧЕЛОВЕК, панель записывает.
 *
 * Без этого раздела панель годится только агенту: до сих пор кейсы мог пройти
 * лишь он, а тестировщик смотрел на чужие галочки. Каждый отмеченный результат
 * уходит на диск сразу — и в файл кейса, и в запись прогона, поэтому закрытая
 * вкладка или переход на телефон не стоят отмеченного.
 */
export function registerTestManualRoutes(app: FastifyInstance, deps: TestsDeps): void {
  const now = (): string => new Date().toISOString();

  /** Начать ручной прогон по плану, группе или отмеченным кейсам. */
  app.post<{
    Body: {
      path?: string;
      planId?: string;
      groupId?: string;
      caseIds?: string[];
      environmentId?: string;
    };
  }>('/api/project-tests/manual/start', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    return guard(reply, () => ({
      session: deps.manual.start(
        root,
        {
          planId: request.body?.planId || undefined,
          groupId: request.body?.groupId || undefined,
          caseIds: idList(request.body?.caseIds),
          environmentId: request.body?.environmentId || undefined,
        },
        now(),
        (groupId) => assertUnlocked(deps, root, groupId),
      ),
    }));
  });

  /** Идущая сессия проекта — по ней страница восстанавливается после F5. */
  app.get<{ Querystring: { path?: string } }>('/api/project-tests/manual', (request, reply) => {
    const root = requireRoot(request.query.path, reply);
    if (!root) return reply;
    return { session: deps.manual.get(root) };
  });

  /** Отметить результат прохода. Пишется сразу: и в кейс, и в историю. */
  app.post<{ Body: { path?: string } & Partial<ProjectTestManualResultInput> }>(
    '/api/project-tests/manual/result',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const body = request.body;
      if (!body?.runId || !body.pointId) {
        return reply.code(400).send({ message: 'Не указано, какой проход отмечается.' });
      }
      const status = body.status;
      if (!status || !STATUSES.includes(status)) {
        return reply.code(400).send({ message: 'Неизвестный статус результата.' });
      }
      return guard(reply, () => ({
        session: deps.manual.record(
          root,
          {
            runId: body.runId ?? '',
            pointId: body.pointId ?? '',
            status,
            statusId: body.statusId,
            note: body.note,
            steps: body.steps,
            attachments: body.attachments,
            durationMs: body.durationMs,
          },
          now(),
        ),
      }));
    },
  );

  /** Завершить прогон: запись закрывается, отчёт остаётся. */
  app.post<{ Body: { path?: string; runId?: string } }>(
    '/api/project-tests/manual/finish',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      return guard(reply, () => ({
        session: deps.manual.finish(root, String(request.body?.runId ?? ''), now()),
      }));
    },
  );

  /** Бросить прогон. Отмеченное остаётся — стирать чужую работу незачем. */
  app.post<{ Body: { path?: string; runId?: string } }>(
    '/api/project-tests/manual/cancel',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      deps.manual.cancel(root, String(request.body?.runId ?? ''), now());
      return { session: deps.manual.get(root) };
    },
  );

  /**
   * Доказательство к кейсу: скриншот или лог.
   *
   * Приходит base64 в JSON, а не multipart: панель уже шлёт всё телом JSON, и
   * ради одной кнопки заводить второй способ загрузки не за что. Потолок и
   * список расширений держит домен.
   */
  app.post<{ Body: { path?: string; caseId?: string; name?: string; contentBase64?: string } }>(
    '/api/project-tests/attachment',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const { caseId, name, contentBase64 } = request.body ?? {};
      if (!caseId || !name || !contentBase64) {
        return reply.code(400).send({ message: 'Нужен кейс, имя файла и содержимое.' });
      }
      return guard(reply, () => ({
        file: saveAttachment(root, caseId, name, contentBase64, now()),
      }));
    },
  );

  /**
   * Снимок на сравнение с эталоном.
   *
   * Эталона ещё нет — снимок им и становится; не сошлось — рядом ложатся снимок
   * и картинка-разница, а решение принимает человек кнопкой «Принять эталон».
   * Сами картинки клиент тянет обычным `/api/project-files/raw`: гнать PNG
   * через JSON значит раздуть его в base64 и лишить браузер своего показа.
   */
  app.post<{
    Body: {
      path?: string;
      caseId?: string;
      pointId?: string;
      contentBase64?: string;
      maxDiffRatio?: number;
    };
  }>('/api/project-tests/baseline', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;
    const { caseId, pointId, contentBase64, maxDiffRatio } = request.body ?? {};
    if (!caseId || !pointId || !contentBase64) {
      return reply.code(400).send({ message: 'Нужен кейс, тест-поинт и сам снимок.' });
    }
    if (
      maxDiffRatio !== undefined &&
      (typeof maxDiffRatio !== 'number' || maxDiffRatio < 0 || maxDiffRatio > 1)
    ) {
      return reply.code(400).send({ message: 'Порог расхождения — доля от 0 до 1.' });
    }
    return guard(reply, () => ({
      baseline: compareBaseline(root, {
        caseId,
        pointId,
        png: Buffer.from(contentBase64, 'base64'),
        maxDiffRatio,
        now: now(),
      }),
    }));
  });

  /** Принять последний снимок эталоном — единственный способ его сменить. */
  app.post<{ Body: { path?: string; caseId?: string; pointId?: string } }>(
    '/api/project-tests/baseline/accept',
    (request, reply) => {
      const root = requireRoot(request.body?.path, reply);
      if (!root) return reply;
      const { caseId, pointId } = request.body ?? {};
      if (!caseId || !pointId) {
        return reply.code(400).send({ message: 'Нужен кейс и тест-поинт.' });
      }
      return guard(reply, () => ({ baseline: acceptBaseline(root, caseId, pointId, now()) }));
    },
  );

  /** Эталоны проекта: все или одного кейса — по ним рисуется «было/стало». */
  app.get<{ Querystring: { path?: string; caseId?: string } }>(
    '/api/project-tests/baselines',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guard(reply, () => ({
        baselines: readBaselines(root, request.query.caseId?.trim() || undefined),
      }));
    },
  );
}
