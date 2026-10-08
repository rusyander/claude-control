import type { AgentImageType } from '@agentdeck/contracts/agent-images';
import type { EncodeAttempt } from './image.types';
import { fitWithin } from './image';

/**
 * Порядок попыток. PNG первым только для PNG: снимок экрана с текстом в JPEG
 * мылится, а PNG в 1568 px обычно и так под пределом. Дальше — JPEG со
 * снижением качества, потом со снижением размера: картинка должна уйти, пусть
 * и мельче, а не упереться в отказ.
 */
export function encodeAttempts(
  source: AgentImageType,
  width: number,
  height: number,
): EncodeAttempt[] {
  const base = fitWithin(width, height);
  const attempts: EncodeAttempt[] = [];
  if (source === 'image/png') attempts.push({ ...base, mediaType: 'image/png' });
  attempts.push({ ...base, mediaType: 'image/jpeg', quality: 0.85 });
  attempts.push({ ...base, mediaType: 'image/jpeg', quality: 0.7 });
  let scale = 0.75;
  for (let step = 0; step < 4; step += 1) {
    attempts.push({
      width: Math.max(1, Math.round(base.width * scale)),
      height: Math.max(1, Math.round(base.height * scale)),
      mediaType: 'image/jpeg',
      quality: 0.75,
    });
    scale *= 0.75;
  }
  return attempts;
}
