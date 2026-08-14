export interface AuthorRankingRule {
  penalty?: number;
  bonus?: number;
  official?: boolean;
  reason: string;
}

export const HARD_FILTERED_AUTHOR_USERNAMES = ['tom_doerr'] as const;

export const OFFICIAL_SOURCE_DOMAINS = ['openai.com', 'anthropic.com'] as const;

export const AUTHOR_RANKING_RULES: Record<string, AuthorRankingRule> = {
  openai: {
    bonus: 8,
    official: true,
    reason: 'openai官号',
  },
  anthropicai: {
    bonus: 8,
    official: true,
    reason: 'anthropicai官号',
  },
  // Trusted curation source (Mario Zechner): posts short "recommended reading" pointers to
  // high-value articles. The general 策展指针 rescue (rank.ts) already keeps these visible; this
  // small tunable bonus nudges them further. Not `official` — he is a curator, not an org source.
  badlogicgames: {
    bonus: 6,
    reason: 'pi 的原作者，经常写一些 recommend read 的简短推荐推',
  },
};
