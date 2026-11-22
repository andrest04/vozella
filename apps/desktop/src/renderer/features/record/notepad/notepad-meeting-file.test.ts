// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { parseMeetingMarkdown, renderMeetingMarkdown, type MeetingRecord } from '@vozella/core';
import { afterAll, describe, expect, it } from 'vitest';
import { notepadExtensions } from './notepad-extensions';

/*
 * The notepad's notes reach disk as Markdown: Notepad sends `editor.getMarkdown()` trimmed (or ''
 * for an empty editor) to main, the save puts that text in `MeetingRecord.notes`,
 * renderMeetingMarkdown writes the meeting file and parseMeetingMarkdown reads it back. When a take
 * is processed again, Notepad loads the same text into the editor with `contentType: 'markdown'`.
 * These cases pin that path end to end with the editor's real extensions and the real file format.
 */

const editor = new Editor({ extensions: notepadExtensions(), content: '' });
afterAll(() => {
  editor.destroy();
});

/** The text Notepad sends main for the document `markdown` describes (Notepad's `read`). */
function fromEditor(markdown: string): string {
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
  return editor.isEmpty ? '' : editor.getMarkdown().trim();
}

const RECORD: MeetingRecord = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Standup',
  recordedAt: '2026-09-01T12:00:00.0000000+00:00',
  endedAt: null,
  audioFilePath: '',
  sourcePath: null,
  projectId: null,
  summaryProvider: null,
  calendarEventId: null,
  calendarId: null,
  seriesId: null,
  joinUrl: null,
  noteTemplateId: null,
  attendees: [],
  brief: null,
  transcript: null,
  summary: null,
  actionItems: [],
  jevAnalysis: null,
  notes: null,
  followUp: null,
  projectPlan: null,
};

interface FileOptions {
  /** Other fields of the meeting, written to the same file. */
  readonly record?: Partial<MeetingRecord>;
  /** The file as a Windows editor saves it again: every line end becomes CRLF. */
  readonly crlf?: boolean;
}

/** The meeting file written with `notes`, then read back. Blank notes save as null. */
function throughFile(notes: string, options: FileOptions = {}): string | null {
  const file = renderMeetingMarkdown({
    ...RECORD,
    ...options.record,
    notes: notes.trim() === '' ? null : notes,
  });
  const text = options.crlf === true ? file.replace(/\n/g, '\r\n') : file;
  return parseMeetingMarkdown('x.md', text, { fileExists: () => false }).notes;
}

const MEETING_ID = '22222222-2222-2222-2222-222222222222';

/** Notes the editor stores exactly as written. */
const NOTES: readonly (readonly [string, string])[] = [
  ['paragraph', 'Call with the client about the budget.'],
  ['two paragraphs', 'First paragraph.\n\nSecond paragraph.'],
  ['soft break', 'line one\nline two'],
  ['hard break', 'line one  \nline two'],
  ['headings', '# Title\n\n## Decisions\n\n### Owners'],
  ['bullet list', '- one\n- two\n- three'],
  ['ordered list', '1. one\n2. two\n3. three'],
  ['nested bullets', '- one\n  - nested\n    - deeper\n- two'],
  ['ordered in bullet', '- one\n  1. first\n  2. second\n- two'],
  ['task list', '- [ ] send the deck\n- [x] book the room'],
  ['nested task list', '- [ ] parent\n  - [x] child'],
  ['bold, italic, strike', 'a **bold**, an *italic* and a ~~struck~~ word'],
  ['bold italic nesting', '**bold *and italic* text**'],
  ['inline code', 'run `pnpm check` now'],
  ['fenced code', '```ts\nconst a = 1;\n```'],
  ['code with a blank line', '```\na\n\nb\n```'],
  ['link', 'see [the plan](https://example.com/plan) first'],
  [
    'internal meeting link',
    `follow up on [Standup](https://meetinglive.local/meeting/${MEETING_ID})`,
  ],
  [
    'internal link with a time',
    `as said at [12:05](https://meetinglive.local/meeting/${MEETING_ID}?t=725)`,
  ],
  ['blockquote', '> one\n> two'],
  ['horizontal rule, like the frontmatter fence', 'above\n\n---\n\nbelow'],
  ['escaped syntax', 'cost \\* 3, snake\\_case, a \\[b\\] c'],
  ['unicode', 'Zażółć gęślą jaźń, 日本語, العربية'],
  ['emoji', 'Ship it 🚀 and 👍🏽 and 👨‍👩‍👧'],
  ['spanish accents', 'Reunión con José: ¿qué decidimos? Mañana, canción, pingüino.'],
  ['mixed document', '# Plan\n\n- [ ] one\n- [x] two\n\n> why\n\n```js\nrun();\n```\n\nEnd.'],
];

/** Notes with a line that is one of the meeting file's own section headers. */
const SECTION_MARKERS: readonly (readonly [string, string])[] = [
  ['Summary heading', '## Summary'],
  ['Transcript heading', '## Transcript'],
  ['Personal Notes heading', '## Personal Notes'],
  ['Action Items heading', '## Action Items'],
  ['Action Item Data heading', '## Action Item Data'],
  ['Jev heading', '## Jev'],
  ['Brief heading', '## Brief'],
  ['Follow-up heading', '## Follow-up'],
  ['Project plan heading', '## Project plan'],
  ['heading between paragraphs', 'intro\n\n## Summary\n\nafter'],
  ['heading over a ticked task', '## Transcript\n\n- [x] done'],
  ['header line inside a code block', '```\n## Personal Notes\n## Summary\n```'],
];

describe('notepad notes through the meeting file', () => {
  it.each([...NOTES, ...SECTION_MARKERS])('%s: the editor stores it as written', (_, input) => {
    expect(fromEditor(input)).toBe(input);
  });

  it.each([...NOTES, ...SECTION_MARKERS])('%s: the file gives the same text back', (_, input) => {
    const saved = fromEditor(input);
    expect(throughFile(saved)).toBe(saved);
  });

  it.each([...NOTES, ...SECTION_MARKERS])(
    '%s: the editor reloads the same document',
    (_, input) => {
      const saved = fromEditor(input);
      expect(fromEditor(throughFile(saved) ?? '')).toBe(saved);
    },
  );

  it.each(SECTION_MARKERS)(
    '%s: survives when another section also holds a header line',
    (_, input) => {
      const saved = fromEditor(input);
      const record = { summary: 'Recap\n## Transcript\nend', transcript: '[00:00] ## Summary' };
      expect(throughFile(saved, { record })).toBe(saved);
    },
  );

  it('keeps the notes apart from the sections written around them', () => {
    const saved = fromEditor('## Summary\n\n- [ ] ship\n\n> note');
    const file = renderMeetingMarkdown({
      ...RECORD,
      summary: 'The real summary.',
      actionItems: [{ text: 'Ship', isDone: false }],
      notes: saved,
      followUp: 'Mail the team.',
    });
    const read = parseMeetingMarkdown('x.md', file, { fileExists: () => false });
    expect(read).toMatchObject({
      summary: 'The real summary.',
      actionItems: [{ text: 'Ship', isDone: false }],
      notes: saved,
      followUp: 'Mail the team.',
    });
  });
});

describe('line ends and blank notes', () => {
  it('reads a file saved again with CRLF line ends as the same LF notes', () => {
    const saved = fromEditor('# Plan\n\n- one\n  - two\n\nline one  \nline two');
    expect(throughFile(saved, { crlf: true })).toBe(saved);
    expect(throughFile(saved, { crlf: true })).not.toContain('\r');
  });

  it('reads header lines in a CRLF file as notes, not as new sections', () => {
    const saved = fromEditor('intro\n\n## Summary\n\nafter');
    expect(throughFile(saved, { crlf: true })).toBe(saved);
  });

  it('keeps extra blank lines between blocks through the file and back into the editor', () => {
    const saved = fromEditor('one\n\n\n\ntwo');
    expect(saved).toBe('one\n\n\n\ntwo');
    expect(throughFile(saved)).toBe(saved);
    expect(fromEditor(throughFile(saved) ?? '')).toBe(saved);
  });

  it('sends an empty editor as empty text, which leaves the notes out of the file', () => {
    expect(fromEditor('')).toBe('');
    expect(throughFile(fromEditor(''))).toBeNull();
    expect(renderMeetingMarkdown({ ...RECORD, notes: null })).not.toContain('## Personal Notes');
  });

  it('keeps leading and trailing blank lines out of what is sent', () => {
    expect(fromEditor('\n\n  hello\n\n')).toBe('hello');
  });
});
