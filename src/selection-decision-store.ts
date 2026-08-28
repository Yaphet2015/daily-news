import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeJsonAtomic } from './artifact-codec.js';
import { createPendingSelectionDecision, decodeSelectionDecision } from './selection-decision.js';
import type { CurationArtifact, SelectionDecision } from './types.js';

export class SelectionDecisionStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly curation: CurationArtifact,
  ) {}

  async initialize(updatedAt: string): Promise<SelectionDecision> {
    if (existsSync(this.path)) return this.read();
    const decision = createPendingSelectionDecision(this.curation, updatedAt);
    await writeJsonAtomic(this.path, decision);
    return decision;
  }

  async read(): Promise<SelectionDecision> {
    await this.queue;
    if (!existsSync(this.path)) throw new Error(`Missing selection decision: ${this.path}`);
    const decision = decodeSelectionDecision(JSON.parse(await readFile(this.path, 'utf-8')));
    if (decision.runId !== this.curation.runId || decision.curationRevision !== this.curation.curationRevision) {
      throw new Error('selection decision identity mismatch');
    }
    return decision;
  }

  update(mutator: (decision: SelectionDecision) => SelectionDecision): Promise<SelectionDecision> {
    const operation = this.queue.then(async () => {
      const current = decodeSelectionDecision(JSON.parse(await readFile(this.path, 'utf-8')));
      const next = mutator(current);
      await writeJsonAtomic(this.path, next);
      return next;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
