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

export interface ReplyContext {
  id: string;
  text: string;
  author: CollectedAuthor;
  publishedAt?: string;
  url?: string;
  outboundLinks: string[];
}

export interface LinkedSource {
  url: string;
  title?: string;
  description?: string;
  excerpt?: string;
  domain: string;
  via: 'tweet' | 'reply' | 'quote';
}

export interface SourceResolution {
  decision: 'keep_origin' | 'use_linked_source';
  reason: string;
}

export interface CollectedItem {
  id: string;
  source: SourceName;
  url: string;
  originUrl?: string;
  publishedAt: string;
  author: CollectedAuthor;
  publication?: PublicationRef;
  title?: string;
  subtitle?: string | null;
  sourceLabel?: string;
  text: string;
  body?: string;
  media: MediaAsset[];
  outboundLinks?: string[];
  embeddedLinkedSource?: LinkedSource;
  quotedStatusUrl?: string;
  replyContext?: ReplyContext[];
  linkedSource?: LinkedSource;
  sourceResolution?: SourceResolution;
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
  xArticleBonus: number;
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
  id: string;
  title: string;
  summary: string;
  url: string;
  originUrl?: string;
  author: string;
  attribution: string;
  source: SourceName;
  category: NewsCategory;
  media: MediaAsset[];
  priorityScore?: number;
  decisionReasons?: string[];
  editorialReason?: string;
  originText?: string;
  sourceResolution?: SourceResolution;
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
  lastPublishedTime: number;
}

export interface RunState {
  sources: {
    twitter: SourceRunState;
    substack: SourceRunState;
  };
}

export interface CollectionSnapshot {
  collectedAt: number;
  enabledSources: SourceName[];
  items: CollectedItem[];
}

export interface PendingDraft extends CollectionSnapshot {}
