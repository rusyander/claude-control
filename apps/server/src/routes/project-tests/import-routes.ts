import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { exportGroup, type ExportFormat } from '../../domains/project-tests/export-cases.ts';
import { exportRun, type RunExportFormat } from '../../domains/project-tests/export-run.ts';
import { importCases } from '../../domains/project-tests/import-cases.ts';
import { importManualCases } from '../../domains/project-tests/import-manual-cases.ts';
import { importResults } from '../../domains/project-tests/import-results.ts';
import { guard, requireRoot } from './shared.ts';

/**
 * Ввод и вывод тестового хозяйства: результаты из CI, кейсы из таблиц, выгрузка.
 *
 * Отдельный модуль, а не строки в общем файле маршрутов: у импорта своя цена
 * ошибки. Сюда приходит чужой файл целиком, и любой из них может быть битым,
 * пустым или просто не тем — поэтому каждый ответ здесь обязан называть
 * причину словами, а не отдавать 500.
 *
 * Контекст сервера не нужен: раздел работает по пути проекта, как файлы и git,
 * — вкладку открывают на любом каталоге, и в реестре панели его может не быть.
 * Параметр объявлен ради общей формы регистрации (`RouteRegistrar`).
 */
export function registerProjectTestsImportRoutes(app: FastifyInstance, _ctx: ServerContext): void {
  /**
   * Результаты прогона из CI → статусы кейсов. Отчёт приходит содержимым
   * (`content`) или путём внутри проекта (`file`); для Allure путь может
   * указывать на каталог с `*-result.json`.
   */
  app.post<{
    Body: {
      path?: string;
      format?: string;
      content?: string;
      file?: string;
      environmentId?: string;
    };
  }>('/api/project-tests/import/results', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;

    const format = request.body?.format;
    if (format !== 'junit' && format !== 'playwright' && format !== 'allure') {
      return reply.code(400).send({
        message: 'Формат результатов: junit, playwright или allure.',
        messageCode: 'import-results-format',
      });
    }

    return guard(reply, () =>
      importResults(root, {
        format,
        content: request.body?.content,
        file: request.body?.file,
        environmentId: request.body?.environmentId?.trim() || undefined,
      }),
    );
  });

  /**
   * Кейсы из таблицы в выбранную группу. Книга Excel приходит в base64:
   * тело запроса — JSON, байты в него иначе не положить.
   *
   * `markdown` — единственный формат, у которого нет ни файла, ни содержимого:
   * ручные кейсы уже лежат в самом проекте, и `file` для него означает КАТАЛОГ
   * (по умолчанию `QA`), а не один файл.
   */
  app.post<{
    Body: { path?: string; groupId?: string; format?: string; content?: string; file?: string };
  }>('/api/project-tests/import/cases', (request, reply) => {
    const root = requireRoot(request.body?.path, reply);
    if (!root) return reply;

    const format = request.body?.format;
    if (
      format !== 'csv' &&
      format !== 'xlsx' &&
      format !== 'testrail-csv' &&
      format !== 'markdown'
    ) {
      return reply.code(400).send({
        message: 'Формат кейсов: csv, xlsx, testrail-csv или markdown.',
        messageCode: 'import-cases-format',
      });
    }
    const groupId = request.body?.groupId?.trim();
    if (!groupId)
      return reply.code(400).send({
        message: 'Не указана группа, куда класть кейсы.',
        messageCode: 'import-group-unspecified',
      });

    if (format === 'markdown') {
      return guard(reply, () => importManualCases(root, { groupId, dir: request.body?.file }));
    }

    return guard(reply, () =>
      importCases(root, {
        format,
        groupId,
        content: request.body?.content,
        file: request.body?.file,
      }),
    );
  });

  /**
   * Отчёт по одному прогону файлом — то, что уходит наружу.
   *
   * Отдельный маршрут от выгрузки кейсов: там срез набора «как он выглядит
   * сейчас», здесь событие «вот что было в этот раз».
   */
  app.get<{ Querystring: { path?: string; id?: string; format?: string } }>(
    '/api/project-tests/run/export',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      const format = (request.query.format ?? 'md') as RunExportFormat;
      // `html` — та же вёрстка, из которой печатается PDF: она нужна и сама по
      // себе, когда браузера для печати на машине нет, а показать отчёт человеку
      // всё равно надо.
      if (format !== 'md' && format !== 'csv' && format !== 'html') {
        return reply.code(400).send({
          message: 'Формат отчёта по прогону: md, csv или html.',
          messageCode: 'export-run-format',
        });
      }
      const id = request.query.id?.trim();
      if (!id)
        return reply
          .code(400)
          .send({ message: 'Не указан прогон.', messageCode: 'run-unspecified' });

      return guard(reply, () => {
        const file = exportRun(root, id, format);
        return reply
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .type(file.contentType)
          .send(file.body);
      });
    },
  );

  /** Выгрузка группы файлом: таблица, документ или книга Excel. */
  app.get<{ Querystring: { path?: string; groupId?: string; format?: string } }>(
    '/api/project-tests/export',
    (request, reply) => {
      const root = requireRoot(request.query.path, reply);
      if (!root) return reply;

      const format = (request.query.format ?? 'csv') as ExportFormat;
      if (format !== 'csv' && format !== 'md' && format !== 'xlsx') {
        return reply.code(400).send({
          message: 'Формат выгрузки: csv, md или xlsx.',
          messageCode: 'export-cases-format',
        });
      }
      const groupId = request.query.groupId?.trim();
      if (!groupId)
        return reply.code(400).send({
          message: 'Не указана группа для выгрузки.',
          messageCode: 'export-group-unspecified',
        });

      return guard(reply, () => {
        const file = exportGroup(root, groupId, format);
        return reply
          .header('Content-Disposition', `attachment; filename="${file.filename}"`)
          .type(file.contentType)
          .send(file.body);
      });
    },
  );
}
