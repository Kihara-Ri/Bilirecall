import { describe, expect, it } from 'vitest';
import { decodeFields, parseSubtitleTracks } from '../src/lib/protobuf';
import { encodeSubtitleProto, fieldBytes, fieldString, fieldVarint } from './helpers';

describe('protobuf subtitle metadata', () => {
  it('decodes varint, length-delimited and skips unknown fields', () => {
    const payload = new Uint8Array([
      ...fieldVarint(1, 300),
      ...fieldString(2, 'hi'),
      ...fieldBytes(9, [1, 2, 3]),
      ...fieldVarint(15, 7),
    ]);
    const fields = decodeFields(payload);
    expect(fields.find((f) => f.no === 1)?.varint).toBe(300n);
    expect(new TextDecoder().decode(fields.find((f) => f.no === 2)?.bytes)).toBe('hi');
    expect(fields.find((f) => f.no === 15)?.varint).toBe(7n);
  });

  it('parses the envelope -> data -> track layout', () => {
    const payload = encodeSubtitleProto([
      { id: 1497922385058359296, idStr: '1497922385058359296', lan: 'ai-zh', lanDoc: '中文（自动生成）', url: '//aisubtitle.hdslb.com/bfs/subtitle/proto.json' },
      { id: 2, idStr: '2', lan: 'zh-Hant', lanDoc: '中文（繁體）', url: '//aisubtitle.hdslb.com/bfs/subtitle/tw.json' },
    ]);
    const tracks = parseSubtitleTracks(payload);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ idStr: '1497922385058359296', lan: 'ai-zh', lanDoc: '中文（自动生成）' });
    expect(tracks[1].subtitleUrl).toBe('//aisubtitle.hdslb.com/bfs/subtitle/tw.json');
  });

  it('ignores tracks missing lan or url and tolerates an empty body', () => {
    const partial = new Uint8Array([
      ...fieldBytes(1, [...fieldBytes(3, [...fieldVarint(1, 5), ...fieldString(3, 'ai-zh')])]),
    ]);
    expect(parseSubtitleTracks(partial)).toEqual([]);
    expect(parseSubtitleTracks(new Uint8Array())).toEqual([]);
  });

  it('throws on truncated data', () => {
    const payload = new Uint8Array([...fieldBytes(1, [1, 2, 3, 4]), 0x12, 0x20]);
    expect(() => decodeFields(payload)).toThrow();
  });
});
