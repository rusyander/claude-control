import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  UniversalMcpServer,
  UniversalMcpServerDraft,
  UniversalMcpTransport,
} from '@claude-control/contracts';
import { Stack } from '@shared/ui/stack';
import { Modal } from '@shared/ui/modal';
import { Button } from '@shared/ui/button';
import { TextField } from '@shared/ui/text-field';
import { SelectField } from '@shared/ui/select-field';
import { Typography } from '@shared/ui/typography';
import { envToText, textToEnv, parseArgs, formatArgs } from '@shared/lib/env-text';

export interface ProviderMcpFormProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  server?: UniversalMcpServer;
  /**
   * Сохранение: черновик, прежнее имя сервера (при правке) и колбэк «готово»
   * (форма закроется). Мутации задаёт вызывающая страница — так одна форма
   * обслуживает и глобальный раздел провайдера, и проектный уровень (COMMON-2).
   */
  onSave: (
    draft: UniversalMcpServerDraft,
    serverId: string | undefined,
    onDone: () => void,
  ) => void;
  isPending: boolean;
  isError: boolean;
}

const TRANSPORTS: UniversalMcpTransport[] = ['stdio', 'http'];

/**
 * Добавление и правка MCP-сервера универсальной модели (Gemini/Codex/Cursor/
 * OpenCode). Поля зависят от транспорта: stdio — команда с аргументами и
 * переменными окружения, http — адрес и заголовки. Богатая страница Claude
 * (OAuth, инструменты, группы) здесь ни при чём — это базовый CRUD по
 * переносимому субсету. Форма презентационная: куда писать, решает страница.
 */
export function ProviderMcpForm({
  isOpen,
  onOpenChange,
  server,
  onSave,
  isPending,
  isError,
}: ProviderMcpFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<UniversalMcpTransport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [envText, setEnvText] = useState('');
  const [headersText, setHeadersText] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    setName(server?.name ?? '');
    setTransport(server?.transport ?? 'stdio');
    setCommand(server?.command ?? '');
    setArgs(server ? formatArgs(server.args) : '');
    setUrl(server?.url ?? '');
    setEnvText(server ? envToText(server.env) : '');
    setHeadersText(server ? envToText(server.headers) : '');
  }, [isOpen, server]);

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
      env: isStdio ? textToEnv(envText) : {},
      // Заголовки — только для http; у stdio их некуда деть.
      headers: isStdio ? {} : textToEnv(headersText),
    };

    onSave(draft, server?.name, () => onOpenChange(false));
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={server ? `${t('common.edit')}: ${server.name}` : t('mcp.addServer')}
      description={t('common.needsRestart')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} isLoading={isPending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Stack gap="var(--spacing-md)">
        <TextField
          label={t('mcp.serverName')}
          value={name}
          onChange={setName}
          placeholder="например: context7"
          hint={t('mcp.serverNameHint')}
          isMono
          autoFocus={!server}
        />

        <SelectField
          label={t('mcp.transport')}
          value={transport}
          onChange={(value) => setTransport(value as UniversalMcpTransport)}
          options={TRANSPORTS.map((value) => ({ value, label: value }))}
          hint={t('providerMcp.transportHint')}
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
            <TextField
              label={t('mcp.env')}
              value={envText}
              onChange={setEnvText}
              multiline
              rows={4}
              placeholder={'API_KEY=значение'}
              hint={t('mcp.envHint')}
              isMono
            />
          </>
        ) : (
          <>
            <TextField
              label={t('mcp.url')}
              value={url}
              onChange={setUrl}
              placeholder="https://example.com/mcp"
              isMono
            />
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

        {isError && (
          <Typography variant="body-sm" color="danger">
            {t('errors.saveFailed')}
          </Typography>
        )}
      </Stack>
    </Modal>
  );
}
