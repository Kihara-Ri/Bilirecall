import { describe, expect, it } from 'vitest';
import { favoriteVideos, historyVideos, likedVideos } from '../src/lib/bili';

describe('historyVideos', () => {
  const payload = {
    data: {
      list: [
        {
          title: '历史里的视频',
          cover: 'http://i0.hdslb.com/a.jpg',
          author_name: 'UP',
          author_mid: 7,
          duration: 300,
          progress: 42,
          is_finish: 1,
          view_at: 1700000000,
          history: { oid: 111, bvid: 'BV1xx411c7mD', cid: 222, business: 'archive' },
        },
        { title: '直播 / 广告没有 bvid', history: { oid: 9, business: 'live' } },
      ],
    },
  };

  it('reads bvid / cid / progress out of the history cursor response', () => {
    const [item] = historyVideos(payload);
    expect(item).toMatchObject({
      bvid: 'BV1xx411c7mD',
      aid: 111,
      cid: 222,
      title: '历史里的视频',
      owner: 'UP',
      ownerMid: 7,
      source: 'history',
      progress: 42,
      finished: true,
    });
    expect(item.watchedAt).toBe(1700000000000);
  });

  it('accepts a millisecond timestamp, and a nested one', () => {
    const [asMs] = historyVideos({ data: { list: [{ title: 'x', history: { bvid: 'BV1ms411c7mD', cid: 1 }, view_at: 1700000000123 }] } });
    expect(asMs.watchedAt).toBe(1700000000123);
    const [nested] = historyVideos({ data: { list: [{ title: 'y', history: { bvid: 'BV1ne411c7mD', cid: 2, view_at: 1700000001 } }] } });
    expect(nested.watchedAt).toBe(1700000001000);
  });

  it('drops entries that are not archive videos', () => {
    expect(historyVideos(payload)).toHaveLength(1);
  });

  it('tolerates a missing or empty list', () => {
    expect(historyVideos({})).toEqual([]);
    expect(historyVideos({ data: { list: [] } })).toEqual([]);
  });
});

describe('likedVideos', () => {
  it('reads the space likes response', () => {
    const items = likedVideos({ data: { list: [{ bvid: 'BV1yy411c7mD', aid: 5, title: '赞过的', owner: { mid: 3, name: 'UP2' }, pic: 'https://i0.hdslb.com/b.jpg', duration: 60 }] } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ bvid: 'BV1yy411c7mD', owner: 'UP2', source: 'likes', cover: 'https://i0.hdslb.com/b.jpg' });
  });
});

describe('favoriteVideos', () => {
  it('reads a favourites folder page', () => {
    const items = favoriteVideos({ data: { medias: [{ bvid: 'BV1zz411c7mD', id: 6, title: '收藏的', upper: { mid: 4, name: 'UP3' }, cover: 'https://i0.hdslb.com/c.jpg', duration: 90 }] } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ bvid: 'BV1zz411c7mD', owner: 'UP3', source: 'favorites' });
  });
});
