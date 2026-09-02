import type { FastifyInstance } from 'fastify';
import type { RuleDraft } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import { readRules, saveRule, deleteRule } from '../../domains/rules.ts';
import {
  resolveInstructionsTarget,
  readInstructionsInfo,
  writeInstructions,
} from '../../domains/instructions.ts';
import { done } from '../write-result.ts';
import type { ClaudePaths } from './shared.ts';

const SECTION_UNSUPPORTED = {
  error: 'section_unsupported',
  message: 'У активного провайдера нет раздела глобальных инструкций.',
} as const;

/**
 * Правила (карточки CLAUDE.md) и тот же файл целиком.
 *
 * Раздел «Правила» разбирает файл на карточки, но там видно не всё: шапка,
 * произвольные секции и форматирование остаются за кадром. `/api/claude-md` —
 * файл целиком, как его читает сам CLI, с правкой и резервной копией перед
 * записью. Файл берётся у активного провайдера: Claude→CLAUDE.md,
 * Codex→AGENTS.md, Gemini→GEMINI.md. Провайдер без задокументированного файла
 * инструкций (globalInstructions ≠ ready) → 4xx, путь не угадываем (fail-closed).
 */
export function registerRuleRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  // --- Правила (CLAUDE.md) ---
  app.get('/api/rules', () => readRules(paths().claudeMd, ctx.store));

  /**
   * Id правила выводится из заголовка при каждом разборе, поэтому у клиента он
   * легко устаревает (переименование в соседней вкладке, удаление тёзки). С
   * устаревшим id `saveRule` создавал бы НОВОЕ правило-дубликат, а
   * `deleteRule` — молча переписывал файл, оставляя лишнюю копию и запись в
   * истории. Неизвестный id — 404, файл не трогаем.
   */
  const NOT_FOUND = { error: 'rule_not_found', message: 'Правило не найдено' } as const;
  const hasRule = (id: string): boolean =>
    readRules(paths().claudeMd, ctx.store).some((rule) => rule.id === id);

  app.put<{ Params: { id: string }; Body: RuleDraft }>('/api/rules/:id', (request, reply) => {
    if (!hasRule(request.params.id)) return reply.code(404).send(NOT_FOUND);
    return done(
      saveRule(paths().claudeMd, request.params.id, request.body, ctx.store, ctx.backupDir),
    );
  });

  app.post<{ Body: RuleDraft }>('/api/rules', (request) =>
    done(saveRule(paths().claudeMd, '', request.body, ctx.store, ctx.backupDir)),
  );

  app.delete<{ Params: { id: string } }>('/api/rules/:id', (request, reply) => {
    if (!hasRule(request.params.id)) return reply.code(404).send(NOT_FOUND);
    // След в state.json снимаем ДО удаления: `deleteRule` сдвигает id уцелевших
    // тёзок («foo-2» → «foo»), и после него отметки удалённого «foo» уже
    // принадлежали бы выжившему правилу.
    ctx.store.removeEntity('rule', request.params.id);
    return done(deleteRule(paths().claudeMd, request.params.id, ctx.store, ctx.backupDir));
  });

  // --- Глобальные инструкции целиком (универсальны по активному провайдеру) ---
  app.get('/api/claude-md', (_request, reply) => {
    const target = resolveInstructionsTarget(ctx.store, paths().claudeMd);
    if (!target) return reply.code(400).send(SECTION_UNSUPPORTED);
    return readInstructionsInfo(target);
  });

  app.put<{ Body: { content?: unknown } }>('/api/claude-md', (request, reply) => {
    const target = resolveInstructionsTarget(ctx.store, paths().claudeMd);
    if (!target) return reply.code(400).send(SECTION_UNSUPPORTED);

    const content = (request.body ?? {}).content;
    // Различаем «намеренно пустой файл» ('') и «поля content нет / оно не строка».
    // Раньше писали `content ?? ''`: запрос без поля затирал файл пустотой.
    // Пустая строка — валидна (осознанная очистка), всё нестроковое — отказ.
    if (typeof content !== 'string') {
      return reply.code(400).send({
        error: 'invalid_content',
        message: 'Поле content обязано быть строкой (пустая строка допустима).',
      });
    }

    return done(writeInstructions(target, content, ctx.backupDir));
  });
}
