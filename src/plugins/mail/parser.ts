/**
 * .emlx parser (Apple Mail's per-message format).
 *
 * Layout:
 *   <byte_count>\n              ← length of the RFC 822 portion that follows
 *   <RFC 822 message>\n
 *   <Apple property-list metadata>   ← optional, ignored
 *
 * Headers can be folded across multiple lines (continuation lines start
 * with whitespace). Bodies may be multipart MIME with quoted-printable or
 * base64 encoded parts. We pick the first text/plain part, fall back to
 * stripping HTML, otherwise pass the body through.
 *
 * Goal: good enough for retrieval, not 100% MIME conformant.
 */

export interface ParsedEmail {
  messageId: string | null;
  subject: string;
  from: string | null;
  to: string[];
  cc: string[];
  /** Unix epoch ms, parsed from the Date header. */
  date: number | null;
  body: string;
}

export function parseEmlx(raw: string): ParsedEmail | null {
  // Strip the leading byte-count line. If it's present we trust it and
  // slice; if not (some exports omit it) we just treat the whole input as
  // RFC 822.
  const firstLineEnd = raw.indexOf('\n');
  if (firstLineEnd < 0) return null;
  const firstLine = raw.slice(0, firstLineEnd).trim();
  let rfc822: string;
  if (/^\d+$/.test(firstLine)) {
    const len = Number(firstLine);
    rfc822 = raw.slice(firstLineEnd + 1, firstLineEnd + 1 + len);
  } else {
    rfc822 = raw;
  }

  return parseMessage(rfc822);
}

function parseMessage(raw: string): ParsedEmail | null {
  const sep = raw.indexOf('\n\n');
  const headerBlock = sep >= 0 ? raw.slice(0, sep) : raw;
  const bodyBlock = sep >= 0 ? raw.slice(sep + 2) : '';
  if (headerBlock.length === 0) return null;

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
 * RFC 2047 encoded-words: =?charset?B?base64?= or =?charset?Q?qp?=
 * Used in headers to carry non-ASCII characters (e.g. Turkish diacritics
 * in Subject:).
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
 * Pull a useful text body out of a possibly-multipart message.
 *
 * For multipart/* we walk the first level of parts and prefer text/plain
 * over text/html. Nested multiparts aren't fully recursed — that's
 * uncommon enough that the cost isn't worth it for retrieval purposes.
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
