import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowRight, List, Network, Search } from 'lucide-react';
import { uiBffClient } from '../api/client';
import type {
  GraphNode,
  GraphReadModel,
  OverviewReadModel,
  ReviewsReadModel,
  SessionsReadModel,
  SystemReadModel,
  WorkstreamsReadModel,
  WorkstreamStatus,
} from '../api/types';
import { Card, DataState, HealthBadge, PageHeader, ScopeBar, SeverityBadge, StatusBadge } from '../components/ui';
import { useReadModel } from '../hooks/useReadModel';
import { formatDate } from '../lib/utils';

const loadOverview = (signal: AbortSignal) => uiBffClient.getOverview(signal);
const loadWorkstreams = (signal: AbortSignal) => uiBffClient.getWorkstreams(signal);
const loadGraph = (signal: AbortSignal) => uiBffClient.getGraph('orch-r1-readiness', signal);
const loadReviews = (signal: AbortSignal) => uiBffClient.getReviews(signal);
const loadSessions = (signal: AbortSignal) => uiBffClient.getSessions(signal);
const loadSystem = (signal: AbortSignal) => uiBffClient.getSystem(signal);
const hasNoWorkstreams = (data: WorkstreamsReadModel) => data.items.length === 0;
const hasNoGraphNodes = (data: GraphReadModel) => data.nodes.length === 0;
const hasNoReviews = (data: ReviewsReadModel) => data.items.length === 0;
const hasNoSessions = (data: SessionsReadModel) => data.items.length === 0;

export function OverviewPage() {
  const model = useReadModel<OverviewReadModel>(loadOverview);
  return (
    <DataState state={model.state} onRetry={model.refresh}>
      {(data) => (
        <>
          <PageHeader
            title="Overview"
            description="Current orchestration status, attention, and system readiness."
            meta={data.meta}
            onRefresh={model.refresh}
          />
          <ScopeBar scope={data.scope} />
          <div className="metric-grid" aria-label="Workstream status summary">
            {Object.entries(data.summary).map(([key, value]) => (
              <Card key={key} className={key === 'blocked' ? 'metric-alert' : ''}>
                <span className="metric-value">{value}</span>
                <span className="metric-label">{labelMetric(key)}</span>
              </Card>
            ))}
          </div>
          <div className="overview-grid">
            <Card eyebrow="Prioritized" title="Attention queue" className="attention-panel">
              {data.attention.length ? (
                <ol className="attention-list">
                  {data.attention.map((item) => (
                    <li key={item.id}>
                      <SeverityBadge severity={item.severity} />
                      <div>
                        <Link to={`/workstreams?focus=${item.workstreamId}`}>{item.title}</Link>
                        <p>{item.reason}</p>
                        <span>
                          {item.dependencyImpact} downstream workstream{item.dependencyImpact === 1 ? '' : 's'} affected
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="empty-inline">No items require attention.</p>
              )}
            </Card>
            <Card title="Persisted completion">
              <div
                className="completion-ring"
                style={{ '--progress': `${data.completionPercent * 3.6}deg` } as React.CSSProperties}
              >
                <span>{data.completionPercent}%</span>
              </div>
              <p className="supporting-text">Calculated by the backend from persisted workstream state.</p>
            </Card>
          </div>
          <Card title="System health">
            <div className="health-grid">
              {data.health.map((item) => (
                <div key={item.name}>
                  <span>{item.name}</span>
                  <HealthBadge state={item.state} />
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>
          </Card>
          <Card title="Recent activity">
            <ul className="activity-list">
              {data.activity.map((item) => (
                <li key={item.id}>
                  <span className="activity-icon" aria-hidden="true">
                    <ArrowRight size={15} />
                  </span>
                  <div>
                    <Link to={item.href}>{item.title}</Link>
                    <p>{item.detail}</p>
                  </div>
                  <time dateTime={item.timestamp}>{formatDate(item.timestamp)}</time>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </DataState>
  );
}

export function WorkstreamsPage() {
  const model = useReadModel<WorkstreamsReadModel>(loadWorkstreams, hasNoWorkstreams);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<WorkstreamStatus | 'ALL'>('ALL');
  return (
    <DataState state={model.state} onRetry={model.refresh}>
      {(data) => {
        const filtered = data.items.filter(
          (item) =>
            (status === 'ALL' || item.status === status) &&
            `${item.key} ${item.title} ${item.id}`.toLowerCase().includes(query.toLowerCase())
        );
        return (
          <>
            <PageHeader
              title="Workstreams"
              description="Search and inspect persisted workstream state without changing it."
              meta={data.meta}
              onRefresh={model.refresh}
            />
            <ScopeBar scope={data.scope} />
            <div className="filter-bar">
              <label>
                <span>Search</span>
                <div className="input-with-icon">
                  <Search size={16} aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Name, key, or ID"
                  />
                </div>
              </label>
              <label>
                <span>Status</span>
                <select value={status} onChange={(event) => setStatus(event.target.value as WorkstreamStatus | 'ALL')}>
                  <option value="ALL">All statuses</option>
                  {[
                    'ACTIVE',
                    'BLOCKED',
                    'BLOCKED_BY_DEPENDENCY',
                    'READY_FOR_REVIEW',
                    'UNDER_REVIEW',
                    'FIX_REQUIRED',
                    'COMPLETE',
                    'NOT_STARTED',
                  ].map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
              </label>
            </div>
            <Card>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">Bounded list of workstreams</caption>
                  <thead>
                    <tr>
                      <th>Workstream</th>
                      <th>Status</th>
                      <th>Tier / owner</th>
                      <th>Dependencies</th>
                      <th>Attempt</th>
                      <th>Review</th>
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.key}</strong>
                          <span>{item.title}</span>
                          <code>{item.id}</code>
                        </td>
                        <td>
                          <StatusBadge status={item.status} />
                        </td>
                        <td>
                          {item.executionTier}
                          <span>{item.owner}</span>
                        </td>
                        <td>{item.dependencySummary}</td>
                        <td>#{item.latestAttempt}</td>
                        <td>{item.reviewState.replaceAll('_', ' ').toLowerCase()}</td>
                        <td>
                          <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && <div className="empty-table">No workstreams match these filters.</div>}
              </div>
              <footer className="pagination">
                Showing {filtered.length} of {data.total} bounded records · Page {data.page}
              </footer>
            </Card>
          </>
        );
      }}
    </DataState>
  );
}

export function GraphPage() {
  const model = useReadModel<GraphReadModel>(loadGraph, hasNoGraphNodes);
  const [mode, setMode] = useState<'graph' | 'list'>('graph');
  const [selectedId, setSelectedId] = useState<string>();
  return (
    <DataState state={model.state} onRetry={model.refresh}>
      {(data) => {
        const selected = data.nodes.find((node) => node.id === selectedId);
        return (
          <>
            <PageHeader
              title="Dependency graph"
              description="Persisted workstream dependencies with an equivalent accessible list."
              meta={data.meta}
              onRefresh={model.refresh}
            />
            <ScopeBar scope={data.scope} />
            <div className="view-switch" aria-label="Graph display mode">
              <button type="button" aria-pressed={mode === 'graph'} onClick={() => setMode('graph')}>
                <Network size={16} />
                Graph
              </button>
              <button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
                <List size={16} />
                Accessible list
              </button>
            </div>
            {mode === 'graph' ? (
              <Card className="graph-panel">
                <DependencyGraph nodes={data.nodes} selectedId={selectedId} onSelect={setSelectedId} />
              </Card>
            ) : (
              <GraphList nodes={data.nodes} />
            )}
            {selected && (
              <Card eyebrow="Selected node" title={`${selected.key} · ${selected.title}`}>
                <div className="detail-row">
                  <StatusBadge status={selected.status} />
                  <span>{selected.executionTier}</span>
                  <span>
                    {selected.dependsOn.length ? `Depends on ${selected.dependsOn.join(', ')}` : 'No dependencies'}
                  </span>
                  <Link to={`/workstreams?focus=${selected.id}`}>
                    Open workstream <ArrowRight size={14} />
                  </Link>
                </div>
              </Card>
            )}
          </>
        );
      }}
    </DataState>
  );
}

function DependencyGraph({
  nodes,
  selectedId,
  onSelect,
}: {
  nodes: GraphNode[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  return (
    <div className="graph-scroll">
      <svg
        className="dependency-graph"
        viewBox="0 0 700 380"
        role="img"
        aria-labelledby="graph-title graph-description"
      >
        <title id="graph-title">Workstream dependency graph</title>
        <desc id="graph-description">
          Six workstreams connected by persisted dependency relationships. Use accessible list mode for equivalent
          tabular information.
        </desc>
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {nodes.flatMap((node) =>
          node.dependsOn.map((dependencyId) => {
            const dependency = byId.get(dependencyId);
            return dependency ? (
              <line
                key={`${dependencyId}-${node.id}`}
                x1={dependency.x + 80}
                y1={dependency.y + 28}
                x2={node.x}
                y2={node.y + 28}
                className="graph-edge"
                markerEnd="url(#arrow)"
              />
            ) : null;
          })
        )}
        {nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
            <foreignObject width="170" height="86">
              <button
                type="button"
                className={`graph-node status-border-${node.status.toLowerCase()} ${selectedId === node.id ? 'selected' : ''}`}
                onClick={() => onSelect(node.id)}
                aria-label={`${node.key}, ${node.title}, ${node.status.replaceAll('_', ' ').toLowerCase()}`}
              >
                <strong>{node.key}</strong>
                <span>{node.title}</span>
                <small>{node.status.replaceAll('_', ' ').toLowerCase()}</small>
              </button>
            </foreignObject>
          </g>
        ))}
      </svg>
    </div>
  );
}

function GraphList({ nodes }: { nodes: GraphNode[] }) {
  return (
    <Card title="Dependency list">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Workstream</th>
              <th>Status</th>
              <th>Tier</th>
              <th>Depends on</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((node) => (
              <tr key={node.id}>
                <td>
                  <strong>{node.key}</strong>
                  <span>{node.title}</span>
                </td>
                <td>
                  <StatusBadge status={node.status} />
                </td>
                <td>{node.executionTier}</td>
                <td>{node.dependsOn.length ? node.dependsOn.join(', ') : 'None'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ReviewsPage() {
  const model = useReadModel<ReviewsReadModel>(loadReviews, hasNoReviews);
  return (
    <DataState state={model.state} onRetry={model.refresh} emptyTitle="No review findings">
      {(data) => (
        <>
          <PageHeader
            title="Reviews"
            description="Review lifecycle, evidence freshness, and required remediation."
            meta={data.meta}
            onRefresh={model.refresh}
          />
          <ScopeBar scope={data.scope} />
          <div className="stack">
            {data.items.map((item) => (
              <Card key={item.id} className="review-card">
                <div className="review-heading">
                  <div>
                    <SeverityBadge severity={item.severity} />
                    <h3>{item.title}</h3>
                    <Link to={`/workstreams?focus=${item.workstreamId}`}>
                      {item.workstreamKey} · review attempt {item.reviewAttempt}
                    </Link>
                  </div>
                  <span className="review-state">
                    {item.lifecycleState.toLowerCase()} · {item.leaseState.toLowerCase()}
                  </span>
                </div>
                <dl className="details-grid">
                  <div>
                    <dt>Required action</dt>
                    <dd>{item.requiredAction}</dd>
                  </div>
                  <div>
                    <dt>Remediation</dt>
                    <dd>{item.remediationStatus.replaceAll('_', ' ').toLowerCase()}</dd>
                  </div>
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      {item.evidenceFreshness} · <code>{item.artifactVersion}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Reviewer</dt>
                    <dd>
                      {item.reviewer}
                      <br />
                      <time dateTime={item.reviewedAt}>{formatDate(item.reviewedAt)}</time>
                    </dd>
                  </div>
                </dl>
              </Card>
            ))}
          </div>
        </>
      )}
    </DataState>
  );
}

export function SessionsPage() {
  const model = useReadModel<SessionsReadModel>(loadSessions, hasNoSessions);
  return (
    <DataState state={model.state} onRetry={model.refresh} emptyTitle="No session summaries">
      {(data) => (
        <>
          <PageHeader
            title="Sessions"
            description="Bounded, redacted summaries and structured handoff context."
            meta={data.meta}
            onRefresh={model.refresh}
          />
          <ScopeBar scope={data.scope} />
          <p className="privacy-note">
            <AlertTriangle size={16} aria-hidden="true" />
            Raw transcripts and unrestricted payloads are intentionally excluded.
          </p>
          <div className="stack">
            {data.items.map((item) => (
              <Card key={item.id} eyebrow={`${item.workstreamKey} · ${item.outcome.toLowerCase()}`} title={item.id}>
                <div className="session-meta">
                  <span>{item.actor}</span>
                  <span>
                    {formatDate(item.startedAt)} – {formatDate(item.endedAt)}
                  </span>
                </div>
                <p>{item.summary}</p>
                <div className="session-columns">
                  <StructuredList title="Decisions" items={item.decisions} />
                  <StructuredList title="Errors" items={item.errors} />
                  <StructuredList title="Artifacts" items={item.artifacts} />
                  <StructuredList title="Next steps" items={item.nextSteps} />
                </div>
              </Card>
            ))}
          </div>
          <p className="pagination">Showing up to {data.limit} summaries.</p>
        </>
      )}
    </DataState>
  );
}

function StructuredList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <span className="supporting-text">None reported</span>
      )}
    </div>
  );
}

export function SystemPage() {
  const model = useReadModel<SystemReadModel>(loadSystem);
  return (
    <DataState state={model.state} onRetry={model.refresh}>
      {(data) => (
        <>
          <PageHeader
            title="System"
            description="Read-only platform health, runtime settings, and configuration history."
            meta={data.meta}
            onRefresh={model.refresh}
          />
          <ScopeBar scope={data.scope} />
          <div className="health-grid system-health">
            {data.health.map((item) => (
              <Card key={item.name}>
                <span>{item.name}</span>
                <HealthBadge state={item.state} />
                <small>{item.detail}</small>
              </Card>
            ))}
          </div>
          <div className="two-column">
            <Card title="Platform state">
              <dl className="details-grid">
                <div>
                  <dt>Schema version</dt>
                  <dd>
                    <code>{data.schemaVersion}</code>
                  </dd>
                </div>
                <div>
                  <dt>Migration status</dt>
                  <dd>{data.migrationStatus.toLowerCase()}</dd>
                </div>
                <div>
                  <dt>Configuration</dt>
                  <dd>
                    <code>{data.configurationVersion}</code>
                  </dd>
                </div>
              </dl>
            </Card>
            <Card title="Effective runtime settings">
              <dl className="settings-list">
                {Object.entries(data.runtimeSettings).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      <code>{String(value)}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
          <Card title="Immutable configuration history">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Changed</th>
                    <th>Actor</th>
                    <th>Summary</th>
                  </tr>
                </thead>
                <tbody>
                  {data.configurationHistory.map((item) => (
                    <tr key={item.version}>
                      <td>
                        <code>{item.version}</code>
                      </td>
                      <td>{formatDate(item.changedAt)}</td>
                      <td>{item.changedBy}</td>
                      <td>{item.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </DataState>
  );
}

function labelMetric(key: string) {
  return key.replace(/([A-Z])/g, ' $1').toLowerCase();
}
