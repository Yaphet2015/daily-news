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
};
