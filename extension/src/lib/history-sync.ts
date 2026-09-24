import type { BiliClient, BiliListVideo, HistoryCursor, ListPage } from './bili';
import { applyArchiveItem } from './archive';
import { inLibrary } from './history';
import { newRecord, type KeyValueStore, type Repository } from './store';
import type { ActionState } from './types';

export const HISTORY_JOB_KEY = 'history-sync-job';
/** 两轮同步的最小间隔；失败的任务过了同一个窗口就自动续跑，不需要人工重试。 */
export const SYNC_INTERVAL_MS = 300_000;
/** 互动状态（赞/币/藏）的刷新周期：每次同步只补查比这更旧的记录，避免整库重刷拖慢历史对齐。 */
export const RELATION_STALE_MS = 6 * 60 * 60 * 1000;
type Phase = 'history' | 'likes' | 'favorites' | 'relations' | 'done';
export interface HistorySyncStatus {
  state: 'idle' | 'running' | 'error' | 'done';
  phase: Phase;
  count: number;
  lastCompletedAt: number;
  error?: string;
  warnings: string[];
}
interface Job extends HistorySyncStatus {
  mid: number;
  cursor?: HistoryCursor;
  page: number;
  folders?: number[];
  folder: number;
  relationKeys?: string[];
  relationIndex: number;
  startedAt: number;
  /** 上次失败的时刻，与 lastCompletedAt 共同决定自动重试的退避窗口。 */
  failedAt?: number;
}
type Client = Pick<BiliClient, 'nav' | 'historyPage' | 'likedPage' | 'favoriteFolders' | 'favoritePage' | 'view'>;
interface RelationSnapshot extends Pick<ActionState, 'like' | 'coin' | 'favorite'> {
  fetchedAt: number;
  warnings: string[];
}
const initial = (): Job => ({
  state: 'idle',
  phase: 'history',
  count: 0,
  lastCompletedAt: 0,
  warnings: [],
  mid: 0,
  page: 1,
  folder: 0,
  relationIndex: 0,
  startedAt: 0,
});

/** 每次 tick 只处理一页或少量互动。进度存在 storage；SW 休眠后 alarm 可以安全重放当前页。 */
export class HistorySync {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly store: KeyValueStore,
    private readonly repo: Repository,
    private readonly client: Client,
    private readonly relation: (bvid: string, aid: number) => Promise<RelationSnapshot>,
    private readonly lock: <T>(key: string, fn: () => Promise<T>) => Promise<T> = (_key, fn) => fn(),
  ) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => undefined);
    return next;
  }
  private async job(): Promise<Job> {
    return ((await this.store.get([HISTORY_JOB_KEY]))[HISTORY_JOB_KEY] as Job) ?? initial();
  }
  private async save(job: Job): Promise<void> {
    await this.store.set({ [HISTORY_JOB_KEY]: job });
  }
  async status(): Promise<HistorySyncStatus> {
    return this.job();
  }

  /** UI 请求只入队并立即返回，不能把长任务绑在 sendMessage 通道上。 */
  async start(force = false): Promise<HistorySyncStatus> {
    return this.exclusive(async () => {
      const previous = await this.job();
      if (previous.state === 'running') return previous;
      // 完成与失败共用同一个节流窗口：错误不再永久停摆，到期由周期闹钟自动续跑（保留游标）。
      const settledAt = Math.max(previous.lastCompletedAt, previous.failedAt ?? 0);
      if (!force && Date.now() - settledAt < SYNC_INTERVAL_MS) return previous;
      const job =
        previous.state === 'error'
          ? { ...previous, state: 'running' as const, error: undefined, failedAt: undefined }
          : {
              ...initial(),
              state: 'running' as const,
              lastCompletedAt: previous.lastCompletedAt,
              startedAt: Date.now(),
            };
      await this.save(job);
      return job;
    });
  }

  async tick(): Promise<HistorySyncStatus> {
    return this.exclusive(async () => {
      const job = await this.job();
      if (job.state !== 'running') return job;
      try {
        // 每一批校验登录和账号，避免休眠期间切号后把两个账号误合并。
        const nav = await this.client.nav();
        if (!nav.isLogin || !nav.mid) throw new Error('请先登录 B站，再重试');
        if (job.mid && job.mid !== nav.mid) throw new Error('B站账号已切换，请切回原账号后重试');
        job.mid = nav.mid;
        if (job.phase === 'history') {
          const page = await this.client.historyPage(job.cursor);
          const known = new Set((await this.repo.list()).map((record) => `${record.bvid}:${record.cid}`));
          const reachedKnown =
            job.lastCompletedAt > 0 &&
            page.items.length > 0 &&
            page.items.every(
              (item) => known.has(`${item.bvid}:${item.cid}`) && (item.watchedAt ?? 0) < job.lastCompletedAt,
            );
          await this.merge(page.items);
          job.count += page.items.length;
          if (!reachedKnown && page.more && page.cursor) job.cursor = page.cursor;
          else {
            job.phase = 'likes';
            job.page = 1;
          }
        } else if (job.phase === 'likes' || job.phase === 'favorites') {
          // 非历史来源失败不撤销已经获取的历史；保留可见警告，下一次更新可重试。
          try {
            let page: ListPage;
            if (job.phase === 'likes') page = await this.client.likedPage(job.mid, job.page);
            else {
              job.folders ??= await this.client.favoriteFolders(job.mid);
              const folder = job.folders[job.folder];
              page = folder ? await this.client.favoritePage(folder, job.page) : { items: [], more: false };
            }
            await this.merge(page.items);
            if (page.more) job.page += 1;
            else this.nextSource(job);
          } catch (error) {
            job.warnings.push(
              `${job.phase === 'likes' ? '点赞列表' : '收藏列表'}未更新：${error instanceof Error ? error.message : String(error)}`,
            );
            if (job.phase === 'likes') {
              job.phase = 'favorites';
              job.page = 1;
            } else job.phase = 'relations';
          }
        } else if (job.phase === 'relations') {
          job.relationKeys ??= (await this.repo.list())
            .filter((record) => !record.relation || record.relation.fetchedAt < job.startedAt - RELATION_STALE_MS)
            .map((record) => record.key);
          // 一批最多 5 条，外部 runner 在批次间限速；不再截断到最初20条。
          for (const key of job.relationKeys.slice(job.relationIndex, job.relationIndex + 5)) {
            const record = await this.repo.get(key);
            if (record) {
              try {
                const result = await this.relation(record.bvid, record.aid);
                await this.lock(key, async () => {
                  const latest = await this.repo.get(key);
                  if (!latest) return;
                  // 旧记录先固定收录边界，互动补全不能把仅观看记录自动升级为知识。
                  latest.library ??= { saved: inLibrary(latest) };
                  latest.actions = {
                    ...latest.actions,
                    like: result.like,
                    coin: result.coin,
                    favorite: result.favorite,
                  };
                  latest.relation = { source: 'api', fetchedAt: result.fetchedAt, warnings: result.warnings };
                  await this.repo.upsert(latest);
                });
              } catch {
                if (!job.warnings.includes('部分互动状态未更新')) job.warnings.push('部分互动状态未更新');
              }
            }
            job.relationIndex += 1;
          }
          if (job.relationIndex >= job.relationKeys.length) {
            job.phase = 'done';
            job.state = 'done';
            job.lastCompletedAt = Date.now();
          }
        }
      } catch (error) {
        job.state = 'error';
        job.error = error instanceof Error ? error.message : String(error);
        job.failedAt = Date.now();
      }
      await this.save(job);
      return job;
    });
  }

  private nextSource(job: Job): void {
    job.page = 1;
    if (job.phase === 'likes') job.phase = 'favorites';
    else if (++job.folder >= (job.folders?.length ?? 0)) job.phase = 'relations';
  }

  private async merge(items: BiliListVideo[]): Promise<void> {
    const records = await this.repo.list();
    for (const item of items) {
      if (!item.bvid.startsWith('BV')) continue;
      // 当前库读取与逐条合并，避免同视频在历史/点赞/收藏出现时丢失其余来源。
      const known = records.find((record) => record.bvid === item.bvid && (!item.cid || record.cid === item.cid));
      let entry = item;
      if (!known && !item.cid) {
        const info = await this.client.view(item.bvid);
        entry = {
          ...item,
          cid: info.cid,
          aid: item.aid || info.aid,
          cover: item.cover || info.cover,
          duration: item.duration || info.duration,
        };
      }
      const key = known?.key ?? `${entry.bvid}:${entry.cid}`;
      await this.lock(key, async () => {
        const latest = await this.repo.get(key);
        if (!latest && (await this.repo.wasRemoved(key))) return;
        const record = latest ?? newRecord({ ...entry, url: `https://www.bilibili.com/video/${entry.bvid}/` });
        record.library ??= { saved: latest ? inLibrary(latest) : false };
        const saved = await this.repo.upsert(applyArchiveItem(record, entry));
        if (!latest) records.push(saved);
      });
    }
  }
}
