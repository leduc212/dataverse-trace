// In-memory indexes over the locally stored records, rebuilt whenever the store changes.
import {
  summarizeOperations,
  type AsyncOperationRecord,
  type FlowEventRecord,
  type FlowRunRecord,
  type OperationSummary,
  type ProcessDefinition,
  type StepRegistration,
  type TraceLogRecord,
} from '@dvt/core';

export class Dataset {
  /** Newest first. */
  readonly logs: TraceLogRecord[];
  readonly logsById = new Map<string, TraceLogRecord>();
  readonly logsByCorrelation = new Map<string, TraceLogRecord[]>();
  readonly operations = new Map<string, OperationSummary>();
  readonly jobsByCorrelation = new Map<string, AsyncOperationRecord[]>();
  readonly jobsById = new Map<string, AsyncOperationRecord>();
  readonly steps = new Map<string, StepRegistration>();
  readonly jobs: AsyncOperationRecord[];
  /** Oldest first (by start). */
  readonly flowRuns: FlowRunRecord[];
  readonly processes: ProcessDefinition[];
  readonly flowEvents: FlowEventRecord[];

  constructor(
    logs: TraceLogRecord[],
    jobs: AsyncOperationRecord[],
    steps: StepRegistration[],
    flowRuns: FlowRunRecord[] = [],
    processes: ProcessDefinition[] = [],
    flowEvents: FlowEventRecord[] = [],
  ) {
    this.logs = [...logs].sort((a, b) => b.start - a.start || (a.id < b.id ? -1 : 1));
    this.jobs = jobs;
    for (const log of this.logs) {
      this.logsById.set(log.id, log);
      if (!log.correlationId) continue;
      const list = this.logsByCorrelation.get(log.correlationId);
      if (list) list.push(log);
      else this.logsByCorrelation.set(log.correlationId, [log]);
    }
    for (const op of summarizeOperations(this.logs)) this.operations.set(op.correlationId, op);
    for (const job of jobs) {
      this.jobsById.set(job.id, job);
      if (!job.correlationId) continue;
      const list = this.jobsByCorrelation.get(job.correlationId);
      if (list) list.push(job);
      else this.jobsByCorrelation.set(job.correlationId, [job]);
    }
    for (const step of steps) this.steps.set(step.id, step);
    this.flowRuns = [...flowRuns].sort((a, b) => a.start - b.start);
    this.processes = processes;
    this.flowEvents = flowEvents;
  }

  /** Trace logs that started in [from, to]. */
  logsBetween(from: number, to: number): TraceLogRecord[] {
    // `logs` is newest first: binary-search the first row at or before `to`.
    let lo = 0;
    let hi = this.logs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.logs[mid]!.start > to) lo = mid + 1;
      else hi = mid;
    }
    const out: TraceLogRecord[] = [];
    for (let i = lo; i < this.logs.length && this.logs[i]!.start >= from; i++) out.push(this.logs[i]!);
    return out;
  }

  /** Flow runs that started in [from, to]. */
  flowRunsBetween(from: number, to: number): FlowRunRecord[] {
    let lo = 0;
    let hi = this.flowRuns.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.flowRuns[mid]!.start < from) lo = mid + 1;
      else hi = mid;
    }
    const out: FlowRunRecord[] = [];
    for (let i = lo; i < this.flowRuns.length && this.flowRuns[i]!.start <= to; i++) out.push(this.flowRuns[i]!);
    return out;
  }

  static empty(): Dataset {
    return new Dataset([], [], []);
  }
}
