import { useLocalAction } from './useLocalAction';
import { post } from '../lib/post';

/** Перемерить железо: свободная видеопамять меняется, пока человек работает. */
export const useRefreshHardware = () =>
  useLocalAction<void, unknown>(() => post('/local-models/hardware/refresh'));
