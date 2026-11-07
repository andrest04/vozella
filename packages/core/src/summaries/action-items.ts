import { parseDeadlineKind, type ActionItem, type ActionItemDeadline } from '../library/meeting';
import { withResolvedDeadlines } from './deadline-resolver';

/**
 * Checkbox line: `-`, `*` or `+` bullet, flexible spacing, a box holding a space or x/X,
 * and text after the box (B26). Numbered lists never match.
 */
const ACTION_ITEM = /^\s*[-*+]\s*\[([ xX])\]\s*(\S.*)$/;

/** A ` — `, ` – ` or ` - ` separator that starts an Owner/Due suffix (English or Spanish label). */
const SUFFIX_SEPARATOR = /\s+[—–-]\s+(?=(?:owner|responsable|due|fecha)\s*:)/i;
const SUFFIX = /^(owner|responsable|due|fecha)\s*:\s*(.*)$/is;
/** A kind token, optionally followed by the exact quote in straight or curly double quotes. */
const DUE_TOKEN = /^(\S+)(?:\s*(?:"([^"]*)"|“([^”]*)”))?$/;
const QUOTED = /^(?:"([^"]*)"|“([^”]*)”)$/;

export interface ActionItemParseOptions {
  /** The meeting's `recordedAt`; when given, deadline dates are resolved. */
  readonly recordedAt?: string;
  /** `YYYY-MM-DD` of the next session, for `next_meeting` deadlines. */
  readonly nextSessionDate?: string;
}

/** True when the line is a checkbox item line (used by the splitter fallback). */
export function isCheckboxLine(line: string): boolean {
  return ACTION_ITEM.test(line);
}

/**
 * Reads a `Due:` value. `<token> "<quote>"` gives a typed kind; `none` or nothing gives no
 * deadline; anything else (legacy `Due: Friday`) is kept as an `unknown` kind with no date.
 */
function parseDue(value: string): ActionItemDeadline | undefined {
  const due = value.trim();
  if (due === '') return undefined;
  const match = DUE_TOKEN.exec(due);
  const token = match?.[1] ?? '';
  if (match && token.toLowerCase() === 'none') return undefined;
  const kind = match ? parseDeadlineKind(token) : null;
  if (match && kind) return { quote: (match[2] ?? match[3] ?? '').trim(), kind };
  const quoted = QUOTED.exec(due);
  const quote = (quoted ? (quoted[1] ?? quoted[2] ?? '') : due).trim();
  return quote === '' ? undefined : { quote, kind: { type: 'unknown' } };
}

/** Splits `text — Owner: name — Due: token "quote"` into the item fields. */
function parseItemText(raw: string, isDone: boolean): ActionItem {
  const [head = '', ...suffixes] = raw.split(SUFFIX_SEPARATOR);
  let owner: string | undefined;
  let deadline: ActionItemDeadline | undefined;
  for (const suffix of suffixes) {
    const match = SUFFIX.exec(suffix.trim());
    if (!match) continue;
    const label = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';
    if (label === 'owner' || label === 'responsable') {
      const name = value.trim();
      owner = name === '' ? undefined : name;
    } else {
      deadline = parseDue(value);
    }
  }
  return {
    text: head.trim(),
    isDone,
    ...(owner === undefined ? {} : { owner }),
    ...(deadline === undefined ? {} : { deadline }),
  };
}

/**
 * Parses checkbox lines from a section body. Other lines are ignored. Owner and Due suffixes
 * become fields; with `options.recordedAt` the deadline dates are resolved too.
 */
export function parseActionItems(
  sectionBody: string | null | undefined,
  options: ActionItemParseOptions = {},
): ActionItem[] {
  if (sectionBody === null || sectionBody === undefined || sectionBody.trim() === '') return [];
  const items: ActionItem[] = [];
  for (const line of sectionBody.replace(/\r\n/g, '\n').split('\n')) {
    const match = ACTION_ITEM.exec(line);
    if (match) items.push(parseItemText((match[2] ?? '').trim(), match[1] !== ' '));
  }
  return options.recordedAt === undefined
    ? items
    : withResolvedDeadlines(items, options.recordedAt, options.nextSessionDate);
}

/** Renders `- [x] text` or `- [ ] text` per item, one newline each. Empty list gives ''. */
export function renderActionItems(items: readonly ActionItem[]): string {
  return items.map((item) => `- [${item.isDone ? 'x' : ' '}] ${item.text}\n`).join('');
}
