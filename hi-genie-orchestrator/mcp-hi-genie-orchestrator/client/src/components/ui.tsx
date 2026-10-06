import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, RefreshCw } from 'lucide-react';
import type { HealthState, ResponseMeta, Scope, Severity, WorkstreamStatus } from '../api/types';
import { formatDate } from '../lib/utils';

const statusLabels: Record<WorkstreamStatus, string> = {
  ACTIVE: 'Active',
  BLOCKED: 'Blocked',
  BLOCKED_BY_DEPENDENCY: 'Dependency blocked',
  READY_FOR_REVIEW: 'Ready for review',
  UNDER_REVIEW: 'Under review',
  FIX_REQUIRED: 'Fix required',
  COMPLETE: 'Complete',
  NOT_STARTED: 'Not started',
};

export function StatusBadge({ status }: { status: WorkstreamStatus }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <span aria-hidden="true">●</span>
      {statusLabels[status]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={`status-badge severity-${severity.toLowerCase()}`}>
      <AlertTriangle size={13} aria-hidden="true" />
      {severity.replace('_', ' ').toLowerCase()}
    </span>
  );
}

export function HealthBadge({ state }: { state: HealthState }) {
  const Icon = state === 'HEALTHY' ? CheckCircle2 : state === 'DEGRADED' ? AlertTriangle : CircleDashed;
  return (
    <span className={`health-state health-${state.toLowerCase()}`}>
      <Icon size={15} aria-hidden="true" />
      {state.toLowerCase()}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  meta,
  onRefresh,
}: {
  title: string;
  description: string;
  meta?: ResponseMeta;
  onRefresh?: () => void;
}) {
  return (
    <header className="page-header">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      {meta && (
        <div className="refresh-group">
          <span>
            <Clock3 size={14} aria-hidden="true" /> Updated {formatDate(meta.lastUpdatedAt)}
          </span>
          <button className="secondary-button" type="button" onClick={onRefresh}>
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </button>
        </div>
      )}
    </header>
  );
}

export function ScopeBar({ scope }: { scope: Scope }) {
  return (
    <div className="scope-bar" aria-label="Current orchestration scope">
      <span>
        <strong>Project</strong> <code>{scope.projectId}</code>
      </span>
      <span>
        <strong>Orchestration</strong> <code>{scope.orchestrationId}</code>
      </span>
      <span>
        <strong>Environment</strong> {scope.environment}
      </span>
      <span className="read-only-pill">Read only</span>
    </div>
  );
}

export function DataState<T>({
  state,
  children,
  emptyTitle = 'No records found',
  emptyMessage = 'There is no data in this bounded result set.',
  onRetry,
}: {
  state: { status: 'loading' | 'success' | 'empty' | 'error'; data?: T; error?: Error };
  children: (data: T) => ReactNode;
  emptyTitle?: string;
  emptyMessage?: string;
  onRetry?: () => void;
}) {
  if (state.status === 'loading')
    return (
      <div className="skeleton-stack" aria-label="Loading data" aria-busy="true">
        <span />
        <span />
        <span />
      </div>
    );
  if (state.status === 'error')
    return (
      <div className="state-panel state-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <div>
          <h3>Unable to load this read model</h3>
          <p>{state.error?.message ?? 'The service is unavailable.'}</p>
          {onRetry && (
            <button className="secondary-button" type="button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  if (state.status === 'empty')
    return (
      <div className="state-panel">
        <CircleDashed aria-hidden="true" />
        <div>
          <h3>{emptyTitle}</h3>
          <p>{emptyMessage}</p>
        </div>
      </div>
    );
  return <>{children(state.data as T)}</>;
}

export function Card({
  title,
  eyebrow,
  children,
  className = '',
}: {
  title?: string;
  eyebrow?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || eyebrow) && (
        <header className="panel-header">
          {eyebrow && <span>{eyebrow}</span>}
          {title && <h3>{title}</h3>}
        </header>
      )}
      {children}
    </section>
  );
}
