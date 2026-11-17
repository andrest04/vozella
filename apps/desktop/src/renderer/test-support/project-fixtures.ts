import type { ProjectDto, ProjectFileDto, ProjectListItemDto } from '@vozella/contracts';

export const guid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function projectItem(
  n: number,
  name: string,
  extra: Partial<ProjectListItemDto> = {},
): ProjectListItemDto {
  return {
    id: guid(n),
    name,
    description: '',
    pinned: false,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    meetingCount: 0,
    fileCount: 0,
    lastActivityAt: '2026-09-01T12:00:00.000Z',
    ...extra,
  };
}

export function projectOf(n: number, name: string, extra: Partial<ProjectDto> = {}): ProjectDto {
  return {
    id: guid(n),
    name,
    description: '',
    instructions: '',
    pinned: false,
    createdAt: '2026-09-01T12:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    ...extra,
  };
}

export function fileOf(
  n: number,
  name: string,
  extra: Partial<ProjectFileDto> = {},
): ProjectFileDto {
  return {
    id: guid(1000 + n),
    name,
    kind: 'text',
    sizeBytes: 3_000,
    pages: null,
    truncated: false,
    textChars: 2_900,
    sha256: 'a'.repeat(64),
    addedAt: '2026-09-02T12:00:00.000Z',
    ...extra,
  };
}
