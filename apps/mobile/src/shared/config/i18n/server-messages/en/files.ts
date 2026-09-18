import type { FilesMessageCode } from '@agentdeck/contracts/server-messages';

export const filesEn: Record<FilesMessageCode, string> = {
  'file-not-found-dot': 'File not found.',
  'directory-unavailable-dot': 'The folder is unavailable.',
  'file-unavailable': 'The file is unavailable.',
  'code-window-snapshot-incomplete': 'Incomplete code window snapshot.',
  'file-list-width-missing': 'The file list width is not set.',
  'write-request-incomplete': 'Incomplete write request.',
  'write-failed': 'Could not write.',
  'runner-project-path-required': 'An absolute project folder path is required',
  'runner-enabled-boolean': 'The enabled field must be a boolean',
  'runner-port-required': 'A port number is required',
  'file-not-a-file': 'This is not a file.',
  'file-format-not-shown': 'The panel does not show this format.',
  'file-too-large-view': 'The file is too large to view.',
  'file-content-missing': 'No content was passed.',
  'file-too-large-write': 'The file is larger than allowed.',
  'file-changed-on-disk': 'The file on disk changed after it was opened.',
  'runner-command-empty': 'The launch command is empty.',
  'runner-subdir-outside': 'The subfolder must be inside the project: {{dir}}',
  'resource-path-escapes': 'The path goes outside the resource',
  'resource-path-invalid': 'Invalid path',
  'resource-file-exists': 'A file with this name already exists',
  'resource-read-only': 'This resource kind is read-only',
  'project-dev-script-missing':
    'package.json has no dev or start script. Set the launch command by hand.',
};
