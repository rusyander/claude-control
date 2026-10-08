import { useMutation, useQueryClient } from '@tanstack/react-query';
import { splitTasksOptions } from '../lib/splitTasksOptions';

export function useSplitTasks() {
  return useMutation(splitTasksOptions(useQueryClient()));
}
