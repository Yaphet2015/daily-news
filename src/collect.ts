import { readState, writeState } from './state.js';
import type { RawTweet } from './types.js';

const BASE_URL = 'https://api.twitterapi.io';
const MAX_TWEETS = 500;
// Default lookback window when no prior run state exists (24 hours)
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;

interface TwitterApiTweet {
  id: string;
  text: string;
  author: {
    name: string;
    userName: string;
  };
  createdAt: string;
  url?: string;
}

interface TwitterApiResponse {
  tweets: TwitterApiTweet[];
  has_next_page: boolean;
  next_cursor: string;
  status: string;
  message?: string;
}

function buildTweetUrl(username: string, id: string): string {
  return `https://x.com/${username}/status/${id}`;
}

export async function collect(): Promise<RawTweet[]> {
  const apiKey = process.env.TWITTERAPI_KEY;
  if (!apiKey) throw new Error('TWITTERAPI_KEY is not set');

  const listId = process.env.TWITTER_LIST_ID ?? '1602502639287435265';

  const state = await readState();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sinceTime = state.lastRunTime > 0
    ? state.lastRunTime
    : nowSeconds - DEFAULT_LOOKBACK_SECONDS;

  console.log(`[collect] 采集 listId=${listId}，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')}`);

  const tweets: RawTweet[] = [];
  let cursor = '';

  while (tweets.length < MAX_TWEETS) {
    const params = new URLSearchParams({
      listId,
      sinceTime: String(sinceTime),
      includeReplies: 'false',
      cursor,
    });

    const res = await fetch(`${BASE_URL}/twitter/list/tweets?${params}`, {
      headers: { 'X-API-Key': apiKey },
    });

    if (!res.ok) {
      throw new Error(`twitterapi.io 请求失败: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as TwitterApiResponse;

    if (data.status !== 'success') {
      throw new Error(`twitterapi.io 返回错误: ${data.message ?? data.status}`);
    }

    for (const t of data.tweets) {
      tweets.push({
        id: t.id,
        text: t.text,
        author: { name: t.author.name, username: t.author.userName },
        createdAt: t.createdAt,
        url: t.url ?? buildTweetUrl(t.author.userName, t.id),
      });
      if (tweets.length >= MAX_TWEETS) break;
    }

    console.log(`[collect] 已采集 ${tweets.length} 条...`);

    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  await writeState({ lastRunTime: nowSeconds });
  console.log(`[collect] 完成，共采集 ${tweets.length} 条推文`);
  return tweets;
}
