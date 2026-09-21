import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';
import { ProjectLevelUnsupportedError, projectSupport } from '../project.ts';
import { emitToAider } from './aider.ts';
import { emitToClaude } from './claude.ts';
import { emitToCodex } from './codex.ts';
import { emitToContinue } from './continue.ts';
import { emitToCursor } from './cursor.ts';
import { emitToGemini } from './gemini.ts';
import { emitToGoose } from './goose.ts';
import { emitToKimi } from './kimi.ts';
import { emitToOpencode } from './opencode.ts';
import { emitToQwen } from './qwen.ts';
import { UnknownEmitProviderError, type EmitDeps, type EmitPlan, type Emitter } from './types.ts';

/**
 * Реестр эмиттеров: идентификатор провайдера-ЦЕЛИ → его файл.
 *
 * Это ЕДИНСТВЕННОЕ место половины, где идентификатор CLI решает, какой код
 * позвать. Ни в одном эмиттере нет ветки `if (provider === …)`: различие
 * провайдеров выражается каталогом возможностей, а девять чужих CLI собраны
 * одними и теми же этапами `sections.ts`.
 *
 * Цели, которой здесь нет, план переноса не строится вовсе —
 * `UnknownEmitProviderError`: сказать «переносить нечего» про CLI, писать в
 * который мы не умеем, было бы ложью о переносе, а не пустым планом.
 */
const EMITTERS: Readonly<Record<string, Emitter>> = {
  claude: emitToClaude,
  codex: emitToCodex,
  gemini: emitToGemini,
  cursor: emitToCursor,
  qwen: emitToQwen,
  kimi: emitToKimi,
  opencode: emitToOpencode,
  goose: emitToGoose,
  continue: emitToContinue,
  aider: emitToAider,
};

/** Заведён ли эмиттер для этой цели. */
export function hasEmitter(providerId: string): boolean {
  return Object.hasOwn(EMITTERS, providerId);
}

/** Идентификаторы всех заведённых эмиттеров — по ним же идёт проверка полноты. */
export function emitterProviderIds(): string[] {
  return Object.keys(EMITTERS).sort();
}

/**
 * Построить план переноса канона в одну цель.
 *
 * План НИЧЕГО не пишет: каждая правка лежит описанием с двумя способами её
 * выполнить, и решает, применять ли, вызывающий (П2.3 сначала показывает
 * человеку дифф каждого файла).
 */
export function emitEnvironment(env: AgentEnvironment, deps: EmitDeps): EmitPlan {
  const emitter = EMITTERS[deps.target.id];
  if (!emitter) throw new UnknownEmitProviderError(deps.target.id);

  // Уровня проекта у цели может не быть вовсе. Маршрут отвечает на это 4xx
  // раньше, но отказ живёт и здесь: без него любой другой вызывающий получил бы
  // «перенос как глобальный» — то есть проектную настройку, записанную во все
  // проекты человека сразу (П2.5, критерий 2).
  if (deps.scope === 'project') {
    const support = projectSupport(deps.target);
    if (!support.supported) {
      throw new ProjectLevelUnsupportedError(deps.target.id, support.why ?? '');
    }
  }

  return emitter(env, deps);
}
