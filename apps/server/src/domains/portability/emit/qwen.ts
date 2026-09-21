import { emitUniversalSections } from './sections.ts';
import type { Emitter } from './types.ts';

/**
 * Канон → Qwen Code.
 *
 * Форк Gemini, но ключи прав и хуков у него СВОИ: хуки живут ключом корня
 * `hooks` в `settings.json`, и таймаут там в МИЛЛИСЕКУНДАХ. Единица приезжает
 * вместе со значением канона, поэтому шестьдесят секунд источника становятся
 * здесь шестьюдесятью тысячами, а не шестьюдесятью.
 */
export const emitToQwen: Emitter = (env, deps) => emitUniversalSections(env, deps);
