import type { sitePreviewRu } from './ru.ts';

/** Project site window in the chat and the element pick (stage 12, D20); typed against Russian. */
export const sitePreviewEn: typeof sitePreviewRu = {
  title: 'Project site',
  open: 'Open the site',
  openNamed: 'Site: {{name}}',
  openHint: 'Open the running project site to the right of the chat and pick an element on it',
  frameTitle: 'Project site {{name}}',
  pick: 'Pick an element',
  pickHint:
    'Hover an element of the site and click: its description goes into the chat input. Escape cancels.',
  reload: 'Reload the page',
  openInBrowser: 'Open in the browser',
  close: 'Close the site window',
  notRunning: 'The site is not running: start the project dev server and open the window again.',
  openFailed: 'The site window did not open: {{message}}',
  pickFailed: 'The pick was not accepted: the site window is stale, open it again.',
  picked: 'Element added to the chat input',
  block: {
    header: 'Element from the site page (picked in the panel site window):',
    url: 'url',
    selector: 'selector',
    tag: 'tag',
    text: 'text',
    rect: 'place on the page',
    html: 'markup',
    empty: '(empty)',
  },
};
