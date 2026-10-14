import { useLocalAction } from './useLocalAction';
import type { CatalogModel } from '@agentdeck/contracts/local-models';
import { post } from '../lib/post';

/** «Любая модель»: `владелец/репозиторий` или ссылка Hugging Face — список квантований читается из репозитория. */
export const useAddCustomModel = () =>
  useLocalAction<string, CatalogModel>((input) => post('/local-models/custom', { input }));
