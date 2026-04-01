import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { select as promptSelect } from '@inquirer/prompts';
import { collect } from './collect.js';
import { attachReaderBriefs, curate } from './curate.js';
import { clearPendingDraft, readPendingDraft, writePendingDraft } from './draft.js';
import { format, formatDateFromUnixSeconds } from './format.js';
import { publish } from './publish.js';
import { rankItems, selectCandidatePool } from './rank.js';
import { select } from './select.js';
import { readState, writeState } from './state.js';
import type {
  CollectionSnapshot,
  CollectedItem,
  CuratedItem,
  PendingDraft,
  RunState,
  SelectionReport,
} from './types.js';

type PendingDraftAction = 'resume' | 'discard' | 'cancel';

interface GenerateDeps {
  readState: () => Promise<RunState>;
  writeState: (state: RunState) => Promise<void>;
  readDraft: () => Promise<PendingDraft | null>;
  writeDraft: (draft: PendingDraft) => Promise<void>;
  clearDraft: () => Promise<void>;
  choosePendingDraftAction: (draft: PendingDraft) => Promise<PendingDraftAction>;
  collect: (state: RunState) => Promise<CollectionSnapshot>;
  attachReaderBriefs: (items: CollectedItem[]) => Promise<CollectedItem[]>;
  rankItems: typeof rankItems;
  selectCandidatePool: typeof selectCandidatePool;
  curate: (items: CollectedItem[]) => Promise<CuratedItem[]>;
  select: (items: CuratedItem[]) => Promise<CuratedItem[]>;
  format: typeof format;
  publish: (result: ReturnType<typeof format>, report?: SelectionReport) => Promise<void>;
  log: (message: string) => void;
}

function createGenerateDeps(): GenerateDeps {
  return {
    readState,
    writeState,
    readDraft: readPendingDraft,
    writeDraft: writePendingDraft,
    clearDraft: clearPendingDraft,
    choosePendingDraftAction: async (draft) =>
      promptSelect<PendingDraftAction>({
        message: `发现一份未发布草稿（采集时间 ${formatDateFromUnixSeconds(draft.collectedAt)}，共 ${draft.items.length} 条），如何处理？`,
        default: 'resume',
        choices: [
          { name: '继续发布已采集草稿', value: 'resume' },
          { name: '丢弃草稿并重新采集', value: 'discard' },
          { name: '取消本次运行', value: 'cancel' },
        ],
      }),
    collect,
    attachReaderBriefs,
    rankItems,
    selectCandidatePool,
    curate,
    select,
    format,
    publish,
    log: console.log,
  };
}

function advancePublishedState(state: RunState, sources: string[], collectedAt: number): RunState {
  const nextState: RunState = {
    sources: {
      twitter: { lastPublishedTime: state.sources.twitter.lastPublishedTime },
      substack: { lastPublishedTime: state.sources.substack.lastPublishedTime },
    },
  };

  for (const source of sources) {
    if (source === 'twitter' || source === 'substack') {
      nextState.sources[source] = { lastPublishedTime: collectedAt };
    }
  }

  return nextState;
}

export async function runGenerate(overrides: Partial<GenerateDeps> = {}): Promise<void> {
  const deps = { ...createGenerateDeps(), ...overrides };

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' AI daily-news');
  console.log('═══════════════════════════════════════════════════════════\n');

  const publishedState = await deps.readState();
  const existingDraft = await deps.readDraft();
  let snapshot: PendingDraft | CollectionSnapshot | null = null;

  if (existingDraft) {
    const action = await deps.choosePendingDraftAction(existingDraft);
    if (action === 'cancel') {
      deps.log('本次运行已取消。');
      return;
    }

    if (action === 'resume') {
      deps.log(`[generate] 继续处理历史草稿，共 ${existingDraft.items.length} 条内容`);
      snapshot = existingDraft;
    } else {
      await deps.clearDraft();
    }
  }

  if (!snapshot) {
    snapshot = await deps.collect(publishedState);
    if (snapshot.items.length === 0) {
      deps.log('没有采集到新内容，本次运行结束。');
      return;
    }

    await deps.writeDraft(snapshot);
  }

  const enrichedCollectedItems = await deps.attachReaderBriefs(snapshot.items);
  const rankedItems = deps.rankItems(enrichedCollectedItems);
  const candidateItems = deps.selectCandidatePool(rankedItems);
  const curatedItems = await deps.curate(candidateItems);
  if (curatedItems.length === 0) {
    deps.log('AI 未整理出任何资讯，本次运行结束。');
    return;
  }

  const selectedItems = await deps.select(curatedItems);
  const formatted = deps.format(selectedItems, formatDateFromUnixSeconds(snapshot.collectedAt));

  const candidateIds = new Set(candidateItems.map((item) => item.id));
  const curatedIds = new Set(curatedItems.map((item) => item.id));
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const report: SelectionReport = {
    date: formatted.date,
    rankedItems: rankedItems.map((item) => ({
      ...item,
      enteredCandidatePool: candidateIds.has(item.id),
      selectedByLlm: curatedIds.has(item.id),
      selectedByHuman: selectedIds.has(item.id),
    })),
    curatedItems,
    selectedItems,
  };

  await deps.publish(formatted, report);
  await deps.writeState(advancePublishedState(publishedState, snapshot.enabledSources, snapshot.collectedAt));
  await deps.clearDraft();

  deps.log('\n✅  全部完成！');
}

async function main(): Promise<void> {
  await runGenerate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n❌  运行失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
