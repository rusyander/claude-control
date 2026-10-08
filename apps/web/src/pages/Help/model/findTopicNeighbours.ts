import type { HelpTopic } from './topics.types';
import { ALL_TOPICS } from './topics.constants';

/**
 * Соседи по порядку из HELP_GROUPS — для перехода в конце документа.
 * Порядок сквозной, границы групп не мешают: справку читают подряд.
 */
export function findTopicNeighbours(id: string): {
  prev?: HelpTopic;
  next?: HelpTopic;
} {
  const index = ALL_TOPICS.findIndex((topic) => topic.id === id);
  if (index < 0) return {};
  return { prev: ALL_TOPICS[index - 1], next: ALL_TOPICS[index + 1] };
}
