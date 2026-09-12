// The per-pipeline checkpoint under runs/: written after every successful step, read at the next start so a
// re-run resumes at the first step not completed, deleted (with the gate's review file) when the run completes; the
// review file alone goes the moment the gate it describes is approved.
// Shape: Checkpoint in types.ts.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { errorText } from './log.js';
import { reviewFile } from './review.js';
import type { Checkpoint, Logger, Pipeline } from './types.js';

export interface CheckpointStore {
  /** The runs directory; the approval gate writes its review file next to the checkpoint. */
  dir: string;
  /** `<runsDir>/<pipeline>.checkpoint.json` */
  file: string;
  /** The completed steps as a prototype-less map (a step id like `constructor` must not resolve through
   * Object.prototype); empty when there is no usable checkpoint. A missing file means no checkpoint; any other
   * read error is fatal; an unparsable file, or one written for a different step list, is ignored with a warning
   * and overwritten by the next save, if any. */
  load(): Promise<Checkpoint['completed']>;
  /** Writes the whole map; creates the runs directory on first use. */
  save(completed: Checkpoint['completed']): Promise<void>;
  /** Removes the checkpoint and the review file, if any: a completed run, or --fresh, leaves no run state behind. */
  clear(): Promise<void>;
  /** Removes the review file only, leaving the checkpoint: the gate it describes has been approved, so a review that
   * says the run is waiting for a person must not outlive it. */
  clearReview(): Promise<void>;
}

export function checkpointStore(runsDir: string, pipeline: Pipeline, log: Logger): CheckpointStore {
  const file = path.join(runsDir, `${pipeline.name}.checkpoint.json`);
  const review = reviewFile(runsDir, pipeline.name);
  const steps = pipeline.steps.map((s) => ({ id: s.id, uses: s.uses.name }));
  return {
    dir: runsDir,
    file,
    async load() {
      const raw = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
        return undefined;
      });
      if (raw === undefined) return Object.create(null);
      try {
        const cp = JSON.parse(raw) as Checkpoint;
        const done = cp?.completed;
        if (typeof done !== 'object' || done === null || Array.isArray(done) || JSON.stringify(cp.steps) !== JSON.stringify(steps)) {
          throw new Error('not a checkpoint for this step list');
        }
        log.info('checkpoint loaded', { file, completed: Object.keys(done).length });
        return Object.assign(Object.create(null), done);
      } catch (err) {
        log.warn('checkpoint ignored', { file, reason: errorText(err) });
        return Object.create(null);
      }
    },
    async save(completed) {
      const checkpoint: Checkpoint = { pipeline: pipeline.name, steps, completed, updatedAt: new Date().toISOString() };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`);
    },
    clear: async () => {
      await rm(file, { force: true });
      await rm(review, { force: true });
    },
    clearReview: () => rm(review, { force: true }),
  };
}
