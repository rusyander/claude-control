import type { ProjectTestReleaseDocument } from '@agentdeck/contracts';
import type { FastifyInstance } from 'fastify';
import {
  buildRelease,
  gitContext,
  readGroups,
  readRuns,
  releaseNames,
} from '../../domains/project-tests.ts';
import { buildCoverage } from '../../domains/project-tests/coverage.ts';
import {
  exportRelease,
  exportReleasePdf,
  type ReleaseExportFormat,
} from '../../domains/project-tests/export-release.ts';
import { guardAsync, requireRoot, type TestsDeps } from './shared.ts';

/**
 * Готовность вехи одним документом: экран, файл и печать.
 *
 * Отдельный файл от прогонов: прогон — это событие («вот что было в этот
 * раз»), а документ готовности — срез вехи целиком, и собирается он из другого
 * материала: кейсы, требования, дефекты и ВСЕ прогоны вехи разом.
 *
 * Все три маршрута собирают один и тот же документ и различаются только тем, во
 * что его переложить. Второй сборки — «для экрана попроще» — здесь нет
 * намеренно: разойдясь однажды, экран и печать перестанут отвечать одинаково
 * ровно на том вопросе, ради которого документ и заводили.
 *
 * Асинхронные, потому что требования лежат в Jira. Трекер выключен или молчит —
 * документ всё равно 200 с оговоркой: раздел тестов обязан работать без единой
 * интеграции, а «отдавать рано» видно и по непроверенному.
 */
export function registerTestReleaseRoutes(app: FastifyInstance, deps: TestsDeps): void {
  /** Сборка документа — общая для экрана, файла и печати. */
  async function collect(root: string, release: string): Promise<ProjectTestReleaseDocument> {
    const groups = readGroups(root);
    const runs = readRuns(root, 200);
    const coverage = await buildCoverage(
      { store: deps.ctx.store, appDataDir: deps.ctx.location.paths.appData, root },
      groups,
    );
    const { branch, commit } = gitContext(root);
    return buildRelease(release, groups, runs, {
      coverage,
      branch,
      commit,
      now: new Date().toISOString(),
    });
  }

  /**
   * Документ для экрана; без `release` — список вех, которые вообще есть в
   * истории. Вех нет — пустой список, а не ошибка: проект без вех нормален.
   */
  app.get<{ Querystring: { path?: string; release?: string } }>(
    '/api/project-tests/release',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      return guardAsync(reply, async () => {
        const release = request.query.release?.trim();
        if (!release) return { releases: releaseNames(readRuns(root, 200)) };
        return {
          releases: releaseNames(readRuns(root, 200)),
          document: await collect(root, release),
        };
      });
    },
  );

  /** Тот же документ файлом: markdown в MR, HTML — когда печатать нечем. */
  app.get<{ Querystring: { path?: string; release?: string; format?: string } }>(
    '/api/project-tests/release/export',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const release = request.query.release?.trim();
      if (!release) return reply.code(400).send({ message: 'Не указана веха.' });
      const format = (request.query.format ?? 'md') as ReleaseExportFormat;
      if (format !== 'md' && format !== 'html') {
        return reply.code(400).send({ message: 'Формат документа готовности: md или html.' });
      }
      return guardAsync(reply, async () => {
        const file = exportRelease(await collect(root, release), format);
        return reply
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .type(file.contentType)
          .send(file.body);
      });
    },
  );

  /**
   * Печать — тем же путём, что отчёт по прогону: браузер машины
   * (`domains/project-tests/pdf.ts`). Браузера нет — 501 с именем того, что
   * поставить, а не пустой файл.
   */
  app.get<{ Querystring: { path?: string; release?: string } }>(
    '/api/project-tests/release/pdf',
    async (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;
      const release = request.query.release?.trim();
      if (!release) return reply.code(400).send({ message: 'Не указана веха.' });
      return guardAsync(reply, async () => {
        const file = await exportReleasePdf(await collect(root, release));
        return reply
          .type(file.contentType)
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .header('Cache-Control', 'no-store')
          .send(file.body);
      });
    },
  );
}
