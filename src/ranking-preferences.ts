export interface AuthorRankingRule {
  penalty?: number;
  bonus?: number;
  reason: string;
}

export const HARD_FILTERED_AUTHOR_USERNAMES = ['tom_doerr'] as const;

export const AUTHOR_RANKING_RULES: Record<string, AuthorRankingRule> = {
  openai: {
    bonus: 8,
    reason: 'openai官号',
  },
  anthropicai: {
    bonus: 8,
    reason: 'anthropicai官号',
  },
};
