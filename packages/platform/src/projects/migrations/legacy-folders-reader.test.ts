import { describe, expect, it } from 'vitest';
import { LegacyFoldersError, readLegacyFolders } from './legacy-folders-reader';

const ID = '1b7e0000-0000-4000-8000-000000000001';

describe('readLegacyFolders', () => {
  it('reads a list with a byte order mark, CRLF and any key case', () => {
    const text = `\uFEFF${JSON.stringify(
      [
        {
          ID: ID.toUpperCase(),
          Name: 'Work',
          ParentID: null,
          NOTE: 'Formal',
          createdAT: '2025-01-01T00:00:00Z',
        },
      ],
      null,
      2,
    ).replace(/\n/g, '\r\n')}`;
    expect(readLegacyFolders(text)).toEqual([
      {
        id: ID.toUpperCase(),
        name: 'Work',
        parentId: null,
        note: 'Formal',
        createdAt: '2025-01-01T00:00:00Z',
      },
    ]);
  });

  it('answers an empty list for `[]`', () => {
    expect(readLegacyFolders('[]')).toEqual([]);
  });

  it('keeps one all-null entry for each item that is not an object', () => {
    const blank = { id: null, name: null, parentId: null, note: null, createdAt: null };
    expect(readLegacyFolders(JSON.stringify([null, 7, 'text', true, [], [{ id: ID }]]))).toEqual(
      Array.from({ length: 6 }, () => blank),
    );
  });

  it('reads a field that is not a string as missing', () => {
    expect(
      readLegacyFolders(
        JSON.stringify([{ id: 5, name: { text: 'x' }, parentId: [ID], note: false, createdAt: 1 }]),
      ),
    ).toEqual([{ id: null, name: null, parentId: null, note: null, createdAt: null }]);
  });

  it('ignores keys it does not know', () => {
    expect(
      readLegacyFolders(JSON.stringify([{ id: ID, name: 'A', colorKey: 'red', iconKey: 'book' }])),
    ).toEqual([{ id: ID, name: 'A', parentId: null, note: null, createdAt: null }]);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['an object', '{"id":"x"}'],
    ['a string', '"folders"'],
    ['null', 'null'],
    ['nothing at all', ''],
  ])('throws a LegacyFoldersError for %s', (_name, text) => {
    expect(() => readLegacyFolders(text)).toThrow(LegacyFoldersError);
  });
});
