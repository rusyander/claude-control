import { CONTOUR_KEY_PREFIX } from './pageTarget.constants';

export function contourKeyAnchor(id: string): string {
  return `${CONTOUR_KEY_PREFIX}${id}`;
}
