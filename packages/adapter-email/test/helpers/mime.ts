export interface ParsedMessage {
  headers: Record<string, string>;
  body: string;
}

/** Splits a raw RFC 822 message and joins folded header lines. */
export function parseMessage(raw: string): ParsedMessage {
  const separatorIndex = raw.indexOf('\r\n\r\n');
  const headerBlock = separatorIndex === -1 ? raw : raw.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 4);

  const collected: Record<string, string[]> = {};
  let currentName: string | undefined;

  for (const line of headerBlock.split('\r\n')) {
    if (/^[ \t]/.test(line) && currentName !== undefined) {
      collected[currentName]?.push(line.trim());
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    (collected[name] ??= []).push(value);
    currentName = name;
  }

  const headers = Object.fromEntries(
    Object.entries(collected).map(([name, values]) => [name, values.join(' ')]),
  );

  return { headers, body };
}

function decodeQEncoded(value: string): string {
  return decodeQuotedPrintable(value.replace(/_/g, ' '));
}

/** Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=`). */
export function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset, encoding, text) =>
    encoding.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : decodeQEncoded(text),
  );
}

/** Decodes quoted-printable content (including soft line breaks) as UTF-8. */
export function decodeQuotedPrintable(input: string): string {
  const unfolded = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let index = 0; index < unfolded.length; index += 1) {
    const character = unfolded[index] ?? '';
    const hex = unfolded.slice(index + 1, index + 3);
    if (character === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(character.charCodeAt(0) & 0xff);
  }

  return Buffer.from(bytes).toString('utf8');
}

export interface MimeEntity extends ParsedMessage {
  parts?: MimeEntity[];
}

/** Parses a message and, for multipart bodies, its child entities. */
export function parseMimeEntity(raw: string): MimeEntity {
  const parsed = parseMessage(raw);
  const contentType = parsed.headers['content-type'] ?? '';
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];

  if (!contentType.toLowerCase().startsWith('multipart/') || boundary === undefined) {
    return parsed;
  }

  const parts: MimeEntity[] = [];
  for (const segment of parsed.body.split(`--${boundary}`)) {
    const withoutLeadingBreak = segment.replace(/^\r?\n/, '');
    if (withoutLeadingBreak.startsWith('--')) {
      break;
    }
    if (withoutLeadingBreak.trim().length === 0) {
      continue;
    }
    parts.push(
      parseMimeEntity(
        withoutLeadingBreak.endsWith('\r\n')
          ? withoutLeadingBreak.slice(0, -2)
          : withoutLeadingBreak,
      ),
    );
  }

  return { ...parsed, parts };
}

function decodeEntityBody(entity: ParsedMessage): string {
  const encoding = (entity.headers['content-transfer-encoding'] ?? '').toLowerCase();
  if (encoding === 'base64') {
    return Buffer.from(entity.body.replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (encoding === 'quoted-printable') {
    return decodeQuotedPrintable(entity.body);
  }
  return entity.body;
}

/** Decodes every leaf part with its own transfer encoding and concatenates them. */
export function flattenBodyText(entity: MimeEntity): string {
  if (entity.parts !== undefined) {
    return entity.parts.map(flattenBodyText).join('\n');
  }
  return decodeEntityBody(entity);
}
