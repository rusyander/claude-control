import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readArtifacts,
  readArtifactText,
  readArtifactBinary,
  deleteArtifact,
} from '../../domains/chat/ChatArtifacts.ts';
import { resolveWorkspace } from '../../domains/chat/ChatWorkspace.ts';
import { projectsDir } from './paths.ts';

/** Файл не найден — один и тот же ответ на всё, что нельзя отдать наружу. */
const NOT_FOUND = { message: 'Файл не найден' } as const;

/**
 * Артефакты показываем только у чатов песочницы. Разговор из настоящего
 * проекта работает в его каталоге, и вывалить весь репозиторий списком
 * «созданных файлов» было бы и бесполезно, и опасно.
 */
export function registerChatArtifactRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const artifactDirectory = (chatId: string): string | undefined => {
    const workspace = resolveWorkspace(projectsDir(ctx), chatId, undefined, false);
    return workspace.isSandbox && !workspace.isMissing ? workspace.cwd : undefined;
  };

  app.get<{ Params: { chatId: string } }>('/api/chat/:chatId/artifacts', (request) => {
    const dir = artifactDirectory(request.params.chatId);
    return dir ? readArtifacts(dir) : [];
  });

  app.get<{ Params: { chatId: string }; Querystring: { name: string; as?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = artifactDirectory(request.params.chatId);
      if (!dir) return reply.code(404).send(NOT_FOUND);

      const { name, as } = request.query;

      // Картинки и PDF отдаём как файл — их встраивает сам браузер.
      if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(name)) {
        const binary = readArtifactBinary(dir, name);
        if (!binary) return reply.code(404).send(NOT_FOUND);

        return reply
          .type(name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/*')
          .send(binary);
      }

      // Предпросмотр страницы: содержимое должно прийти разметкой, иначе
      // во врезке покажется JSON вместо самой страницы.
      if (as === 'html') {
        return (
          reply
            .type('text/html; charset=utf-8')
            // Страницу пишет модель — во врезке она изолирована, но и на уровне
            // ответа запрещаем ей тянуть что-либо из сети.
            .header(
              'Content-Security-Policy',
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:",
            )
            .send(readArtifactText(dir, name))
        );
      }

      return { name, content: readArtifactText(dir, name) };
    },
  );

  /**
   * Удаление артефакта. Разрешаем только у чатов песочницы: их файлы —
   * результат работы в отдельной папке панели, и убрать лишнее там безопасно.
   * У разговора из настоящего проекта `artifactDirectory` вернёт `undefined` —
   * трогать рабочее дерево нельзя. Имя файла обезврежено на уровне домена
   * (`deleteArtifact` берёт только basename), выйти за папку чата им не удастся.
   */
  app.delete<{ Params: { chatId: string }; Querystring: { name?: string } }>(
    '/api/chat/:chatId/artifact',
    (request, reply) => {
      const dir = artifactDirectory(request.params.chatId);
      const name = request.query.name;
      if (!dir || !name) return reply.code(404).send(NOT_FOUND);

      return deleteArtifact(dir, name) ? { ok: true } : reply.code(404).send(NOT_FOUND);
    },
  );
}
