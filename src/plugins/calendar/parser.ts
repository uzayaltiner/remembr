/**
 * Minimal iCalendar (RFC 5545) VEVENT parser.
 *
 * Handles the subset we care about for indexing:
 *   - UID, SUMMARY, DESCRIPTION, LOCATION, ORGANIZER, ATTENDEE
 *   - DTSTART, DTEND (any of: date, datetime, with or without TZID)
 *   - Line unfolding (folded continuation lines starting with space/tab)
 *   - Param escapes (\n, \,, \;, \\)
 *
 * Skips: recurrence rules (RRULE), time zones, alarms, attachments — they
 * don't help retrieval.
 */

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  organizer: string | null;
  attendees: string[];
  /** Unix epoch (ms). null when DTSTART is unparseable. */
  start: number | null;
  /** Unix epoch (ms). null when DTEND is unparseable. */
  end: number | null;
  /** All-day event (DTSTART;VALUE=DATE without time). */
  allDay: boolean;
  /** Calendar source filename (without .ics). */
  calendar: string;
}

const EVENT_BEGIN = /^BEGIN:VEVENT\s*$/;
const EVENT_END = /^END:VEVENT\s*$/;

export function parseIcs(raw: string, calendarName: string): CalendarEvent[] {
  const lines = unfoldLines(raw);
  const events: CalendarEvent[] = [];
  let current: Map<string, RawProp> | null = null;
  const attendeeBuffer: string[] = [];

  for (const line of lines) {
    if (EVENT_BEGIN.test(line)) {
      current = new Map();
      attendeeBuffer.length = 0;
      continue;
    }
    if (EVENT_END.test(line)) {
      if (current) events.push(buildEvent(current, [...attendeeBuffer], calendarName));
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = splitProperty(line);
    if (!prop) continue;
    if (prop.name === 'ATTENDEE') {
      attendeeBuffer.push(cleanMailto(prop.value));
    } else {
      current.set(prop.name, prop);
    }
  }

  return events;
}

interface RawProp {
  name: string;
  params: Map<string, string>;
  value: string;
}

/**
 * Reverse RFC 5545 line folding: a continuation line starts with whitespace
 * and is appended (after stripping the leading space) to the previous line.
 */
function unfoldLines(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.length === 0) continue;
    if ((line[0] === ' ' || line[0] === '\t') && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function splitProperty(line: string): RawProp | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);

  const parts = head.split(';');
  const name = (parts[0] ?? '').toUpperCase();

  const params = new Map<string, string>();
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params.set(part.slice(0, eq).toUpperCase(), part.slice(eq + 1));
  }

  return { name, params, value };
}

function buildEvent(
  props: Map<string, RawProp>,
  attendees: string[],
  calendar: string,
): CalendarEvent {
  const summary = unescapeIcs(props.get('SUMMARY')?.value ?? '');
  const description = props.has('DESCRIPTION')
    ? unescapeIcs(props.get('DESCRIPTION')?.value ?? '')
    : null;
  const location = props.has('LOCATION') ? unescapeIcs(props.get('LOCATION')?.value ?? '') : null;
  const organizer = props.has('ORGANIZER')
    ? cleanMailto(props.get('ORGANIZER')?.value ?? '')
    : null;

  const startProp = props.get('DTSTART');
  const endProp = props.get('DTEND');
  const start = startProp ? parseDateTime(startProp) : null;
  const end = endProp ? parseDateTime(endProp) : null;

  const allDay =
    !!startProp && (startProp.params.get('VALUE') === 'DATE' || /^\d{8}$/.test(startProp.value));

  return {
    uid: props.get('UID')?.value ?? `${summary}-${start ?? 0}`,
    summary,
    description,
    location,
    organizer,
    attendees,
    start,
    end,
    allDay,
    calendar,
  };
}

/**
 * Parse iCal date / datetime to Unix ms. Supports:
 *   YYYYMMDD                       (all-day)
 *   YYYYMMDDTHHMMSSZ               (UTC)
 *   YYYYMMDDTHHMMSS                (floating local — assume UTC)
 */
function parseDateTime(prop: RawProp): number | null {
  const v = prop.value;
  if (/^\d{8}$/.test(v)) {
    const [y, m, d] = [+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8)];
    return Date.UTC(y, m, d);
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  const [, ys, ms, ds, hs, ns, ss] = m;
  return Date.UTC(Number(ys), Number(ms) - 1, Number(ds), Number(hs), Number(ns), Number(ss));
}

/**
 * Decode the small set of RFC 5545 escapes we care about: `\n`, `\,`, `\;`,
 * `\\`. Done in a single pass so emitted characters can't be re-decoded.
 */
function unescapeIcs(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === 'n' || next === 'N') out += '\n';
      else if (next === ',' || next === ';' || next === '\\') out += next;
      else out += next ?? '';
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function cleanMailto(s: string): string {
  return s.replace(/^mailto:/i, '');
}
