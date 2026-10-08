import { useMemo, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { Empty, Loading, Mono, Muted, Row, Title } from '../../shared/ui';
import { space } from '../../shared/config/theme';
import { useT } from '../../shared/config/i18n';
import { apiUrl } from '../../shared/api/client';
import { canDiff } from './diff';
import { useFileContent } from '../../entities/files/useFileContent';
import { diffLines } from './diffLines';
import { collapse } from './collapse';
import { authHeaders } from '../../shared/api/authHeaders';
import { styles } from './FileView.styles';

/**
 * Файл целиком — только на чтение. Правки в приложении нет и не будет: править
 * код с телефона никто не собирался, а кнопка, которой можно задеть чужую
 * работу, ценнее не становится оттого, что она есть.
 *
 * Если у файла есть восстановленное «до», по умолчанию показывается дифф: ради
 * ответа «что агент тут сделал» экран и открывают.
 */
export function FileView({
  projectPath,
  file,
  chatId,
  onClose,
}: {
  projectPath: string;
  file: string;
  chatId: string;
  onClose: () => void;
}) {
  const t = useT();
  const content = useFileContent(projectPath, file, chatId);
  const [mode, setMode] = useState<'diff' | 'text'>('diff');

  const data = content.data;
  const lines = useMemo(() => {
    if (!data?.baseline || data.isBinary) return undefined;
    if (!canDiff(data.baseline, data.content)) return undefined;
    return collapse(diffLines(data.baseline, data.content));
  }, [data]);

  if (content.isLoading) return <Loading />;
  if (content.isError) return <Empty text={t.code.fileFailed} />;
  if (!data) return null;

  const showDiff = mode === 'diff' && lines !== undefined;

  return (
    <View style={styles.root}>
      <Row gap={space.sm}>
        <Title style={styles.grow} numberOfLines={1}>
          {file}
        </Title>
        <Text style={styles.toggle} onPress={onClose}>
          {t.common.close}
        </Text>
      </Row>
      <Row gap={space.sm} style={styles.wrap}>
        <Mono>
          {Math.max(1, Math.round(data.sizeBytes / 1024))} {t.common.kb}
        </Mono>
        {data.added || data.removed ? (
          <Mono>
            <Text style={styles.added}>+{data.added}</Text>{' '}
            <Text style={styles.removed}>−{data.removed}</Text>
          </Mono>
        ) : null}
        {data.isReadOnly ? <Mono>{t.code.readOnly}</Mono> : null}
        {data.tooBig ? <Mono>{t.code.tooBig}</Mono> : null}
        {data.unmatched > 0 ? (
          <Mono style={styles.warn}>{t.code.unmatched(data.unmatched)}</Mono>
        ) : null}
        {data.kind === 'whole-file' ? <Mono>{t.code.wholeFile}</Mono> : null}
        {lines ? (
          <Text style={styles.toggle} onPress={() => setMode(showDiff ? 'text' : 'diff')}>
            {showDiff ? t.code.showFile : t.code.showDiff}
          </Text>
        ) : null}
      </Row>

      {data.preview === 'image' ? (
        <Image
          // Токен уходит заголовком, а не в адресе: адрес попадает в кэш
          // картинок и в логи, и секрет в нём жил бы дольше самого запроса.
          source={{
            uri: apiUrl('/project-files/raw', { path: projectPath, file }),
            headers: authHeaders(),
          }}
          style={styles.image}
          resizeMode="contain"
        />
      ) : null}

      {data.isBinary && data.preview !== 'image' ? <Muted>{t.code.binary}</Muted> : null}

      {!data.isBinary ? (
        <ScrollView horizontal style={styles.code} contentContainerStyle={styles.codeContent}>
          <View>
            {showDiff && lines
              ? lines.map((line, index) => (
                  <Text
                    key={index}
                    style={[
                      styles.line,
                      line.kind === 'added' && styles.lineAdded,
                      line.kind === 'removed' && styles.lineRemoved,
                    ]}
                  >
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} {line.text}
                  </Text>
                ))
              : data.content.split('\n').map((text, index) => (
                  <Text key={index} style={styles.line}>
                    {text || ' '}
                  </Text>
                ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}
