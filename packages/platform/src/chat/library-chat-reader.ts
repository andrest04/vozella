import {
  compactMeetingId,
  newestFirst,
  pickMeetingsForChat,
  rankMeetingsForQuestion,
  type ChatMeetingReader,
  type ContextMeeting,
  type ContextProject,
  type MeetingListItem,
  type MeetingRepository,
  type ProjectRepository,
} from '@vozella/core';

export interface LibraryChatReaderDeps {
  readonly meetings: MeetingRepository;
  readonly projects: Pick<ProjectRepository, 'list'>;
}

/** A meeting the packer counts but never prints: not among the meetings picked for the send. */
const stub = (item: MeetingListItem): ContextMeeting => ({
  id: item.id,
  title: item.title,
  recordedAt: item.recordedAt,
  projectId: item.projectId,
  summary: null,
  notes: null,
  transcript: null,
  actionItems: [],
});

/**
 * Reads meetings for chat over the Markdown repository (B17). The list is the repository's own
 * light index, so a send never parses every transcript. With a question, the library's folded
 * search text (already cached for the Library search) ranks the candidates; only the picked
 * `MEETING_CAP` records (best hits, then newest) are read in full. The rest come back as stubs so
 * the packer's "Showing N of M" note still counts them.
 */
export class LibraryChatReader implements ChatMeetingReader {
  constructor(private readonly deps: LibraryChatReaderDeps) {}

  meetingById(id: string): Promise<ContextMeeting | null> {
    return this.deps.meetings.get(id);
  }

  async meetingsInProject(
    projectId: string,
    question?: string,
  ): Promise<readonly ContextMeeting[]> {
    const key = compactMeetingId(projectId);
    const { items } = await this.deps.meetings.list();
    return this.load(
      items.filter((item) => item.projectId !== null && compactMeetingId(item.projectId) === key),
      question,
    );
  }

  async listRecent(question?: string): Promise<readonly ContextMeeting[]> {
    const { items } = await this.deps.meetings.list();
    return this.load(items, question);
  }

  /** The project names the Project scope prints. Instructions and files come from the project context source. */
  async listProjects(): Promise<readonly ContextProject[]> {
    const { projects } = await this.deps.projects.list();
    return projects.map((project) => ({ id: project.id, name: project.name }));
  }

  /**
   * Citation check (B21): the id may be hex without hyphens. Answers the stored id so the page
   * can select the meeting. Reads the light list only.
   */
  async findMeetingId(id: string): Promise<string | null> {
    const key = compactMeetingId(id);
    const { items } = await this.deps.meetings.list();
    return items.find((item) => compactMeetingId(item.id) === key)?.id ?? null;
  }

  private async load(
    items: readonly MeetingListItem[],
    question: string | undefined,
  ): Promise<readonly ContextMeeting[]> {
    const ranked =
      question === undefined || question.trim() === ''
        ? []
        : await rankMeetingsForQuestion({
            items,
            question,
            bodies: (filter) => this.deps.meetings.bodies(filter),
          });
    const picked = pickMeetingsForChat(items, ranked);
    const chosen = new Set(picked.map((p) => compactMeetingId(p.item.id)));
    const records = await Promise.all(
      picked.map(async ({ item, rank }): Promise<ContextMeeting> => {
        const record = (await this.deps.meetings.get(item.id)) ?? stub(item);
        return rank === undefined ? record : { ...record, relevanceRank: rank };
      }),
    );
    const rest = [...items]
      .sort(newestFirst)
      .filter((item) => !chosen.has(compactMeetingId(item.id)))
      .map(stub);
    return [...records, ...rest];
  }
}
