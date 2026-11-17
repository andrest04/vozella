import fs from 'node:fs';
import path from 'node:path';

export interface SeedMeeting {
  readonly id: string;
  readonly title: string;
  readonly recordedAt: string;
  /** The ruling and the duration in the row come from this; absent means no length is known. */
  readonly endedAt?: string;
  readonly attendees?: readonly string[];
  readonly summary?: string;
  readonly transcript?: string;
  /** Directory under the library root; Inbox by default. */
  readonly directory?: string;
  readonly projectId?: string;
  /** Puts a recording beside the Markdown, named after it, and says so in the meeting. */
  readonly withAudio?: boolean;
}

/** Writes a meeting the way the app stores it, into a throwaway library root. */
export function writeMeeting(libraryRoot: string, meeting: SeedMeeting): string {
  const directory = path.join(libraryRoot, meeting.directory ?? 'Inbox');
  fs.mkdirSync(directory, { recursive: true });
  const stem = `${meeting.recordedAt.slice(0, 10)} ${meeting.title}`;
  const audioPath = path.join(directory, `${stem}.wav`);
  if (meeting.withAudio) fs.writeFileSync(audioPath, Buffer.from('RIFF....WAVEfmt ', 'latin1'));
  const lines = [
    '---',
    `id: ${meeting.id}`,
    `title: ${meeting.title}`,
    `recordedAt: ${meeting.recordedAt}`,
    ...(meeting.endedAt ? [`endedAt: ${meeting.endedAt}`] : []),
    ...(meeting.attendees?.length ? [`attendees: ${meeting.attendees.join(' | ')}`] : []),
    `audioFilePath: ${meeting.withAudio ? audioPath : ''}`,
    // `folderId` is the on-disk key of a meeting's project id.
    ...(meeting.projectId ? [`folderId: ${meeting.projectId}`] : []),
    '---',
    '',
  ];
  if (meeting.transcript) lines.push('## Transcript', '', meeting.transcript, '');
  if (meeting.summary) lines.push('## Summary', '', meeting.summary, '');
  const file = path.join(directory, `${stem}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

/** A project or folder id for a spec: the same shape every time, so a seeded id reads at a glance. */
export const guid = (n: number): string => `1b7e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface LegacyFolderSeed {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly note?: string | null;
  readonly createdAt?: string;
}

/**
 * The folder list of an older version as it was written on Windows: a byte order mark, CRLF line
 * ends, and the first entry with PascalCase keys, the way the old writer left some of them.
 */
export function legacyFolderBytes(folders: readonly LegacyFolderSeed[]): Buffer {
  const entries = folders.map((folder, index) => {
    const createdAt = folder.createdAt ?? `2025-03-0${String((index % 9) + 1)}T10:00:00-05:00`;
    return index === 0
      ? {
          Id: folder.id.toUpperCase(),
          Name: folder.name,
          ParentId: folder.parentId,
          Note: folder.note ?? null,
          CreatedAt: createdAt,
        }
      : {
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
          note: folder.note ?? null,
          createdAt,
        };
  });
  const text = JSON.stringify(entries, null, 2).replace(/\n/g, '\r\n');
  return Buffer.from(`\uFEFF${text}`, 'utf8');
}

/** A throwaway data root keeps the library in `meetings` and the settings in `app`. */
export const libraryOf = (dataRoot: string): string => path.join(dataRoot, 'meetings');
export const appDataOf = (dataRoot: string): string => path.join(dataRoot, 'app');

/** Puts a legacy `folders.json` in the library of a data root and returns the exact bytes. */
export function writeLegacyFolders(
  dataRoot: string,
  folders: readonly LegacyFolderSeed[],
  where: 'library' | 'app-data' = 'library',
): Buffer {
  const dir = where === 'library' ? libraryOf(dataRoot) : appDataOf(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  const bytes = legacyFolderBytes(folders);
  fs.writeFileSync(path.join(dir, 'folders.json'), bytes);
  return bytes;
}

/** A one-page PDF with one line of text: enough for pdfjs to read a page back. */
export function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with stored (uncompressed) entries: all a .docx needs to be opened. */
function storedZip(entries: readonly { readonly name: string; readonly data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** A Word document with one paragraph per line given. */
export function minimalDocx(paragraphs: readonly string[]): Buffer {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    },
  ];
  return storedZip(entries);
}
