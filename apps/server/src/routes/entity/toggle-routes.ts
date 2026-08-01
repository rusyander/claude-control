import type { FastifyInstance } from 'fastify';
import type { EntityKind } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  applyEntityState,
  rewriteHooks,
  findHook,
  type EntityToggleDeps,
} from '../../domains/entity-toggle.ts';
import { done } from '../write-result.ts';

/** Включение и выключение любой сущности — один маршрут на все виды. */
export function registerEntityToggleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Params: { kind: EntityKind; id: string }; Body: { isEnabled: boolean } }>(
    '/api/entities/:kind/:id/enabled',
    (request) => {
      const { kind } = request.params;
      const { isEnabled } = request.body;
      // Пути и каталог копий берём на обращении, а не при регистрации: каталог
      // конфигурации меняется на лету (`ctx.relocate`).
      const deps: EntityToggleDeps = {
        paths: ctx.location.paths,
        store: ctx.store,
        backupDir: ctx.backupDir,
      };

      // Идентификатор мог прийти в прежнем, позиционном виде — из состава
      // группы или из ссылки, сохранённой до перехода на контентные id.
      // Приводим его к нынешнему, попутно забирая старый: отметку надо снять
      // и с него, иначе она осталась бы висеть навсегда.
      const hook = kind === 'hook' ? findHook(deps, request.params.id) : undefined;
      const id = hook?.id ?? request.params.id;
      const legacyId = hook?.legacyId;

      // Отметку ставим до применения: разбор файлов опирается на неё, чтобы
      // вернуть сущность уже с новым состоянием.
      ctx.store.setEnabled(kind, id, isEnabled, legacyId);

      // Применяем не то, что попросили, а итог: сущность, погашенную группой,
      // одиночный переключатель включить не может — иначе состояние в панели
      // разошлось бы с состоянием группы.
      const effective = !ctx.store.isDisabled(kind, id, legacyId);
      const { needsHookRewrite } = applyEntityState(deps, kind, id, effective);

      return done(needsHookRewrite ? rewriteHooks(deps) : undefined);
    },
  );
}
