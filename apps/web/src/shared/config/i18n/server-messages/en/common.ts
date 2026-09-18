import type { CommonMessageCode } from '@agentdeck/contracts/server-messages';

export const commonEn: Record<CommonMessageCode, string> = {
  'file-not-found': 'File not found',
  'path-absolute-required': 'An absolute path is required',
  'directory-unavailable': 'The folder is unavailable',
  'directory-not-found': 'Folder not found',
  'project-path-required': 'A project path is required',
  'project-not-in-registry': 'The project is not in the registry',
  'project-id-not-in-registry': 'There is no project with this id in the registry.',
  'project-dir-already-added': 'This folder is already added as “{{name}}”.',
};
