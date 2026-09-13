/**
 * Minimal protobuf reader for B站's binary subtitle metadata
 * (`/x/v2/subtitle/web/view`, `/x/v2/dm/web/view`).
 *
 * Envelope field 1 -> data; repeated data field 3 -> subtitle tracks.
 * Item fields: 1 id(varint), 2 id_str, 3 lan, 4 lan_doc, 5 subtitle_url.
 *
 * Unknown fields are skipped, so additive schema changes do not break parsing.
 * Reference: https://github.com/JoeyTeng/bilibili-helper/pull/4
 */

export interface ProtoField {
  no: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

export function decodeFields(data: Uint8Array, offset = 0): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= data.length) throw new Error('截断的 Protobuf 数据');
      const byte = data[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('无效的 Protobuf 整数');
    }
  };
  while (pos < data.length) {
    const key = readVarint();
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (no <= 0) throw new Error('无效的 Protobuf 字段');
    if (wire === 0) {
      fields.push({ no, wire, varint: readVarint() });
    } else if (wire === 2) {
      const size = Number(readVarint());
      if (pos + size > data.length) throw new Error('截断的 Protobuf 字段');
      fields.push({ no, wire, bytes: data.slice(pos, pos + size) });
      pos += size;
    } else if (wire === 1) {
      if (pos + 8 > data.length) throw new Error('截断的 Protobuf 字段');
      fields.push({ no, wire, bytes: data.slice(pos, pos + 8) });
      pos += 8;
    } else if (wire === 5) {
      if (pos + 4 > data.length) throw new Error('截断的 Protobuf 字段');
      fields.push({ no, wire, bytes: data.slice(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`不支持的 Protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function text(fields: ProtoField[], no: number): string {
  const field = fields.find((f) => f.no === no && f.wire === 2 && f.bytes);
  if (!field?.bytes) return '';
  return new TextDecoder().decode(field.bytes);
}

export interface ProtoSubtitleItem {
  id?: bigint;
  idStr?: string;
  lan: string;
  lanDoc: string;
  subtitleUrl: string;
}

export function parseSubtitleTracks(payload: Uint8Array): ProtoSubtitleItem[] {
  const envelope = decodeFields(payload);
  const dataField = envelope.find((f) => f.no === 1 && f.wire === 2 && f.bytes);
  if (!dataField?.bytes) return [];
  const tracks: ProtoSubtitleItem[] = [];
  for (const field of decodeFields(dataField.bytes)) {
    if (field.no !== 3 || field.wire !== 2 || !field.bytes) continue;
    const item = decodeFields(field.bytes);
    const lan = text(item, 3);
    const subtitleUrl = text(item, 5);
    if (!lan || !subtitleUrl) continue;
    tracks.push({
      id: item.find((f) => f.no === 1 && f.wire === 0)?.varint,
      idStr: text(item, 2),
      lan,
      lanDoc: text(item, 4),
      subtitleUrl,
    });
  }
  return tracks;
}
