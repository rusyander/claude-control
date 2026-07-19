import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  MCP_PRESETS,
  HOME_DIR_TOKEN,
  type McpPreset,
  type McpTransport,
} from '@claude-control/contracts';
import { apiClient } from '@shared/api/client';
import { queryKeys } from '@shared/api/query-keys';
import { Stack } from '@shared/ui/stack';
import { Card } from '@shared/ui/card';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { FormWithAssistant } from '@shared/ui/form-with-assistant';
import { mcpServerApi } from '@entities/McpServer';
import { envToText, textToEnv, parseArgs, formatArgs } from '@shared/lib/env-text';
import type { McpFormModalProps } from './McpFormModal.types';
import { McpJsonImport } from './McpJsonImport';
import styles from './McpFormModal.module.scss';

const TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http'];

/**
 * Добавление и правка MCP-сервера. Поля зависят от транспорта: у stdio это
 * команда с аргументами, у sse и http — адрес. Показывать всё сразу вредно:
 * половина полей окажется лишней и запутает.
 */
export function McpFormModal({ isOpen, onOpenChange, server }: McpFormModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');
  // Один сервер по полям или пачка из JSON-конфига.
  const [isImport, setIsImport] = useState(false);

  const create = mcpServerApi.useCreate();
  const update = mcpServerApi.useUpdate();

  useEffect(() => {
    if (!isOpen) return;
    setName(server?.name ?? '');
    setTransport(server?.transport ?? 'stdio');
    setCommand(server?.command ?? '');
    setArgs(server ? formatArgs(server.args) : '');
    setUrl(server?.url ?? '');
    setEnvText(server ? envToText(server.env) : '');
    setHeadersText(server ? envToText(server.headers) : '');
    setIsImport(false);
  }, [isOpen, server]);

  /**
   * Домашний каталог для заготовок, где нужен путь. Заготовка не может знать
   * его сама: contracts работают и на фронте, а путь зависит от системы —
   * поэтому в аргументах стоит метка, которую подставляем здесь.
   */
  const { data: system } = useQuery({
    queryKey: queryKeys.system,
    queryFn: async () => (await apiClient.get<{ homeDir: string }>('/system')).data,
    staleTime: Infinity,
  });

  /** Подставляет заготовку в поля формы; имя не трогаем, если уже введено. */
  const applyPreset = (preset: McpPreset): void => {
    if (!name.trim()) setName(preset.id);
    setTransport(preset.transport);
    setCommand(preset.command ?? '');
    setArgs(
      formatArgs(
        preset.args.map((arg) => arg.replace(HOME_DIR_TOKEN, system?.homeDir ?? HOME_DIR_TOKEN)),
      ),
    );
    setUrl(preset.url ?? '');
    setEnvText(envToText(preset.env));
    setHeadersText('');
  };

  const isPending = create.isPending || update.isPending;
  const isStdio = transport === 'stdio';
  const canSave =
    name.trim().length > 0 &&
    (isStdio ? command.trim().length > 0 : url.trim().length > 0) &&
    !isPending;

  const handleSave = (): void => {
    const draft = {
      name: name.trim(),
      transport,
      command: isStdio ? command.trim() : undefined,
      args: isStdio ? parseArgs(args) : [],
      url: isStdio ? undefined : url.trim(),
      env: textToEnv(envText),
      // Заголовки нужны только сетевым транспортам: у stdio их некуда деть,
      // и сохранённые «на всякий случай» они только мусорят конфиг.
      headers: isStdio ? {} : textToEnv(headersText),
      groupIds: [],
    };

    const onDone = { onSuccess: () => onOpenChange(false) };
    if (server) update.mutate({ id: server.id, draft }, onDone);
    else create.mutate(draft, onDone);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={server ? `${t('common.edit')}: ${server.name}` : t('mcp.addServer')}
      description={t('common.needsRestart')}
      // Как у остальных форм с помощником: поля и чат в две колонки.
      // Раньше это окно было уже прочих и выбивалось из ряда.
      size="xl"
      footer={
        isImport ? (
          <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        ) : (
          <>
            <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!canSave}
              isLoading={isPending}
            >
              {t('common.save')}
            </Button>
          </>
        )
      }
    >
      {!server && (
        <div className={styles.modeTabs}>
          <Button
            size="sm"
            variant={!isImport ? 'primary' : 'ghost'}
            onClick={() => setIsImport(false)}
          >
            {t('mcp.modeSingle')}
          </Button>
          <Button
            size="sm"
            variant={isImport ? 'primary' : 'ghost'}
            onClick={() => setIsImport(true)}
          >
            {t('mcp.modeImport')}
          </Button>
        </div>
      )}

      {isImport ? (
        <McpJsonImport onDone={() => onOpenChange(false)} />
      ) : (
        <FormWithAssistant
          kind={t('mcp.title')}
          fields={{ name, transport, command, args, url, envText, headersText }}
          schema={{
            name: 'Имя сервера в конфиге',
            transport: 'Транспорт: stdio, sse или http',
            command: 'Команда запуска для stdio, например npx',
            args: 'Аргументы команды через пробел',
            url: 'Адрес для sse и http',
            envText: 'Переменные окружения по строке в формате KEY=VALUE',
            headersText: 'HTTP-заголовки для sse и http по строке в формате Имя=значение',
          }}
          onApply={(applied) => {
            if (typeof applied.name === 'string') setName(applied.name);
            if (typeof applied.transport === 'string')
              setTransport(applied.transport as McpTransport);
            if (typeof applied.command === 'string') setCommand(applied.command);
            if (typeof applied.args === 'string') setArgs(applied.args);
            if (typeof applied.url === 'string') setUrl(applied.url);
            if (typeof applied.envText === 'string') setEnvText(applied.envText);
            if (typeof applied.headersText === 'string') setHeadersText(applied.headersText);
          }}
        >
          <Stack gap="var(--spacing-md)">
            {/* Заготовки показываем только при создании: у существующего сервера
            подмена всех полей разом почти наверняка не то, чего ждут. */}
            {!server && (
              <Card padding="md">
                <Stack gap="var(--spacing-sm)">
                  <Typography variant="body-sm" weight="medium">
                    {t('mcp.presetsTitle')}
                  </Typography>
                  <Typography variant="caption" color="subtle">
                    {t('mcp.presetsHint')}
                  </Typography>

                  <Stack direction="row" gap="var(--spacing-2xs)" wrap>
                    {MCP_PRESETS.map((preset) => (
                      <Button
                        key={preset.id}
                        size="sm"
                        variant="secondary"
                        onClick={() => applyPreset(preset)}
                        title={preset.description}
                      >
                        {preset.title}
                      </Button>
                    ))}
                  </Stack>
                </Stack>
              </Card>
            )}

            <TextField
              label={t('mcp.serverName')}
              value={name}
              onChange={setName}
              placeholder="например: gitlab-gorgona"
              hint={t('mcp.serverNameHint')}
              isMono
              autoFocus={!server}
            />

            <SelectField
              label={t('mcp.transport')}
              value={transport}
              onChange={(value) => setTransport(value as McpTransport)}
              options={TRANSPORTS.map((value) => ({ value, label: value }))}
              hint={t('mcp.transportHint')}
            />

            {isStdio ? (
              <>
                <TextField
                  label={t('mcp.command')}
                  value={command}
                  onChange={setCommand}
                  placeholder="npx"
                  isMono
                />
                <TextField
                  label={t('mcp.args')}
                  value={args}
                  onChange={setArgs}
                  placeholder="-y @scope/mcp-server"
                  hint={t('mcp.argsHint')}
                  isMono
                />
              </>
            ) : (
              <>
                <TextField
                  label={t('mcp.url')}
                  value={url}
                  onChange={setUrl}
                  placeholder="http://127.0.0.1:3845/sse"
                  isMono
                />
                {/* Без заголовков сервер за авторизацией нельзя ни подключить,
                ни проверить: он отвечает 401 ещё на рукопожатии. */}
                <TextField
                  label={t('mcp.headers')}
                  value={headersText}
                  onChange={setHeadersText}
                  multiline
                  rows={3}
                  placeholder={'Authorization=Bearer ${MY_TOKEN}'}
                  hint={t('mcp.headersHint')}
                  isMono
                />
              </>
            )}

            <TextField
              label={t('mcp.env')}
              value={envText}
              onChange={setEnvText}
              multiline
              rows={5}
              placeholder={'MCP_SECRET_KEYS=TOKEN_A,TOKEN_B'}
              hint={t('mcp.envHint')}
              isMono
            />

            {(create.isError || update.isError) && (
              <Typography variant="body-sm" color="danger">
                {t('errors.saveFailed')}
              </Typography>
            )}
          </Stack>
        </FormWithAssistant>
      )}
    </Modal>
  );
}
