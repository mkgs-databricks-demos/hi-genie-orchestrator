import {
  graphFixture,
  overviewFixture,
  reviewsFixture,
  sessionsFixture,
  systemFixture,
  workstreamDetailFixture,
  workstreamsFixture,
} from './fixtures';
import type {
  GraphReadModel,
  OverviewReadModel,
  ReviewsReadModel,
  SessionsReadModel,
  SystemReadModel,
  WorkstreamDetailReadModel,
  WorkstreamsReadModel,
} from './types';

export interface UiBffClient {
  getOverview(signal?: AbortSignal): Promise<OverviewReadModel>;
  getWorkstreams(signal?: AbortSignal): Promise<WorkstreamsReadModel>;
  getWorkstream(workstreamId: string, signal?: AbortSignal): Promise<WorkstreamDetailReadModel>;
  getGraph(orchestrationId: string, signal?: AbortSignal): Promise<GraphReadModel>;
  getReviews(signal?: AbortSignal): Promise<ReviewsReadModel>;
  getSessions(signal?: AbortSignal): Promise<SessionsReadModel>;
  getSystem(signal?: AbortSignal): Promise<SystemReadModel>;
}

export class UiBffError extends Error {
  readonly status?: number;
  readonly correlationId?: string;

  constructor(message: string, status?: number, correlationId?: string) {
    super(message);
    this.name = 'UiBffError';
    this.status = status;
    this.correlationId = correlationId;
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    throw new UiBffError(
      `UI read model request failed (${response.status})`,
      response.status,
      response.headers.get('x-correlation-id') ?? undefined
    );
  }
  return response.json() as Promise<T>;
}

export const liveUiBffClient: UiBffClient = {
  getOverview: (signal) => request('/api/v1/ui/overview', signal),
  getWorkstreams: (signal) => request('/api/v1/ui/workstreams', signal),
  getWorkstream: (workstreamId, signal) =>
    request(`/api/v1/ui/workstreams/${encodeURIComponent(workstreamId)}`, signal),
  getGraph: (orchestrationId, signal) =>
    request(`/api/v1/ui/orchestrations/${encodeURIComponent(orchestrationId)}/graph`, signal),
  getReviews: (signal) => request('/api/v1/ui/reviews', signal),
  getSessions: async (signal) => {
    const workstreamPage = await request<WorkstreamsReadModel>('/api/v1/ui/workstreams', signal);
    const sessionPages = await Promise.all(
      workstreamPage.items.map((workstream) =>
        request<SessionsReadModel>(`/api/v1/ui/workstreams/${encodeURIComponent(workstream.id)}/sessions`, signal)
      )
    );
    const firstPage = sessionPages[0];
    return {
      meta: firstPage?.meta ?? workstreamPage.meta,
      scope: firstPage?.scope ?? workstreamPage.scope,
      items: sessionPages.flatMap((page) => page.items).slice(0, 20),
      limit: 20,
    };
  },
  getSystem: (signal) => request('/api/v1/ui/system', signal),
};

const fixtureDelay = 180;
type FixtureState = 'loading' | 'error' | 'empty';

function getFixtureState(): FixtureState | undefined {
  const state = new URLSearchParams(window.location.search).get('fixtureState');
  return state === 'loading' || state === 'error' || state === 'empty' ? state : undefined;
}

function fixtureResponse<T>(value: T, signal?: AbortSignal, emptyValue?: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const fixtureState = getFixtureState();
    const timeout =
      fixtureState === 'loading'
        ? undefined
        : window.setTimeout(() => {
            if (fixtureState === 'error') {
              reject(new UiBffError('Fixture read model request failed', 503, 'fixture-error'));
              return;
            }
            resolve(structuredClone(fixtureState === 'empty' && emptyValue ? emptyValue : value));
          }, fixtureDelay);
    signal?.addEventListener(
      'abort',
      () => {
        if (timeout !== undefined) window.clearTimeout(timeout);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

export const fixtureUiBffClient: UiBffClient = {
  getOverview: (signal) => fixtureResponse(overviewFixture, signal),
  getWorkstreams: (signal) =>
    fixtureResponse(workstreamsFixture, signal, { ...workstreamsFixture, items: [], total: 0 }),
  getWorkstream: (workstreamId, signal) =>
    fixtureResponse(
      {
        ...workstreamDetailFixture,
        item: workstreamsFixture.items.find((item) => item.id === workstreamId) ?? workstreamDetailFixture.item,
      },
      signal
    ),
  getGraph: (_orchestrationId, signal) => fixtureResponse(graphFixture, signal, { ...graphFixture, nodes: [] }),
  getReviews: (signal) => fixtureResponse(reviewsFixture, signal, { ...reviewsFixture, items: [] }),
  getSessions: (signal) => fixtureResponse(sessionsFixture, signal, { ...sessionsFixture, items: [] }),
  getSystem: (signal) => fixtureResponse(systemFixture, signal),
};

export const uiBffClient = import.meta.env.VITE_UI_DATA_SOURCE === 'live' ? liveUiBffClient : fixtureUiBffClient;
