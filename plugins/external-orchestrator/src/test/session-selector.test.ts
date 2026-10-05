import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SessionSelectionError,
  SessionSelector,
  type SessionSelectionClient,
  type SessionSelectionDetail,
  type SessionSelectionPage,
  type SessionSelectionSummary,
} from '../session-selector.js';

function summary(id: string, overrides: Partial<SessionSelectionSummary> = {}): SessionSelectionSummary {
  return {
    id,
    conversationId: `conversation-${id}`,
    projectId: 'project-a',
    updatedAt: 100,
    endedAt: null,
    origin: null,
    ...overrides,
  };
}

function detail(
  id: string,
  overrides: Partial<SessionSelectionSummary> = {},
  live: SessionSelectionDetail['live'] = { activeTurnId: null, blocked: '' },
): SessionSelectionDetail {
  return { session: summary(id, overrides), live };
}

function page(
  sessions: SessionSelectionSummary[],
  options: { activeId?: string | null; nextCursor?: string | null } = {},
): SessionSelectionPage {
  return {
    sessions,
    activeId: options.activeId ?? null,
    nextCursor: options.nextCursor ?? null,
  };
}

class FakeSelectionClient implements SessionSelectionClient {
  readonly listCalls: Array<{ limit: number; cursor?: string }> = [];
  readonly getCalls: string[] = [];
  readonly details = new Map<string, SessionSelectionDetail | null>();
  readonly pages = new Map<string, SessionSelectionPage>();
  firstPage: SessionSelectionPage = page([]);
  getSessionOverride: ((sessionId: string) => Promise<SessionSelectionDetail | null> | SessionSelectionDetail | null) | null = null;

  async listSessions(options: { limit: number; cursor?: string }): Promise<SessionSelectionPage> {
    this.listCalls.push({ ...options });
    if (options.cursor === undefined) return this.firstPage;
    const next = this.pages.get(options.cursor);
    if (!next) throw new Error(`Unexpected cursor ${options.cursor}`);
    return next;
  }

  async getSession(sessionId: string, _options: { live: true }): Promise<SessionSelectionDetail | null> {
    this.getCalls.push(sessionId);
    if (this.getSessionOverride) return this.getSessionOverride(sessionId);
    return this.details.get(sessionId) ?? null;
  }
}

async function expectSelectionError(
  promise: Promise<unknown>,
  code: InstanceType<typeof SessionSelectionError>['code'],
): Promise<void> {
  await assert.rejects(promise, error => error instanceof SessionSelectionError && error.code === code);
}

test('selection priority is explicit, remembered, active, then fallback', async () => {
  const client = new FakeSelectionClient();
  client.details.set('explicit-prime', detail('explicit-prime'));
  client.details.set('remembered-prime', detail('remembered-prime'));
  client.details.set('active-prime', detail('active-prime'));
  client.details.set('fallback-prime', detail('fallback-prime'));
  client.firstPage = page([summary('fallback-prime')], { activeId: 'active-prime' });

  const selector = new SessionSelector(client);
  const explicit = await selector.select({ sessionId: 'explicit-prime' });
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.session.id, 'explicit-prime');
  assert.equal(client.listCalls.length, 0, 'explicit selection must not consult active/fallback state');

  const remembered = await selector.select();
  assert.equal(remembered.source, 'selected');
  assert.equal(remembered.session.id, 'explicit-prime');
  assert.equal(client.listCalls.length, 0, 'remembered selection must win before active/fallback');

  selector.clearSelected();
  const active = await selector.select();
  assert.equal(active.source, 'active');
  assert.equal(active.session.id, 'active-prime');

  selector.clearSelected();
  client.details.set('active-prime', detail('active-prime', {}, { activeTurnId: null, blocked: 'blocked' }));
  const fallback = await selector.select();
  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.session.id, 'fallback-prime');
});

test('explicit selection refuses worker, helper, ended, no-chat, live-null, blocked and project-mismatched sessions', async () => {
  const cases: Array<[string, SessionSelectionDetail]> = [
    ['worker', detail('worker', { origin: { kind: 'worker' } })],
    ['helper', detail('helper', { origin: { kind: 'helper' } })],
    ['ended', detail('ended', { endedAt: 123 })],
    ['no-chat', detail('no-chat', { conversationId: null })],
    ['live-null', detail('live-null', {}, null)],
    ['blocked', detail('blocked', {}, { activeTurnId: null, blocked: 'blocked' })],
    ['wrong-project', detail('wrong-project', { projectId: 'project-b' })],
  ];

  for (const [id, value] of cases) {
    const client = new FakeSelectionClient();
    client.details.set(id, value);
    const selector = new SessionSelector(client);
    await expectSelectionError(selector.select({ sessionId: id, projectId: 'project-a' }), 'session_ineligible');
    assert.equal(selector.selectedSessionId, null, `${id} must not become remembered`);
  }
});

test('explicit missing session reports not-found instead of falling through to another Prime', async () => {
  const client = new FakeSelectionClient();
  client.firstPage = page([summary('fallback-prime')]);
  client.details.set('fallback-prime', detail('fallback-prime'));
  const selector = new SessionSelector(client);

  await expectSelectionError(selector.select({ sessionId: 'missing-session' }), 'session_not_found');
  assert.equal(client.listCalls.length, 0);
});

test('fallback ranking deterministically prefers idle, then newest updatedAt, then stable session id', async () => {
  const client = new FakeSelectionClient();
  const candidates = [
    summary('working-newest', { updatedAt: 900 }),
    summary('idle-old', { updatedAt: 200 }),
    summary('idle-z', { updatedAt: 500 }),
    summary('idle-a', { updatedAt: 500 }),
  ];
  client.firstPage = page(candidates);
  client.details.set('working-newest', detail('working-newest', { updatedAt: 900 }, { activeTurnId: 'turn-working', blocked: '' }));
  client.details.set('idle-old', detail('idle-old', { updatedAt: 200 }));
  client.details.set('idle-z', detail('idle-z', { updatedAt: 500 }));
  client.details.set('idle-a', detail('idle-a', { updatedAt: 500 }));

  const chosen = await new SessionSelector(client).select();
  assert.equal(chosen.source, 'fallback');
  assert.equal(chosen.session.id, 'idle-a');
  assert.equal(chosen.idle, true);
});

test('fallback scans bounded pages and refuses cursor loops instead of guessing', async () => {
  {
    const client = new FakeSelectionClient();
    client.firstPage = page([summary('first')], { nextCursor: 'page-2' });
    client.details.set('first', detail('first'));
    const selector = new SessionSelector(client, { maxPages: 1 });
    await expectSelectionError(selector.select(), 'no_executor');
    assert.deepEqual(client.listCalls, [{ limit: 50 }]);
  }

  {
    const client = new FakeSelectionClient();
    client.firstPage = page([], { nextCursor: 'loop' });
    client.pages.set('loop', page([], { nextCursor: 'loop' }));
    const selector = new SessionSelector(client, { maxPages: 3 });
    await expectSelectionError(selector.select(), 'no_executor');
    assert.deepEqual(client.listCalls, [{ limit: 50 }, { limit: 50, cursor: 'loop' }]);
  }

  {
    const client = new FakeSelectionClient();
    client.firstPage = page([summary('row-a'), summary('row-b')]);
    const selector = new SessionSelector(client, { maxRows: 1 });
    await expectSelectionError(selector.select(), 'no_executor');
  }
});

test('mutation revalidation preserves the same conversation and refreshes live state', async () => {
  const client = new FakeSelectionClient();
  client.details.set('prime', detail('prime', { conversationId: 'conversation-stable', updatedAt: 100 }));
  const selector = new SessionSelector(client);
  const selected = await selector.select({ sessionId: 'prime' });

  client.details.set('prime', detail(
    'prime',
    { conversationId: 'conversation-stable', updatedAt: 200 },
    { activeTurnId: 'turn-new', blocked: '' },
  ));
  const revalidated = await selector.revalidateForMutation(selected);
  assert.equal(revalidated.conversationId, 'conversation-stable');
  assert.equal(revalidated.session.updatedAt, 200);
  assert.equal(revalidated.live.activeTurnId, 'turn-new');
  assert.equal(revalidated.idle, false);
  assert.equal(selector.selectedSessionId, 'prime');
});

test('mutation revalidation rejects compaction/supersession and other eligibility changes', async () => {
  const client = new FakeSelectionClient();
  client.details.set('prime', detail('prime', { conversationId: 'conversation-before' }));
  const selector = new SessionSelector(client);
  const selected = await selector.select({ sessionId: 'prime', projectId: 'project-a' });

  client.details.set('prime', detail('prime', { conversationId: 'conversation-after' }));
  await expectSelectionError(selector.revalidateForMutation(selected, 'project-a'), 'session_ineligible');

  for (const replacement of [
    detail('prime', { conversationId: 'conversation-before', endedAt: 1 }),
    detail('prime', { conversationId: 'conversation-before', projectId: 'project-b' }),
    detail('prime', { conversationId: 'conversation-before' }, null),
    detail('prime', { conversationId: 'conversation-before' }, { activeTurnId: null, blocked: 'blocked' }),
    null,
  ]) {
    client.details.set('prime', replacement);
    await expectSelectionError(selector.revalidateForMutation(selected, 'project-a'), 'session_ineligible');
  }
});

test('read revalidation follows the same durable session across Compact & Resume without selecting another Prime', async () => {
  const client = new FakeSelectionClient();
  client.details.set('prime', detail('prime', { conversationId: 'conversation-a', updatedAt: 100 }));
  client.details.set('other-prime', detail('other-prime', { conversationId: 'conversation-other', updatedAt: 999 }));
  client.firstPage = page([summary('other-prime')], { activeId: 'other-prime' });
  const selector = new SessionSelector(client);
  const selected = await selector.select({ sessionId: 'prime', projectId: 'project-a' });

  client.details.set('prime', detail(
    'prime',
    { conversationId: 'conversation-b', updatedAt: 200 },
    { activeTurnId: 'turn-b', blocked: '' },
  ));

  const revalidated = await selector.revalidateForRead(selected, 'project-a');
  assert.equal(revalidated.session.id, 'prime');
  assert.equal(revalidated.conversationId, 'conversation-b');
  assert.equal(revalidated.session.updatedAt, 200);
  assert.equal(revalidated.live.activeTurnId, 'turn-b');
  assert.equal(selector.selectedSessionId, 'prime');
  assert.equal(client.listCalls.length, 0, 'read revalidation must never consult active/fallback Prime selection');
  await expectSelectionError(selector.revalidateForMutation(selected, 'project-a'), 'session_ineligible');
});

test('read revalidation retries the exact session once when compaction moves during the live read', async () => {
  const client = new FakeSelectionClient();
  client.details.set('prime', detail('prime', { conversationId: 'conversation-a' }));
  const selector = new SessionSelector(client);
  const selected = await selector.select({ sessionId: 'prime', projectId: 'project-a' });
  const snapshots = [
    detail('prime', { conversationId: 'conversation-b', updatedAt: 200 }, null),
    detail('prime', { conversationId: 'conversation-b', updatedAt: 201 }, { activeTurnId: 'turn-b', blocked: '' }),
  ];
  client.getSessionOverride = sessionId => {
    assert.equal(sessionId, 'prime');
    return snapshots.shift() ?? null;
  };

  const revalidated = await selector.revalidateForRead(selected, 'project-a');
  assert.equal(revalidated.session.id, 'prime');
  assert.equal(revalidated.conversationId, 'conversation-b');
  assert.equal(revalidated.session.updatedAt, 201);
  assert.deepEqual(client.getCalls.slice(-2), ['prime', 'prime']);
  assert.equal(client.listCalls.length, 0);
});

test('read revalidation rejects ineligible, superseded and wrong-session snapshots without fallback', async () => {
  const cases: Array<[string, SessionSelectionDetail | null, string | undefined]> = [
    ['worker', detail('prime', { origin: { kind: 'worker' } }), 'project-a'],
    ['helper', detail('prime', { origin: { kind: 'helper' } }), 'project-a'],
    ['ended', detail('prime', { endedAt: 1 }), 'project-a'],
    ['no-conversation', detail('prime', { conversationId: null }), 'project-a'],
    ['blocked', detail('prime', {}, { activeTurnId: null, blocked: 'blocked' }), 'project-a'],
    ['superseded', detail('prime', { conversationId: 'conversation-b' }, null), 'project-a'],
    ['project-mismatch', detail('prime', { projectId: 'project-b' }), undefined],
    ['wrong-session', detail('other-prime'), 'project-a'],
    ['missing', null, 'project-a'],
  ];

  for (const [name, replacement, projectId] of cases) {
    const client = new FakeSelectionClient();
    client.details.set('prime', detail('prime', { conversationId: 'conversation-a' }));
    client.details.set('other-prime', detail('other-prime'));
    client.firstPage = page([summary('other-prime')], { activeId: 'other-prime' });
    const selector = new SessionSelector(client);
    const selected = await selector.select({ sessionId: 'prime', projectId: 'project-a' });
    client.details.set('prime', replacement);

    await expectSelectionError(selector.revalidateForRead(selected, projectId), 'session_ineligible');
    assert.equal(selector.selectedSessionId, 'prime', `${name} must not retarget the remembered durable session`);
    assert.equal(client.listCalls.length, 0, `${name} must not consult another Prime`);
  }
});

test('read revalidation propagates stale read errors, including after a compaction-race retry', async () => {
  const client = new FakeSelectionClient();
  client.details.set('prime', detail('prime', { conversationId: 'conversation-a' }));
  const selector = new SessionSelector(client);
  const selected = await selector.select({ sessionId: 'prime', projectId: 'project-a' });
  const stale = new Error('stale control read');
  let reads = 0;
  client.getSessionOverride = () => {
    reads += 1;
    if (reads === 1) return detail('prime', { conversationId: 'conversation-b' }, null);
    throw stale;
  };

  await assert.rejects(selector.revalidateForRead(selected, 'project-a'), error => error === stale);
  assert.equal(reads, 2);
  assert.equal(selector.selectedSessionId, 'prime');
  assert.equal(client.listCalls.length, 0);
});
