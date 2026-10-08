import type { ProjectFileContent } from '@agentdeck/contracts';

/**
 * Что написать вместо редактора: файл не выбран, грузится, велик, двоичный.
 * Размер идёт раньше двоичности: у картинки верно и то и другое, но человеку
 * важна причина отказа, а она здесь — вес.
 */
export function placeholderKey(
  isSwitching: boolean,
  file: ProjectFileContent | undefined,
  t: (key: string) => string,
): string {
  if (isSwitching) return t('common.loading');
  if (!file) return t('projectCode.pickFile');
  if (file.tooBig) return t('projectCode.tooBig');
  if (file.isBinary) return t('projectCode.binary');
  return t('projectCode.tooBig');
}
