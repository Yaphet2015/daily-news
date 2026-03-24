export interface AuthorPenaltyRule {
  penalty: number;
  reason: string;
}

export const AUTHOR_PENALTY_RULES: Record<string, AuthorPenaltyRule> = {
  tom_doerr: {
    penalty: 20,
    reason: 'deprioritized_author:tom_doerr',
  },
};
