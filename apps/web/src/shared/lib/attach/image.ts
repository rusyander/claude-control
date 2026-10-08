import { AGENT_IMAGE_MAX_EDGE } from '@agentdeck/contracts/agent-images';

/**
 * Картинка для агента, который получает её ПРЯМО В ЗАПРОСЕ (агент панели,
 * помощники, ассистент шага). У API модели свой предел — 5 МБ строки base64 на
 * картинку, — и снимок экрана 4K его легко переходит. Человек прикладывает под
 * пределом чата (20 МБ), а ужимает фронт: длинная сторона до
 * `AGENT_IMAGE_MAX_EDGE` (больше модель всё равно не разглядит — API уменьшает
 * сам, только за токены) и байты под `AGENT_IMAGE_WIRE_MAX_BYTES`.
 */

/** Почему картинку не приложить. */
export type ImageRefusal = 'not-image' | 'unreadable' | 'too-large';

export class AgentImageError extends Error {
  readonly reason: ImageRefusal;
  readonly fileName: string;

  constructor(reason: ImageRefusal, fileName: string) {
    super(`${reason}: ${fileName}`);
    this.reason = reason;
    this.fileName = fileName;
  }
}

/** Размер, вписанный в квадрат `maxEdge` с сохранением пропорций; меньшее не растягиваем. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = AGENT_IMAGE_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
