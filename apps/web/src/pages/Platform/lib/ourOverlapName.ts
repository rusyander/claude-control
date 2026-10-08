import { OUR_OVERLAP_NAMES } from './contourConfigView.constants';

export type OurOverlapName = (typeof OUR_OVERLAP_NAMES)[number];

/** Имя нашей стороны для подписи «пересекается: …»; незнакомое — undefined. */
export function ourOverlapName(ourRule: string): OurOverlapName | undefined {
  return OUR_OVERLAP_NAMES.find((name) => name === ourRule);
}
