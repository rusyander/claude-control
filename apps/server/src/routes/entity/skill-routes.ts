import type { FastifyInstance } from 'fastify';
import type { SkillDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readSkills,
  saveSkill,
  deleteSkill,
  renameSkill,
  SkillExistsError,
} from '../../domains/skills.ts';
import { readCommands } from '../../domains/commands.ts';
import { done } from '../write-result.ts';
import type { ClaudePaths } from './shared.ts';

/**
 * Скиллы (папки в skills/) и сводный список слэш-команд.
 *
 * Файлы внутри скилла живут на общих ресурсных маршрутах
 * (`/api/resources/skill/:id/file`) — там же, где файлы остальных видов.
 * Отдельного набора для скиллов больше нет: две почти одинаковые реализации
 * расходились, и правка попадала не туда, куда ходит интерфейс.
 */
export function registerSkillRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  app.get('/api/skills', () => readSkills(paths().skills, ctx.store));

  /**
   * Слэш-команды активного провайдера — сводный список того, что вызывается
   * через `/`. Только чтение: правится команда там, где живёт (скилл — в разделе
   * скиллов, плагин — в разделе плагинов). Встроенных команд CLI здесь нет:
   * файла у них не существует, их каталог ведёт клиент.
   */
  app.get('/api/commands', () => readCommands(paths(), ctx.store));

  app.post<{ Body: SkillDraft }>('/api/skills', (request, reply) => {
    try {
      return done(saveSkill(paths().skills, null, request.body, ctx.backupDir));
    } catch (error) {
      // Имя занято выключенным скиллом: молча писать поверх — потеря чужого
      // скилла, поэтому отвечаем конфликтом и оставляем решение человеку.
      if (error instanceof SkillExistsError) {
        return reply.code(409).send({ error: 'skill_exists', message: error.message });
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: SkillDraft }>('/api/skills/:id', (request) =>
    done(saveSkill(paths().skills, request.params.id, request.body, ctx.backupDir)),
  );

  app.delete<{ Params: { id: string } }>('/api/skills/:id', (request) => {
    const backupPath = deleteSkill(paths().skills, request.params.id, ctx.backupDir);
    // Тот же след, что и у остальных видов: состав групп и отметки выключения
    // ключуются именем папки, и новый скилл с тем же именем наследовал бы их.
    ctx.store.removeEntity('skill', request.params.id);

    return done(backupPath);
  });

  // Переименование скилла: имя папки — это идентификатор, поэтому меняется папка,
  // а отметки в state.json (выключение, группы) переезжают на новый id. Тело —
  // {newId} (или синоним {newName}). Ошибки domain несут код: занятое/пустое имя
  // → 400, несуществующий скилл → 404.
  app.post<{ Params: { id: string }; Body: { newId?: string; newName?: string } }>(
    '/api/skills/:id/rename',
    (request, reply) => {
      const newId = request.body?.newId ?? request.body?.newName ?? '';

      try {
        return done(
          renameSkill(paths().skills, request.params.id, newId, ctx.store, ctx.backupDir),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: string }).code;
        return reply
          .code(code === 'not_found' ? 404 : 400)
          .send({ error: 'rename_failed', message });
      }
    },
  );
}
