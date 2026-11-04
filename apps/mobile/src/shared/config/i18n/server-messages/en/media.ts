import type { MediaMessageCode } from '@agentdeck/contracts/server-messages';

export const mediaEn: Record<MediaMessageCode, string> = {
  'media-image-not-found': 'The panel has no such image.',
  'media-deck-not-found': 'The panel has no such presentation.',
  'media-deck-file-missing': 'The panel could not find the presentation file.',
  'media-deck-format-unknown': 'Presentations have no such file type.',
  'media-deck-revise-unspecified': 'Which presentation to revise was not specified.',
  'media-deck-revise-gone': 'The presentation you asked to revise is no longer in the panel.',
  'media-deck-block-invalid': 'The block is not a deck: no title or no slides.',
  'media-topic-empty': 'Describe what you need.',
  'media-prompt-kind-unknown': 'Unknown request kind.',
  'media-failed': 'It did not work: {{reason}}',
  'media-pdf-print-failed': 'The browser did not print the PDF: {{reason}}',
  'media-image-empty-bytes': 'The model answered with empty bytes instead of an image',
  'media-image-too-large': 'The image is larger than {{limit}} MB — the panel does not store it',
  'media-image-signature':
    'The model answer is not an image: the file signature is unknown to the panel',
  'media-image-mime-mismatch': 'The model declared {{declared}}, but the bytes are {{mime}}',
  'media-image-type-unshown': 'The panel does not show type {{declared}}',
  'media-agent-image-not-ordered':
    'The panel does not order an agent drawing — it arrives as a block in the answer.',
  'media-images-no-bytes': 'The images endpoint answer has neither bytes nor an address',
  'media-images-not-json': 'The images endpoint answer is not JSON',
  'media-image-id-invalid': 'The image id is not one the panel issues',
  'media-image-file-missing': 'The panel did not find the image file',
  'media-upstream-unreachable': 'The address was not reached: {{reason}}',
  'media-image-request-invalid': 'The image request could not be parsed.',
  'media-picture-block-invalid': 'The picture block could not be parsed.',
  'media-deck-request-invalid': 'The presentation request could not be parsed.',
  'media-deck-block-body-invalid': 'The deck block could not be parsed.',
  'media-prompt-empty': 'describe the picture',
  'media-prompt-too-long': 'the description is longer than 4000 characters',
  'media-deck-topic-empty': 'name the presentation topic',
  'media-deck-topic-too-long': 'the topic is longer than 4000 characters',
  'media-block-empty': 'the block is empty',
  'media-agent-images-invalid': 'the images in the request are not in the shape the panel expects',
  'media-agent-images-too-many': 'one message carries at most {{limit}} images',
  'media-agent-image-too-large':
    '{{name}} is {{size}} MB, and an image goes to the agent up to {{limit}} MB',
  'media-agent-image-not-image': '{{name}} is not a PNG, JPEG, GIF or WebP image',
  'media-image-blocked-no-route': 'Nobody to draw: no active contour and no endpoint of your own.',
  'media-image-blocked-driver-none': 'This contour has no image generation.',
  'media-image-blocked-no-model': 'No model of the key declared drawing.',
  'media-image-blocked-endpoint-no-url': 'The endpoint profile has no image generation address.',
  'media-image-blocked-endpoint-api-kind': 'Only an OpenAI-kind endpoint can make images.',
  'media-image-blocked-no-agent':
    'Nobody to draw: no raster road and no conversation with an agent.',
  'media-upstream-timeout-image':
    'The image did not arrive within {{seconds}} s — the panel does not wait longer',
  'media-upstream-timeout-deck':
    'The deck did not arrive within {{seconds}} s — the panel does not wait longer',
  'media-core-not-connected':
    "The request to the contour goes through a core hop, and the panel's core is not connected.",
  'media-contour-link-failed': 'The core hop gave no address for contour «{{contour}}»: {{reason}}',
};
