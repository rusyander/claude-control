import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import type { CredentialsStatus } from '../model/credentials.types';
import { CREDENTIALS_KEY } from './CredentialsApi.constants';

async function getCredentials(): Promise<CredentialsStatus> {
  const { data } = await apiClient.get<CredentialsStatus>('/credentials');
  return data;
}

export function useCredentialsStatus() {
  return useQuery({ queryKey: CREDENTIALS_KEY, queryFn: getCredentials });
}
