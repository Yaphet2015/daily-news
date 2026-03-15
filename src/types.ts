export type SourceName = 'twitter' | 'substack';

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
}

export interface CuratedItem {
  title: string;
  summary: string;
  url: string;
  author: string;
  attribution: string;
  source: SourceName;
  tags: string[];
  media: MediaAsset[];
}

export interface FormatResult {
  obsidian: string;
  substack: string;
  date: string;
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
