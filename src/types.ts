export type SourceName = 'twitter' | 'substack';
export type NewsCategory = 'Product' | 'Tutorial' | 'Opinions/Thoughts';
export type RoundupMode = 'bullet_links';
export type CollectedItemKind = 'substack_post' | 'substack_roundup_entry';

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
  roundupMode?: RoundupMode;
}

export interface ReplyContext {
  id: string;
  text: string;
  author: CollectedAuthor;
  publishedAt?: string;
  url?: string;
  outboundLinks: string[];
}

export interface SelfThreadPart {
  id: string;
  originUrl?: string;
  text: string;
  publishedAt: string;
  media: MediaAsset[];
}

export interface SelfThread {
  partIds: string[];
  partCount: number;
  combinedText: string;
  parts: SelfThreadPart[];
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
  kind?: CollectedItemKind;
  url: string;
  originUrl?: string;
  parentItemId?: string;
  sectionLabel?: string;
  publishedAt: string;
  author: CollectedAuthor;
  publication?: PublicationRef;
  title?: string;
  subtitle?: string | null;
  sourceLabel?: string;
  text: string;
  body?: string;
  htmlBody?: string;
  media: MediaAsset[];
  outboundLinks?: string[];
  embeddedLinkedSource?: LinkedSource;
  quotedStatusUrl?: string;
  replyContext?: ReplyContext[];
  linkedSource?: LinkedSource;
  sourceResolution?: SourceResolution;
  selfThread?: SelfThread;
  readerBrief?: ReaderBrief;
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
  forceSelect?: boolean;
}

export interface ScoreBreakdown {
  substance: number;
  evidence: number;
  sourceSignal: number;
  xArticleBonus: number;
  substackSourceBonus: number;
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
  threadPartCount?: number;
  sourceResolution?: SourceResolution;
}

export type CurationRejectionReason = 'unknown_id' | 'url_mismatch' | 'duplicate_id' | 'duplicate_url';
export type CurationUrlCorrectionReason = 'origin_url' | 'tracking_params';

export interface CurationRejectionSample {
  reason: CurationRejectionReason;
  id: string;
  title?: string;
  modelUrl?: string;
  sourceUrl?: string;
  originUrl?: string;
}

export interface CurationUrlCorrection {
  id: string;
  fromUrl: string;
  toUrl: string;
  reason: CurationUrlCorrectionReason;
}

export interface CurationDiagnostics {
  inputCount: number;
  outputCount: number;
  rejectedCount: number;
  rejectionCounts: Record<CurationRejectionReason, number>;
  rejectionSamples: CurationRejectionSample[];
  urlCorrections: CurationUrlCorrection[];
}

export interface CurateResult {
  items: CuratedItem[];
  diagnostics: CurationDiagnostics;
}

export interface FormatResult {
  obsidian: string;
  substack: string;
  date: string;
}

export interface SelectionReport {
  date: string;
  curationDiagnostics?: CurationDiagnostics;
  rankedItems: RankedItem[];
  curatedItems: CuratedItem[];
  selectedItems: CuratedItem[];
}

export interface ReviewPacket {
  date: string;
  collectedAt: number;
  enabledSources: SourceName[];
  rankedItems: RankedItem[];
  curatedItems: CuratedItem[];
  curationDiagnostics?: CurationDiagnostics;
  nextAction: string;
}

export interface ReviewPacketPaths {
  jsonPath: string;
  markdownPath: string;
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
