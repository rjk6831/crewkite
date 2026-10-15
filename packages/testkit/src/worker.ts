import { fileURLToPath } from 'node:url';

export const fakeWorkerPath = fileURLToPath(new URL('./providers/worker.ts', import.meta.url));
export const fakeReviewWorkerPath = fileURLToPath(
  new URL('./providers/review-worker.ts', import.meta.url),
);
