import { projectRunnerKey } from '../api/ProjectRunnerApi.constants';

/** Ключ запроса «кто занял порт». */
export const portKey = (port: number) => [...projectRunnerKey, 'port', port] as const;
