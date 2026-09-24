// In-memory indexes over the locally stored records, rebuilt whenever the store changes.
import {
  summarizeOperations,
  type AsyncOperationRecord,
  type OperationSummary,
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
  readonly steps = new Map<string, StepRegistration>();
  readonly jobs: AsyncOperationRecord[];

  constructor(logs: TraceLogRecord[], jobs: AsyncOperationRecord[], steps: StepRegistration[]) {
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
      if (!job.correlationId) continue;
      const list = this.jobsByCorrelation.get(job.correlationId);
      if (list) list.push(job);
      else this.jobsByCorrelation.set(job.correlationId, [job]);
    }
    for (const step of steps) this.steps.set(step.id, step);
  }

  static empty(): Dataset {
    return new Dataset([], [], []);
  }
}
