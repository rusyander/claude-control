import { describe, it, expect } from 'vitest';
import { CLI_RUN_FACTS } from '@agentdeck/providers/registry';
import { listProviders } from '../providers/registry.ts';
import { PROVIDER_CLI_NAMES } from './provider-cli-names.mjs';

/**
 * Таблица для `pnpm run doctor` — копия фактов `packages/providers`: doctor идёт голым `node`
 * и проверяет версию Node раньше всего, поэтому импортировать `.ts` пакета не может. Копия не
 * расходится с пакетом (единственный источник) и с каталогом панели, который из него строится.
 */
describe('PROVIDER_CLI_NAMES', () => {
  it('совпадает с фактами запуска packages/providers: id, имя и команды каждого CLI, в порядке реестра', () => {
    expect(PROVIDER_CLI_NAMES).toEqual(
      CLI_RUN_FACTS.map((facts) => ({
        id: facts.id,
        name: facts.name,
        command: facts.binary.command,
        windowsCommand: facts.binary.windowsCommand,
      })),
    );
  });

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
