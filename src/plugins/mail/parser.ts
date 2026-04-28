/**
 * Minimal mbox + RFC 822 email parser.
 *
 * mbox format: messages separated by lines starting with `From `. Each
 * message has headers (until first blank line), then body. Headers can be
 * folded across multiple lines (continuation lines start with whitespace).
 *
 * We extract: From, To, Cc, Subject, Date, Message-ID, plus a plain-text
 * body. Multipart MIME is partially handled — we pick the first text/plain
 * part and skip attachments. Quoted-printable / base64 bodies are decoded
 * for common cases.
 *
 * Goal: good enough for retrieval, not a 100% MIME conformant parser.
 */

export interface ParsedEmail {
  messageId: string | null;
  subject: string;
  from: string | null;
  to: string[];
  cc: string[];
  /** Unix epoch ms, parsed from Date header. */
  date: number | null;
  body: string;
}

const FROM_LINE = /^From .+$/m;

export function parseMbox(raw: string): ParsedEmail[] {
  const messages = splitMbox(raw);
  return messages.map(parseMessage).filter((m) => m.subject || m.body);
}

function splitMbox(raw: string): string[] {
  // Each mbox message starts at a "From ..." line at column 0.
  const out: string[] = [];
  const lines = raw.split('\n');
  let buffer: string[] = [];

  for (const line of lines) {
    if (FROM_LINE.test(line) && buffer.length > 0) {
      out.push(buffer.join('\n'));
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) out.push(buffer.join('\n'));

  // Drop the leading "From " line on each message
  return out.map((msg) => msg.replace(/^From .+\n/, ''));
}

function parseMessage(raw: string): ParsedEmail {
  const sep = raw.indexOf('\n\n');
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const bodyBlock = sep >= 0 ? raw.slice(sep + 2) : '';

  const headers = parseHeaders(headerBlock);

  const subject = decodeMime(headers.get('subject') ?? '');
  const from = decodeMime(headers.get('from') ?? '') || null;
  const to = parseAddressList(headers.get('to'));
  const cc = parseAddressList(headers.get('cc'));
  const messageId = stripBrackets(headers.get('message-id'));
  const date = parseDate(headers.get('date'));

  const contentType = headers.get('content-type') ?? 'text/plain';
  const transferEncoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const body = extractTextBody(bodyBlock, contentType, transferEncoding);

  return { messageId, subject, from, to, cc, date, body };
}

function parseHeaders(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = block.replace(/\r\n/g, '\n').split('\n');
  let currentName: string | null = null;
  let currentValue = '';

  const flush = () => {
    if (currentName) out.set(currentName, currentValue.trim());
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && currentName) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const colon = line.indexOf(':');
    if (colon < 0) {
      currentName = null;
      currentValue = '';
      continue;
    }
    currentName = line.slice(0, colon).trim().toLowerCase();
    currentValue = line.slice(colon + 1).trim();
  }
  flush();
  return out;
}

function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/,(?![^<]*>)/)
    .map((s) => decodeMime(s.trim()))
    .filter((s) => s.length > 0);
}

function stripBrackets(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/^[<\s]+|[>\s]+$/g, '') || null;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decode RFC 2047 encoded-words: =?charset?B?base64?= or =?charset?Q?qp?=
 * Used in headers to carry non-ASCII (e.g. Turkish characters in Subject).
 */
function decodeMime(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, _charset: string, enc: string, payload: string) => {
      try {
        if (enc.toUpperCase() === 'B') {
          return Buffer.from(payload, 'base64').toString('utf-8');
        }
        return decodeQuotedPrintable(payload.replace(/_/g, ' '));
      } catch {
        return payload;
      }
    },
  );
}

function decodeQuotedPrintable(input: string): string {
  // Decode =XX hex escapes; ignore soft line breaks (=\n)
  const buf = Buffer.from(
    input
      .replace(/=\r?\n/g, '')
      .replace(/=([A-Fa-f0-9]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
    'binary',
  );
  return buf.toString('utf-8');
}

/**
 * Extract a useful text body from a possibly-multipart message.
 *
 * For multipart/alternative or multipart/mixed, we walk the first level of
 * parts and pick the first text/plain. text/html-only emails get their HTML
 * stripped to text. This handles the vast majority of real mail; nested
 * multipart trees aren't fully recursed.
 */
function extractTextBody(body: string, contentType: string, encoding: string): string {
  const ct = contentType.toLowerCase();

  if (!ct.startsWith('multipart/')) {
    const decoded = decodeBody(body, encoding);
    if (ct.startsWith('text/html')) return stripHtml(decoded);
    return decoded.trim();
  }

  const boundaryMatch = /boundary=("?)([^";]+)\1/i.exec(contentType);
  if (!boundaryMatch) return body.trim();
  const boundary = boundaryMatch[2];
  const parts = body.split(`--${boundary}`);

  let plain = '';
  let html = '';
  for (const part of parts) {
    const sep = part.indexOf('\n\n');
    if (sep < 0) continue;
    const partHeaders = parseHeaders(part.slice(0, sep));
    const partCt = (partHeaders.get('content-type') ?? '').toLowerCase();
    const partEnc = (partHeaders.get('content-transfer-encoding') ?? '7bit').toLowerCase();
    const partBody = part.slice(sep + 2);

    if (partCt.startsWith('text/plain') && !plain) {
      plain = decodeBody(partBody, partEnc).trim();
    } else if (partCt.startsWith('text/html') && !html) {
      html = stripHtml(decodeBody(partBody, partEnc));
    }
  }

  return plain || html || body.trim();
}

function decodeBody(body: string, encoding: string): string {
  switch (encoding) {
    case 'quoted-printable':
      return decodeQuotedPrintable(body);
    case 'base64':
      try {
        return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf-8');
      } catch {
        return body;
      }
    default:
      return body;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}
