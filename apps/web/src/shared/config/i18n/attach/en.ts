import type { attachRu } from './ru.ts';

/** Images in agent inputs; typed against the Russian module. */
export const attachEn: typeof attachRu = {
  button: 'Attach an image',
  list: 'Attached images',
  remove: 'Remove image {{name}}',
  preparing: 'Preparing the image…',
  dropHint: 'Drop to attach the image',
  hint: 'Paste an image with Ctrl+V or drag it into the field.',
  tooLarge: 'Images over {{limit}} are not attached: {{names}}.',
  notImage: 'Only PNG, JPEG, GIF and WebP images can be attached. Not attached: {{names}}.',
  tooMany: 'At most {{limit}} images per message. Not attached: {{names}}.',
  unreadable: 'Could not read the image: {{names}}.',
  shrinkFailed: 'Could not shrink the image to the model limit: {{names}}.',
  busy: 'The image cannot be attached right now: the field is waiting for a reply or the mode takes no attachments. Not attached: {{names}}.',
  uploadFailed: 'The images did not reach the panel — the message was not sent: {{message}}',
  sent: 'Images: {{names}}',
};
