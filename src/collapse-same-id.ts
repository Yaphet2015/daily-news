import type { CollectedItem } from './types.js';

function preferSameIdItem(current: CollectedItem, incoming: CollectedItem): CollectedItem {
  if (incoming.twitterFeed === 'list' && current.twitterFeed !== 'list') return incoming;
  return current;
}

export function collapseSameIdItems(items: CollectedItem[]): CollectedItem[] {
  const byId = new Map<string, CollectedItem>();
  for (const item of items) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? preferSameIdItem(existing, item) : item);
  }
  return [...byId.values()];
}
