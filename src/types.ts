export interface RawTweet {
  id: string;
  text: string;
  author: { name: string; username: string };
  createdAt: string;
  url: string;
}

export interface CuratedItem {
  title: string;
  summary: string;
  url: string;
  author: string;
  tags: string[];
}

export interface FormatResult {
  obsidian: string;
  substack: string;
  date: string;
}

export interface RunState {
  lastRunTime: number; // Unix timestamp in seconds
}
