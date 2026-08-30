import type { SourceName } from './source-registry.js';

export type { SourceName } from './source-registry.js';
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
  twitterFeed?: 'list' | 'for-you';
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
  /** Quoted tweet's own text, when the list payload already embedded it. Lets us resolve the
   * quoted article locally without an extra `twitter tweet <id>` X API call (the N+1 that 429s). */
  quotedTweetText?: string;
  replyContext?: ReplyContext[];
  linkedSource?: LinkedSource;
  sourceResolution?: SourceResolution;
  selfThread?: SelfThread;
  readerBrief?: ReaderBrief;
  substackTeaserOnly?: boolean;
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

export type ContentTagId =
  | 'topic:agents'
  | 'topic:model-evaluation'
  | 'topic:ai-infra'
  | 'format:launch'
  | 'format:tutorial'
  | 'format:research'
  | 'quality:evidence-rich'
  | 'quality:vague'
  | 'utility:actionable'
  | 'pattern:vague-launch'
  | `custom:${string}`;

export type RankingSignalId =
  | 'ranking:substance'
  | 'ranking:evidence'
  | 'ranking:freshness'
  | 'ranking:novelty'
  | 'ranking:actionability'
  | 'ranking:engagement'
  | 'ranking:source-credibility'
  | 'ranking:x-article'
  | 'ranking:substack-full-post'
  | 'ranking:penalty';

export type RankingSignalMap = Record<RankingSignalId, number>;

export interface CustomContentTagDefinition {
  id: `custom:${string}`;
  label: string;
  keywords: string[];
}

export interface ContentTagMatch {
  tagId: ContentTagId;
  matchedBy: string[];
  strength: number;
}

export interface ScoreFactor {
  factorId: ContentTagId | RankingSignalId;
  kind: 'tag' | 'ranking-signal';
  strength: number;
  weight: number;
  contribution: number;
  evidence: string[];
  provenance: 'baseline' | 'confirmed-overlay';
}

export interface RankedItem extends CollectedItem {
  editorialScore: number;
  engagementScore: number;
  priorityScore: number;
  scoreBreakdown: ScoreBreakdown;
  duplicateOf?: string;
  decisionReasons: string[];
  contentTags?: ContentTagId[];
  tagMatches?: ContentTagMatch[];
  rankingSignals?: RankingSignalMap;
  scoreFactors?: ScoreFactor[];
  scoreFeedback?: ScoreFeedbackEntry;
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
export type CurationUrlCorrectionReason =
  | 'origin_url'
  | 'tracking_params'
  | 'recovered_primary_url'
  | 'recovered_origin_url';

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

export type CurationMode = 'npm-model' | 'agent-curator';

export interface ArtifactIdentity<Version extends number = 1> {
  schemaVersion: Version;
  runId: string;
  date: string;
  curationMode: CurationMode;
  featureVersion: string;
}

export interface RankingArtifact extends ArtifactIdentity<1> {
  collectedAt: number;
  policyRevision: number;
  rankedItems: RankedItem[];
  candidateIds: string[];
}

export interface CurationArtifact extends ArtifactIdentity<1> {
  collectedAt: number;
  curationRevision: string;
  curatedItems: CuratedItem[];
  collectionWarnings?: string[];
  curationDiagnostics?: CurationDiagnostics;
}

export type ScoreFeedbackDirection = 'too_high' | 'too_low';

export interface ScoreFeedbackEntry {
  direction: ScoreFeedbackDirection;
  updatedAt: string;
}

export interface RemarkEntry {
  text: string;
  updatedAt: string;
}

export interface SelectionDecision extends ArtifactIdentity<1> {
  curationRevision: string;
  revision: number;
  updatedAt: string;
  selection: {
    status: 'pending' | 'confirmed';
    selectedIds: string[];
    confirmedAt?: string;
  };
  scoreFeedbackById: Record<string, ScoreFeedbackEntry>;
  remarkById: Record<string, RemarkEntry>;
}

export interface SelectionReport {
  date: string;
  collectionWarnings?: string[];
  curationDiagnostics?: CurationDiagnostics;
  rankedItems: RankedItem[];
  curatedItems: CuratedItem[];
  selectedItems: CuratedItem[];
}

export interface FeedbackReviewItem {
  id: string;
  feedbackEventId: string;
  /** Score-direction feedback; undefined for remark-only entries. */
  direction?: ScoreFeedbackDirection;
  updatedAt: string;
  /** Free-text human remark collected on the select page. */
  remark?: string;
  text: string;
  textPreview: string;
  linkedSource?: LinkedSource;
  contentTags: ContentTagId[];
  tagMatches: ContentTagMatch[];
  rankingSignals: RankingSignalMap;
  scoreFactors: ScoreFactor[];
  editorialScore: number;
  engagementScore: number;
  priorityScore: number;
  selectedByLlm: boolean;
  selectedByHuman: boolean;
}

export interface FeedbackReview extends ArtifactIdentity<1> {
  curationRevision: string;
  selectionDecisionRevision: number;
  policyRevision: number;
  items: FeedbackReviewItem[];
}

export interface ScoreFeedbackHistoryEvent extends ArtifactIdentity<1> {
  feedbackEventId: string;
  curationRevision: string;
  selectionDecisionRevision: number;
  policyRevision: number;
  itemId: string;
  direction: ScoreFeedbackDirection;
  updatedAt: string;
  remark?: string;
  textPreview: string;
  contentTags: ContentTagId[];
  tagMatches: ContentTagMatch[];
  rankingSignals: RankingSignalMap;
  scoreFactors: ScoreFactor[];
}

export interface CanonicalSelectionReport extends ArtifactIdentity<1> {
  policyRevision: number;
  curationRevision: string;
  selectionDecisionRevision: number;
  scoreFeedbackById: Record<string, ScoreFeedbackEntry>;
  collectionWarnings?: string[];
  curationDiagnostics?: CurationDiagnostics;
  rankedItems: RankedItem[];
  curatedItems: CuratedItem[];
  selectedItems: CuratedItem[];
}

export interface ReviewPacket {
  date: string;
  collectedAt: number;
  enabledSources: SourceName[];
  collectionWarnings?: string[];
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
    aihot: SourceRunState;
  };
}

export interface CollectionSnapshot {
  collectedAt: number;
  enabledSources: SourceName[];
  collectionWarnings?: string[];
  items: CollectedItem[];
}

export interface PendingDraft extends CollectionSnapshot {}
