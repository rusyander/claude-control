import type { MediaRequestView } from '@agentdeck/contracts/media-block';

export interface MediaRequestTextProps {
  request: MediaRequestView;
  /** Реплика целиком — ровно то, что получил агент. */
  text: string;
}
