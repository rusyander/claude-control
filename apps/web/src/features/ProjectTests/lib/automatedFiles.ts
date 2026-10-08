import type { TestE2eCardProps } from '../ui/TestE2eCard/TestE2eCard.types';

/** Разные файлы автотестов у живых кейсов группы — то, что уйдёт в `{files}`. */
export const automatedFiles = (group: TestE2eCardProps['board']['groups'][number]): string[] => [
  ...new Set(
    group.cases
      .filter((item) => !item.archived)
      .map((item) => item.automation?.file)
      .filter((file): file is string => Boolean(file)),
  ),
];
