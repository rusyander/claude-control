import type { HelpTopic } from './topics.types';
import { ALL_TOPICS } from './topics.constants';

export { HELP_ROUTE } from '@shared/config/routes';

export function findHelpTopic(id: string | undefined): HelpTopic | undefined {
  return id ? ALL_TOPICS.find((topic) => topic.id === id) : undefined;
}
