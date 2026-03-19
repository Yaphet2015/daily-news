export type SourceName = 'twitter' | 'substack';
export type NewsCategory = 'Product' | 'Tutorial' | 'Opinions/Thoughts';

export interface MediaAsset {
  type: string;
  url: string;
  width?: number;
  height?: number;
}

export interface ReaderBrief {
  summary: string;
  keyPoints: string[];
  claims: string[];
  whyItMatters: string;
  signals: string[];
  caveats: string[];
}

export interface CollectedAuthor {
  name: string;
  username?: string;
}

export interface PublicationRef {
  name: string;
  handle?: string;
  url?: string;
}

export interface CollectedItem {
  id: string;
  source: SourceName;
  url: string;
  publishedAt: string;
  author: CollectedAuthor;
  publication?: PublicationRef;
  title?: string;
  subtitle?: string | null;
  text: string;
  body?: string;
  media: MediaAsset[];
  readerBrief?: ReaderBrief;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
}

export interface ScoreBreakdown {
  substance: number;
  evidence: number;
  sourceSignal: number;
  freshness: number;
  novelty: number;
  actionability: number;
  penalties: number;
}

export interface RankedItem extends CollectedItem {
  editorialScore: number;
  engagementScore: number;
  priorityScore: number;
  scoreBreakdown: ScoreBreakdown;
  duplicateOf?: string;
  decisionReasons: string[];
  enteredCandidatePool?: boolean;
  selectedByLlm?: boolean;
  selectedByHuman?: boolean;
}

export interface CuratedItem {
  title: string;
  summary: string;
  url: string;
  author: string;
  attribution: string;
  source: SourceName;
  category: NewsCategory;
  media: MediaAsset[];
  priorityScore?: number;
  decisionReasons?: string[];
  editorialReason?: string;
}

export interface FormatResult {
  obsidian: string;
  substack: string;
  date: string;
}

export interface SelectionReport {
  date: string;
  rankedItems: RankedItem[];
  curatedItems: CuratedItem[];
  selectedItems: CuratedItem[];
}

export interface SourceRunState {
  lastRunTime: number;
}

export interface RunState {
  sources: {
    twitter: SourceRunState;
    substack: SourceRunState;
  };
}
