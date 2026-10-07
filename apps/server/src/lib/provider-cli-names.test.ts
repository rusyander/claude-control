import { describe, it, expect } from 'vitest';
import { listProviders } from '../providers/registry.ts';
import { PROVIDER_CLI_NAMES } from './provider-cli-names.mjs';

/** Таблица для `pnpm doctor` не расходится с каталогом провайдеров. */
describe('PROVIDER_CLI_NAMES', () => {
  it('совпадает с каталогом: id, имя и команды CLI каждого провайдера', () => {
    expect(PROVIDER_CLI_NAMES).toEqual(
      listProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        command: provider.cli.command,
        windowsCommand: provider.cli.windowsCommand,
      })),
    );
  });
});
