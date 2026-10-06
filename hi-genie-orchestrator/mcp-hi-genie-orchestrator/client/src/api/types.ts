export type WorkstreamStatus =
  | 'ACTIVE'
  | 'BLOCKED'
  | 'BLOCKED_BY_DEPENDENCY'
  | 'READY_FOR_REVIEW'
  | 'UNDER_REVIEW'
  | 'FIX_REQUIRED'
  | 'COMPLETE'
  | 'NOT_STARTED';

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
export type Severity = 'BLOCKING' | 'REQUIRED_FIX' | 'ADVISORY';

export interface ResponseMeta {
  correlationId: string;
  lastUpdatedAt: string;
  stale?: boolean;
}

export interface Scope {
  projectId: string;
  orchestrationId: string;
  environment: string;
}

export interface HealthItem {
  name: string;
  state: HealthState;
  detail: string;
}

export interface WorkstreamSummary {
  id: string;
  key: string;
  title: string;
  goal: string;
  status: WorkstreamStatus;
  executionTier: string;
  owner: string;
  dependencyIds: string[];
  dependencySummary: string;
  latestAttempt: number;
  reviewState: string;
  updatedAt: string;
  completionRationale?: string;
}

export interface AttentionItem {
  id: string;
  workstreamId: string;
  title: string;
  reason: string;
  severity: Severity;
  dependencyImpact: number;
}

export interface ActivityItem {
  id: string;
  type: 'workstream' | 'review' | 'session';
  title: string;
  detail: string;
  timestamp: string;
  href: string;
}

export interface OverviewReadModel {
  meta: ResponseMeta;
  scope: Scope;
  summary: Record<'total' | 'active' | 'blocked' | 'readyForReview' | 'complete', number>;
  completionPercent: number;
  attention: AttentionItem[];
  activity: ActivityItem[];
  health: HealthItem[];
}

export interface WorkstreamsReadModel {
  meta: ResponseMeta;
  scope: Scope;
  items: WorkstreamSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface WorkstreamDetailReadModel {
  meta: ResponseMeta;
  scope: Scope;
  item: WorkstreamSummary;
}

export interface GraphNode {
  id: string;
  key: string;
  title: string;
  status: WorkstreamStatus;
  executionTier: string;
  dependsOn: string[];
  x: number;
  y: number;
}

export interface GraphReadModel {
  meta: ResponseMeta;
  scope: Scope;
  nodes: GraphNode[];
}

export interface ReviewFinding {
  id: string;
  workstreamId: string;
  workstreamKey: string;
  reviewAttempt: number;
  lifecycleState: string;
  leaseState: string;
  severity: Severity;
  title: string;
  requiredAction: string;
  remediationStatus: string;
  evidenceFreshness: string;
  artifactVersion: string;
  reviewer: string;
  reviewedAt: string;
}

export interface ReviewsReadModel {
  meta: ResponseMeta;
  scope: Scope;
  items: ReviewFinding[];
}

export interface SessionSummary {
  id: string;
  workstreamId: string;
  workstreamKey: string;
  actor: string;
  startedAt: string;
  endedAt: string;
  outcome: string;
  summary: string;
  decisions: string[];
  errors: string[];
  artifacts: string[];
  nextSteps: string[];
}

export interface SessionsReadModel {
  meta: ResponseMeta;
  scope: Scope;
  items: SessionSummary[];
  limit: number;
}

export interface ConfigHistoryItem {
  version: string;
  changedAt: string;
  changedBy: string;
  summary: string;
}

export interface SystemReadModel {
  meta: ResponseMeta;
  scope: Scope;
  health: HealthItem[];
  schemaVersion: string;
  migrationStatus: string;
  runtimeSettings: Record<string, string | number | boolean>;
  configurationVersion: string;
  configurationHistory: ConfigHistoryItem[];
}
