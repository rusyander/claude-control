import type { chatProjectsRu } from './ru.ts';

/** English texts of chat projects vs the Projects page; typed against the Russian module. */
export const chatProjectsEn: typeof chatProjectsRu = {
  saved: 'In Projects',
  savedHint: 'The project is on the Projects page — open its settings',
  savedMark: 'On the Projects page',
  save: 'To Projects',
  saveHint:
    'Add the project to the Projects page: its settings live there, and it stays in this list even after its tab is closed',
  saveRow: 'Add “{{name}}” to the Projects page',
  noChats: 'no conversations yet',
  openMany: 'Open several',
  openManyHint: 'Pick projects from a list and open them as tabs at once',
  dialogTitle: 'Open projects',
  dialogText:
    'The checked ones open as tabs. Projects from the Projects page come first: they stay here even when their tab is closed.',
  alreadyOpen: 'already open',
  openSelected_one: 'Open {{count}} project',
  openSelected_few: 'Open {{count}} projects',
  openSelected_many: 'Open {{count}} projects',
  openSelected_other: 'Open {{count}} projects',
  cancel: 'Cancel',
  nothing: 'Nothing to open: every project is already open in a tab.',
};
