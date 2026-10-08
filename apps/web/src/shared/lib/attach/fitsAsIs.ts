import {
  AGENT_IMAGE_MAX_EDGE,
  AGENT_IMAGE_WIRE_MAX_BYTES,
} from '@agentdeck/contracts/agent-images';

/** Можно ли отправить файл как есть: и сторона, и байты в пределах. */
export function fitsAsIs(width: number, height: number, bytes: number): boolean {
  return Math.max(width, height) <= AGENT_IMAGE_MAX_EDGE && bytes <= AGENT_IMAGE_WIRE_MAX_BYTES;
}
