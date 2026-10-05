import { promises as fs } from 'node:fs';
import path from 'node:path';

const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const UNIX_MADE_BY = (3 << 8) | ZIP_VERSION;
const REGULAR_FILE_ATTRS = (0o100644 << 16) >>> 0;
const MAX_FILES = 65_535;
const MAX_UINT32 = 0xffff_ffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffff_ffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function collectFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Deterministic MCPB refuses symlink: ${rel}`);
    if (entry.isDirectory()) files.push(...await collectFiles(root, rel));
    else if (entry.isFile()) files.push(rel.split(path.sep).join('/'));
    else throw new Error(`Deterministic MCPB refuses non-file entry: ${rel}`);
  }
  return files;
}

function localHeader(nameBytes, bytes, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(ZIP_VERSION, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8); // Stored: avoids zlib-version-dependent bytes across release runners.
  header.writeUInt16LE(0, 10); // 1980-01-01 00:00:00 DOS time/date.
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(bytes.length, 18);
  header.writeUInt32LE(bytes.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(nameBytes, bytes, crc, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(UNIX_MADE_BY, 4);
  header.writeUInt16LE(ZIP_VERSION, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x21, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(bytes.length, 20);
  header.writeUInt32LE(bytes.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(REGULAR_FILE_ATTRS, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export async function writeDeterministicZip(root, target) {
  const files = await collectFiles(root);
  if (files.length === 0 || files.length > MAX_FILES) throw new Error(`Invalid MCPB file count: ${files.length}`);

  const body = [];
  const central = [];
  let offset = 0;
  for (const name of files) {
    const bytes = await fs.readFile(path.join(root, ...name.split('/')));
    const nameBytes = Buffer.from(name, 'utf8');
    if (nameBytes.length > 0xffff) throw new Error(`MCPB path is too long: ${name}`);
    if (bytes.length > MAX_UINT32 || offset > MAX_UINT32) throw new Error('MCPB exceeds ZIP32 bounds.');
    const crc = crc32(bytes);
    const local = localHeader(nameBytes, bytes, crc);
    body.push(local, nameBytes, bytes);
    central.push(centralHeader(nameBytes, bytes, crc, offset), nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (centralOffset > MAX_UINT32 || centralSize > MAX_UINT32) throw new Error('MCPB central directory exceeds ZIP32 bounds.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(target, Buffer.concat([...body, ...central, end]));
  return files;
}
