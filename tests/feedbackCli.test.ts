import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeedbackCliArgs } from '../src/feedbackCli.js';

test('feedback CLI requires apply and resolves the dated artifacts', () => {
  assert.deepEqual(parseFeedbackCliArgs(['apply', '--date=2026-08-27']), {
    command: 'apply', date: '2026-08-27',
    adjustmentPath: 'output/2026-08-27-feedback-adjustment.json',
    reviewPath: 'output/2026-08-27-feedback-review.json',
  });
  assert.throws(() => parseFeedbackCliArgs(['apply']), /--date/);
  assert.throws(() => parseFeedbackCliArgs(['review', '--date=2026-08-27']), /Unsupported/);
});
