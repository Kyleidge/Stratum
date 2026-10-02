/**
 * A minimal store-only ZIP writer. Report PDFs embed JPEG pages, so
 * compression would gain almost nothing; files are written as-is with CRC-32.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export const ZIP_LIMIT = 1024 * 1024 * 1024;

export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> };

/** Unique, portable entry names: "SN-1.pdf", "SN-1 (2).pdf". */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const clean =
      Array.from(name, (char) =>
        char.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(char) ? '_' : char,
      )
        .join('')
        .trim()
        .slice(0, 150) || 'file';
    const dot = clean.lastIndexOf('.');
    const [stem, extension] =
      dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
    let candidate = clean;
    for (let copy = 2; used.has(candidate.toLowerCase()); copy++)
      candidate = `${stem} (${copy})${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  const now = new Date();
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();
  for (const entry of entries) {
    const name = new Uint8Array(encoder.encode(entry.name));
    const crc = crc32(entry.data);
    const size = entry.data.byteLength;
    if (offset + size > ZIP_LIMIT)
      throw new Error(
        'The ZIP would exceed 1 GiB. Export fewer items at a time.',
      );
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, entry.data);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 20, true);
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, time, true);
    header.setUint16(14, date, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, size, true);
    header.setUint32(24, size, true);
    header.setUint16(28, name.byteLength, true);
    header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.byteLength + size;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], {
    type: 'application/zip',
  });
}
