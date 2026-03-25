export interface AuthorRankingRule {
  penalty?: number;
  bonus?: number;
  reason: string;
}

export const AUTHOR_RANKING_RULES: Record<string, AuthorRankingRule> = {
  tom_doerr: {
    penalty: 24,
    reason: '降权作者:tom_doerr',
  },
  openai: {
    bonus: 6,
    reason: 'openai官号',
  },
  anthropicai: {
    bonus: 6,
    reason: 'anthropicai官号',
  },
};
