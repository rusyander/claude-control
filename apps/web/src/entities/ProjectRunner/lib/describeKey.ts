import { projectRunnerKey } from '../api/ProjectRunnerApi.constants';
import { normalizeProjectPath } from '@shared/lib/workspace';

/** Ключ запроса «что здесь можно запустить» — общий для чтения и записи. */
export const describeKey = (path: string | undefined) =>
  [...projectRunnerKey, 'describe', path ? normalizeProjectPath(path) : ''] as const;
