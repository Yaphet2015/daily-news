export interface AuthorRankingRule {
  penalty?: number;
  bonus?: number;
  reason: string;
}

export const AUTHOR_RANKING_RULES: Record<string, AuthorRankingRule> = {
  tom_doerr: {
    penalty: 24,
    reason: 'deprioritized_author:tom_doerr',
  },
  openai: {
    bonus: 6,
    reason: 'official_author:openai',
  },
  anthropicai: {
    bonus: 6,
    reason: 'official_author:anthropicai',
  },
};
