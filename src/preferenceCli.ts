import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { checkbox } from '@inquirer/prompts';
import {
  DEFAULT_PREFERENCE_PROFILE_PATH,
  DEFAULT_PREFERENCE_RULES_PATH,
  DEFAULT_PREFERENCE_SUGGESTIONS_PATH,
  readConfirmedPreferenceRules,
  updatePreferenceProfileFromReports,
  writeConfirmedPreferenceRules,
  type ConfirmedPreferenceRules,
  type PreferenceRuleSuggestion,
} from './preferences.js';

type PreferenceCommand = 'update' | 'review';

function parsePreferenceCommand(args: string[]): PreferenceCommand {
  const command = args[0] ?? 'update';
  if (command === 'update' || command === 'review') return command;
  throw new Error(`Unsupported preference command: ${command}`);
}

function toRuleChoice(prefix: 'author' | 'domain', suggestion: PreferenceRuleSuggestion): { name: string; value: string; checked: boolean } {
  const adjustment = suggestion.bonus > 0 ? `+${suggestion.bonus}` : `-${suggestion.penalty}`;
  const label = suggestion.label ? `${suggestion.key} (${suggestion.label})` : suggestion.key;
  return {
    name: `${prefix}:${label} ${adjustment} · ${suggestion.reason}`,
    value: `${prefix}:${suggestion.key}`,
    checked: false,
  };
}

function applySelectedSuggestions(
  currentRules: ConfirmedPreferenceRules,
  selected: string[],
  suggestions: Awaited<ReturnType<typeof updatePreferenceProfileFromReports>>['profile']['suggestions'],
): ConfirmedPreferenceRules {
  const next: ConfirmedPreferenceRules = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    authorRules: { ...currentRules.authorRules },
    domainRules: { ...currentRules.domainRules },
    positiveTopicHints: [...currentRules.positiveTopicHints],
    negativeTopicHints: [...currentRules.negativeTopicHints],
  };

  for (const suggestion of suggestions.authorRules) {
    if (!selected.includes(`author:${suggestion.key}`)) continue;
    next.authorRules[suggestion.key] = {
      ...(suggestion.bonus > 0 ? { bonus: suggestion.bonus } : {}),
      ...(suggestion.penalty > 0 ? { penalty: suggestion.penalty } : {}),
      reason: suggestion.reason,
    };
  }

  for (const suggestion of suggestions.domainRules) {
    if (!selected.includes(`domain:${suggestion.key}`)) continue;
    next.domainRules[suggestion.key] = {
      ...(suggestion.bonus > 0 ? { bonus: suggestion.bonus } : {}),
      ...(suggestion.penalty > 0 ? { penalty: suggestion.penalty } : {}),
      reason: suggestion.reason,
    };
  }

  if (selected.includes('topics:positive')) {
    next.positiveTopicHints = Array.from(new Set([...next.positiveTopicHints, ...suggestions.positiveTopicHints]));
  }
  if (selected.includes('topics:negative')) {
    next.negativeTopicHints = Array.from(new Set([...next.negativeTopicHints, ...suggestions.negativeTopicHints]));
  }

  return next;
}

async function updatePreferences(): Promise<void> {
  const result = await updatePreferenceProfileFromReports();
  console.log(`[preferences] backfilled reports: appended=${result.appended}, skipped=${result.skippedExisting}, failed=${result.failedReports.length}`);
  if (result.failedReports.length > 0) {
    for (const failed of result.failedReports) {
      console.warn(`[preferences] failed report: ${failed.path}: ${failed.error}`);
    }
  }
  console.log(`[preferences] profile saved: ${DEFAULT_PREFERENCE_PROFILE_PATH}`);
  console.log(`[preferences] suggestions saved: ${DEFAULT_PREFERENCE_SUGGESTIONS_PATH}`);
}

async function reviewPreferences(): Promise<void> {
  const result = await updatePreferenceProfileFromReports();
  const suggestions = result.profile.suggestions;
  const choices = [
    ...suggestions.authorRules.map((suggestion) => toRuleChoice('author', suggestion)),
    ...suggestions.domainRules.map((suggestion) => toRuleChoice('domain', suggestion)),
    ...(suggestions.positiveTopicHints.length > 0
      ? [{ name: `topic:prefer ${suggestions.positiveTopicHints.join('; ')}`, value: 'topics:positive', checked: false }]
      : []),
    ...(suggestions.negativeTopicHints.length > 0
      ? [{ name: `topic:deprioritize ${suggestions.negativeTopicHints.join('; ')}`, value: 'topics:negative', checked: false }]
      : []),
  ];

  if (choices.length === 0) {
    console.log('[preferences] no reviewable suggestions yet');
    return;
  }

  const selected = await checkbox<string>({
    message: '选择要确认生效的偏好规则：',
    choices,
    pageSize: 15,
  });
  const rules = applySelectedSuggestions(readConfirmedPreferenceRules(), selected, suggestions);
  await writeConfirmedPreferenceRules(rules);
  console.log(`[preferences] confirmed rules saved: ${DEFAULT_PREFERENCE_RULES_PATH}`);
}

export async function runPreferenceCli(args = process.argv.slice(2)): Promise<void> {
  const command = parsePreferenceCommand(args);
  if (command === 'update') {
    await updatePreferences();
    return;
  }
  await reviewPreferences();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreferenceCli().catch((error) => {
    console.error('[preferences] failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
