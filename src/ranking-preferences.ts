export interface AuthorPenaltyRule {
  penalty: number;
  reason: string;
}

export const AUTHOR_PENALTY_RULES: Record<string, AuthorPenaltyRule> = {
  tom_doerr: {
    penalty: 24,
    reason: 'deprioritized_author:tom_doerr',
  },
};
