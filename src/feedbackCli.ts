import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { applyFeedbackAdjustment, decodeFeedbackAdjustment } from './feedback-adjustment.js';
import { decodeFeedbackReview } from './feedback-review.js';
import {
  DEFAULT_PREFERENCE_RULES_PATH,
  readConfirmedPreferenceRules,
  writeConfirmedPreferenceRules,
} from './preferences.js';
import {
  DEFAULT_SCORE_FEEDBACK_HISTORY_PATH,
  readScoreFeedbackHistory,
} from './score-feedback-history.js';

export interface FeedbackCliArgs {
  command: 'apply';
  date: string;
  adjustmentPath: string;
  reviewPath: string;
}

export function parseFeedbackCliArgs(args: string[]): FeedbackCliArgs {
  if (args[0] !== 'apply') throw new Error(`Unsupported feedback command: ${args[0] ?? '<missing>'}`);
  const date = args.find((arg) => arg.startsWith('--date='))?.slice('--date='.length);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('feedback apply requires --date=YYYY-MM-DD');
  const adjustmentPath = args.find((arg) => arg.startsWith('--adjustment='))?.slice('--adjustment='.length)
    ?? `output/${date}-feedback-adjustment.json`;
  const reviewPath = args.find((arg) => arg.startsWith('--review='))?.slice('--review='.length)
    ?? `output/${date}-feedback-review.json`;
  return { command: 'apply', date, adjustmentPath, reviewPath };
}

export async function runFeedbackApply(
  args: FeedbackCliArgs,
  paths: { rulesPath?: string; historyPath?: string } = {},
) {
  const adjustment = decodeFeedbackAdjustment(JSON.parse(await readFile(args.adjustmentPath, 'utf-8')));
  const review = decodeFeedbackReview(JSON.parse(await readFile(args.reviewPath, 'utf-8')));
  const rulesPath = paths.rulesPath ?? DEFAULT_PREFERENCE_RULES_PATH;
  const historyPath = paths.historyPath ?? DEFAULT_SCORE_FEEDBACK_HISTORY_PATH;
  const current = readConfirmedPreferenceRules(rulesPath);
  const history = await readScoreFeedbackHistory(historyPath);
  return applyFeedbackAdjustment(adjustment, review, history, current, {
    writePolicy: (policy) => writeConfirmedPreferenceRules(policy, rulesPath),
  });
}

async function main(): Promise<void> {
  const parsed = parseFeedbackCliArgs(process.argv.slice(2));
  const result = await runFeedbackApply(parsed);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
