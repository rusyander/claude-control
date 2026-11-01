import type { CommandEnv, PublisherCommandPort } from './commands.types.ts';

export type { CleanRemoteReport, PublisherCommandPort } from './commands.types.ts';

/** Порт публикатора для команд `publish-now` и `clean-remote`; без порта — честный отказ. */
export function publisherOf(env: CommandEnv): PublisherCommandPort | undefined {
  return env.publisher?.();
}
