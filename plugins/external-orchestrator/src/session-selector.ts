export const SESSION_SELECTION_PAGE_SIZE = 50;
export const SESSION_SELECTION_MAX_PAGES = 5;
export const SESSION_SELECTION_MAX_ROWS = SESSION_SELECTION_PAGE_SIZE * SESSION_SELECTION_MAX_PAGES;

export interface SessionSelectionSummary {
  id: string;
  conversationId: string | null;
  projectId: string | null;
  updatedAt: number;
  endedAt: number | null;
  origin: { kind: string } | null;
}

export interface SessionSelectionLive {
  activeTurnId: string | null;
  blocked: string;
}

export interface SessionSelectionDetail {
  session: SessionSelectionSummary;
  live?: SessionSelectionLive | null;
}

export interface SessionSelectionPage {
  sessions: SessionSelectionSummary[];
  nextCursor: string | null;
  activeId: string | null;
}

/** Minimal structural seam; ControlClient can satisfy this without being imported here. */
export interface SessionSelectionClient {
  listSessions(options: { limit: number; cursor?: string }): Promise<SessionSelectionPage>;
  getSession(sessionId: string, options: { live: true }): Promise<SessionSelectionDetail | null>;
}

export type SessionSelectionSource = 'explicit' | 'selected' | 'active' | 'fallback';

export interface SelectedSession {
  source: SessionSelectionSource;
  session: SessionSelectionSummary;
  live: SessionSelectionLive;
  /** Snapshot used as a CAS fence by revalidateForMutation(). */
  conversationId: string;
  idle: boolean;
}

export type SessionSelectionErrorCode = 'session_not_found' | 'session_ineligible' | 'no_executor';

export class SessionSelectionError extends Error {
  constructor(
    readonly code: SessionSelectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionSelectionError';
  }
}

export interface SelectSessionOptions {
  sessionId?: string;
  projectId?: string;
}

export interface SessionSelectorOptions {
  pageSize?: number;
  maxPages?: number;
  maxRows?: number;
}

function boundedPositiveInt(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(ceiling, Math.trunc(value)));
}

function validIdentity(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function primeOrigin(origin: SessionSelectionSummary['origin']): boolean {
  return origin?.kind !== 'worker' && origin?.kind !== 'helper';
}

function projectMatches(session: SessionSelectionSummary, projectId: string | undefined): boolean {
  return projectId === undefined || session.projectId === projectId;
}

function eligibleDetail(detail: SessionSelectionDetail | null, projectId: string | undefined): detail is SessionSelectionDetail & { live: SessionSelectionLive } {
  if (!detail?.live) return false;
  const { session, live } = detail;
  return validIdentity(session.id)
    && validIdentity(session.conversationId)
    && session.endedAt === null
    && primeOrigin(session.origin)
    && projectMatches(session, projectId)
    && live.blocked === '';
}

function selected(source: SessionSelectionSource, detail: SessionSelectionDetail & { live: SessionSelectionLive }): SelectedSession {
  return {
    source,
    session: detail.session,
    live: detail.live,
    conversationId: detail.session.conversationId!,
    idle: detail.live.activeTurnId === null,
  };
}

/**
 * Process-local Prime selector for the standalone connector.
 *
 * It deliberately owns only a preference hint. Every returned target is fetched with live state,
 * and callers must use revalidateForMutation immediately before crossing a mutation boundary.
 */
export class SessionSelector {
  readonly #client: SessionSelectionClient;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #maxRows: number;
  #selectedSessionId: string | null = null;

  constructor(client: SessionSelectionClient, options: SessionSelectorOptions = {}) {
    this.#client = client;
    this.#pageSize = boundedPositiveInt(options.pageSize, SESSION_SELECTION_PAGE_SIZE, SESSION_SELECTION_PAGE_SIZE);
    this.#maxPages = boundedPositiveInt(options.maxPages, SESSION_SELECTION_MAX_PAGES, SESSION_SELECTION_MAX_PAGES);
    this.#maxRows = boundedPositiveInt(options.maxRows, SESSION_SELECTION_MAX_ROWS, SESSION_SELECTION_MAX_ROWS);
  }

  get selectedSessionId(): string | null {
    return this.#selectedSessionId;
  }

  clearSelected(): void {
    this.#selectedSessionId = null;
  }

  async select(options: SelectSessionOptions = {}): Promise<SelectedSession> {
    if (options.sessionId) {
      const explicit = await this.#readEligible(options.sessionId, options.projectId);
      if (!explicit) {
        const exists = await this.#client.getSession(options.sessionId, { live: true });
        throw new SessionSelectionError(
          exists ? 'session_ineligible' : 'session_not_found',
          exists ? 'The requested session is not an eligible Prime session.' : 'The requested session does not exist.',
        );
      }
      return this.#remember(selected('explicit', explicit));
    }

    if (this.#selectedSessionId) {
      const remembered = await this.#readEligible(this.#selectedSessionId, options.projectId);
      if (remembered) return this.#remember(selected('selected', remembered));
      this.#selectedSessionId = null;
    }

    const firstPage = await this.#client.listSessions({ limit: this.#pageSize });
    if (firstPage.activeId) {
      const active = await this.#readEligible(firstPage.activeId, options.projectId);
      if (active) return this.#remember(selected('active', active));
    }

    const fallback = await this.#fallback(firstPage, options.projectId);
    if (!fallback) throw new SessionSelectionError('no_executor', 'No eligible Prime session is available.');
    return this.#remember(fallback);
  }

  /**
   * Re-read identity + live state and require the same conversation selected earlier. This is the
   * mutation-time CAS fence against compaction, supersession, blocking, ending or project changes.
   */
  async revalidateForMutation(selection: SelectedSession, projectId?: string): Promise<SelectedSession> {
    const detail = await this.#readEligible(selection.session.id, projectId);
    if (!detail || detail.session.conversationId !== selection.conversationId) {
      throw new SessionSelectionError('session_ineligible', 'The selected Prime session changed before the mutation could be issued.');
    }
    return this.#remember(selected(selection.source, detail));
  }

  async #readEligible(sessionId: string, projectId: string | undefined): Promise<(SessionSelectionDetail & { live: SessionSelectionLive }) | null> {
    const detail = await this.#client.getSession(sessionId, { live: true });
    return eligibleDetail(detail, projectId) ? detail : null;
  }

  async #fallback(firstPage: SessionSelectionPage, projectId: string | undefined): Promise<SelectedSession | null> {
    const summaries: SessionSelectionSummary[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let page = firstPage;
    let pageCount = 0;
    let rowCount = 0;

    for (;;) {
      pageCount += 1;
      rowCount += page.sessions.length;
      if (pageCount > this.#maxPages || rowCount > this.#maxRows) {
        throw new SessionSelectionError('no_executor', 'Prime session selection exceeded its bounded scan; refusing to guess.');
      }
      for (const summary of page.sessions) {
        if (seenIds.has(summary.id)) continue;
        seenIds.add(summary.id);
        if (!validIdentity(summary.conversationId) || summary.endedAt !== null || !primeOrigin(summary.origin) || !projectMatches(summary, projectId)) continue;
        summaries.push(summary);
      }

      const cursor = page.nextCursor;
      if (!cursor) break;
      if (pageCount >= this.#maxPages || rowCount >= this.#maxRows || seenCursors.has(cursor)) {
        throw new SessionSelectionError('no_executor', 'Prime session selection exceeded its bounded scan; refusing to guess.');
      }
      seenCursors.add(cursor);
      page = await this.#client.listSessions({ limit: this.#pageSize, cursor });
    }

    const candidates: SelectedSession[] = [];
    for (const summary of summaries) {
      const detail = await this.#readEligible(summary.id, projectId);
      if (detail) candidates.push(selected('fallback', detail));
    }
    candidates.sort((left, right) => {
      if (left.idle !== right.idle) return left.idle ? -1 : 1;
      if (left.session.updatedAt !== right.session.updatedAt) return right.session.updatedAt - left.session.updatedAt;
      return left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0;
    });
    return candidates[0] ?? null;
  }

  #remember(selection: SelectedSession): SelectedSession {
    this.#selectedSessionId = selection.session.id;
    return selection;
  }
}
