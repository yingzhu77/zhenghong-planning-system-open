import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { HttpError } from './errors.mjs';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_SIDE = 10000;
const MAX_IMAGE_PIXELS = 24000000;
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe, FREE = 0xffffffff;
const invalid = () => { throw new HttpError(400, '文件格式无法识别或内容已损坏，请重新导出后上传'); };
const unsafeOffice = () => { throw new HttpError(400, '不支持含宏或加密的Office文件，请另存为无宏、未加密版本后上传'); };
const expandedTooLarge = () => { throw new HttpError(400, '附件展开后过大，请精简内容或重新导出后上传'); };
const animatedImage = () => { throw new HttpError(400, '暂不支持动态图，请转为静态图片后上传'); };
const requireValid = (value) => { if (!value) invalid(); };
function imageDimensions(width, height) {
  requireValid(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0);
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) throw new HttpError(400, '图片尺寸过大，请缩小图片后上传（每边最多10000像素，总像素最多2400万）');
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function decodedPartName(name) {
  try { name = decodeURIComponent(name); } catch { invalid(); }
  requireValid(!/[\\\0:]/.test(name) && !name.startsWith('/') && name.split('/').every((p) => p !== '.' && p !== '..'));
  return name.toLowerCase();
}

// Read both ZIP directories. Consumed entries are bounded, decompressed and CRC
// checked. The plan-only reader can explicitly omit media it never consumes.
export function readZip(bytes, { ignoreContent, maxEntries = 2048 } = {}) {
  requireValid(bytes.length >= 22 && bytes.readUInt32LE(0) === 0x04034b50);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  requireValid(end >= 0);
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryAt = bytes.readUInt32LE(end + 16);
  requireValid(!bytes.readUInt16LE(end + 4) && !bytes.readUInt16LE(end + 6) && count === bytes.readUInt16LE(end + 8));
  requireValid(count > 0 && count <= maxEntries && directoryAt + directorySize === end);
  let at = directoryAt, expanded = 0;
  const entries = new Map(), ranges = [];
  for (let i = 0; i < count; i++) {
    requireValid(at + 46 <= end && bytes.readUInt32LE(at) === 0x02014b50);
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), nameSize = bytes.readUInt16LE(at + 28);
    const extraSize = bytes.readUInt16LE(at + 30), commentSize = bytes.readUInt16LE(at + 32), localAt = bytes.readUInt32LE(at + 42);
    if (flags & (1 | 0x40 | 0x2000)) unsafeOffice();
    requireValid((flags & ~0x080e) === 0 && [0, 8].includes(method) && !bytes.readUInt16LE(at + 34));
    requireValid(nameSize > 0 && nameSize <= 1024 && at + 46 + nameSize + extraSize + commentSize <= end);
    const rawName = bytes.subarray(at + 46, at + 46 + nameSize), name = rawName.toString('utf8');
    requireValid(!name.includes('\ufffd') && !/[\\\0:]/.test(name) && !name.startsWith('/') && name.split('/').every((p) => p !== '.' && p !== '..'));
    const key = decodedPartName(name);
    requireValid(!entries.has(key) && compressed !== 0xffffffff && size !== 0xffffffff && localAt !== 0xffffffff);
    const ignored = ignoreContent?.(key) === true;
    if (!ignored) {
      expanded += size;
      if (expanded > MAX_EXPANDED_BYTES || size > MAX_ENTRY_BYTES) expandedTooLarge();
    }
    requireValid(method !== 0 || compressed === size);
    requireValid(localAt + 30 <= directoryAt && bytes.readUInt32LE(localAt) === 0x04034b50);
    requireValid(bytes.readUInt16LE(localAt + 6) === flags && bytes.readUInt16LE(localAt + 8) === method);
    const localNameSize = bytes.readUInt16LE(localAt + 26), localExtraSize = bytes.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameSize + localExtraSize, dataEnd = dataAt + compressed;
    requireValid(localNameSize === nameSize && bytes.subarray(localAt + 30, localAt + 30 + localNameSize).equals(rawName) && dataEnd <= directoryAt);
    if (!(flags & 8)) requireValid(bytes.readUInt32LE(localAt + 14) === crc && bytes.readUInt32LE(localAt + 18) === compressed && bytes.readUInt32LE(localAt + 22) === size);
    let rangeEnd = dataEnd;
    if (flags & 8) {
      const descriptorAt = dataEnd + (dataEnd + 4 <= directoryAt && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      requireValid(descriptorAt + 12 <= directoryAt && bytes.readUInt32LE(descriptorAt) === crc && bytes.readUInt32LE(descriptorAt + 4) === compressed && bytes.readUInt32LE(descriptorAt + 8) === size);
      rangeEnd = descriptorAt + 12;
    }
    ranges.push([localAt, rangeEnd]);
    if (ignored) {
      // Still validate names, encryption flags, directory/local agreement and
      // byte ranges. No ignored image is decoded, returned or executed.
      entries.set(key, null);
      at += 46 + nameSize + extraSize + commentSize;
      continue;
    }
    let content;
    try { content = method === 0 ? bytes.subarray(dataAt, dataEnd) : inflateRawSync(bytes.subarray(dataAt, dataEnd), { maxOutputLength: Math.min(size + 1, MAX_ENTRY_BYTES + 1) }); }
    catch { invalid(); }
    requireValid(content.length === size && crc32(content) === crc);
    if (name.endsWith('/')) requireValid(!size);
    entries.set(key, content);
    at += 46 + nameSize + extraSize + commentSize;
  }
  requireValid(at === end);
  ranges.sort((a, b) => a[0] - b[0]);
  requireValid(ranges[0][0] === 0 && ranges.at(-1)[1] === directoryAt);
  for (let i = 1; i < ranges.length; i++) requireValid(ranges[i - 1][1] === ranges[i][0]);
  return entries;
}

export function xmlText(bytes) {
  requireValid(bytes?.length && bytes.length <= MAX_ENTRY_BYTES);
  let text;
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch { invalid(); }
  requireValid(!text.includes('\ufffd') && !/<!DOCTYPE|<!ENTITY/i.test(text));
  return text.replace(/&#(x[\da-f]+|\d+);/gi, (_, value) => {
    const code = value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value);
    requireValid(code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff));
    return String.fromCodePoint(code);
  }).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function attributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/\b([\w:]+)\s*=\s*(["'])(.*?)\2/gs), (m) => [m[1], m[3]]));
}
function rootXml(text, name, namespaces) {
  const clean = text.replace(/^\ufeff/, '').replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  const tag = /^<([\w.-]+:)?([\w.-]+)\b[^>]*>/.exec(clean);
  requireValid(tag && tag[2] === name);
  const attrs = attributes(tag[0]), prefix = tag[1]?.slice(0, -1);
  requireValid(namespaces.includes(attrs[prefix ? 'xmlns:' + prefix : 'xmlns']));
  requireValid(tag[0].endsWith('/>') || clean.endsWith('</' + (tag[1] || '') + name + '>'));
}
export function readOfficeParts(bytes, suffix, zipOptions) {
  const entries = readZip(bytes, zipOptions);
  for (const [name, content] of entries) {
    if (/vba|macro|\.docm$|\.xlsm$|\.xlam$|\.dotm$|\.xltm$/i.test(name)) unsafeOffice();
    if (content === null) continue;
    if (name === '[content_types].xml' || name.endsWith('.rels')) {
      const metadata = xmlText(content).replace(/%([\da-f]{2})/gi, (_, value) => String.fromCharCode(parseInt(value, 16)));
      if (/vba|macroenabled|macrosheet|intlmacrosheet/i.test(metadata)) unsafeOffice();
    }
    // Embedded OLE packages may contain a second macro document. Validate them
    // too; encrypted OOXML containers are also CFB and are refused below.
    if (content.length >= 8 && content.subarray(0, 8).equals(CFB_SIGNATURE)) officeCfb(content);
    else if (/\/embeddings\//.test(name)) unsafeOffice();
  }
  const word = suffix === '.docx', main = word ? 'word/document.xml' : 'xl/workbook.xml';
  const mainType = word ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  const types = xmlText(entries.get('[content_types].xml')), relationships = xmlText(entries.get('_rels/.rels'));
  rootXml(types, 'Types', ['http://schemas.openxmlformats.org/package/2006/content-types']);
  rootXml(relationships, 'Relationships', ['http://schemas.openxmlformats.org/package/2006/relationships']);
  const overrides = Array.from(types.matchAll(/<(?:[\w.-]+:)?Override\b[^>]*\/?\s*>/g), (m) => attributes(m[0]));
  requireValid(overrides.some((a) => a.PartName === '/' + main && a.ContentType === mainType));
  const documents = Array.from(relationships.matchAll(/<(?:[\w.-]+:)?Relationship\b[^>]*\/?\s*>/g), (m) => attributes(m[0])).filter((a) => /\/officeDocument$/.test(a.Type));
  requireValid(documents.length === 1 && !documents[0].TargetMode && decodedPartName(documents[0].Target.replace(/^\//, '')) === main);
  rootXml(xmlText(entries.get(main)), word ? 'document' : 'workbook', word ? ['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'] : ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main']);
  return entries;
}
function officeZip(bytes, suffix) {
  readOfficeParts(bytes, suffix);
  return suffix === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

// MS-CFB: resolve FAT/DIFAT, directory trees and MiniFAT rather than accepting
// the common OLE signature. Sector ownership prevents overlapping/cyclic chains.
function cfbStreams(bytes) {
  requireValid(bytes.length >= 1536 && bytes.subarray(0, 8).equals(CFB_SIGNATURE));
  const version = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30), sectorSize = 2 ** shift;
  requireValid([3, 4].includes(version) && shift === (version === 3 ? 9 : 12) && bytes.readUInt16LE(28) === 0xfffe && bytes.readUInt16LE(32) === 6 && bytes.readUInt32LE(56) === 4096);
  requireValid(bytes.subarray(8, 24).every((b) => !b) && bytes.subarray(34, 40).every((b) => !b) && bytes.length % sectorSize === 0);
  if (version === 3) requireValid(!bytes.readUInt32LE(40));
  const sectorCount = bytes.length / sectorSize - 1, fatCount = bytes.readUInt32LE(44), difCount = bytes.readUInt32LE(72);
  requireValid(fatCount > 0 && fatCount <= sectorCount && difCount <= sectorCount);
  const claimed = new Set(), sector = (id) => {
    requireValid(Number.isInteger(id) && id >= 0 && id < sectorCount);
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const claim = (id) => { requireValid(!claimed.has(id)); claimed.add(id); return sector(id); };
  const fatIds = [];
  const appendFat = (value) => { if (value !== FREE) { requireValid(fatIds.length < fatCount); fatIds.push(value); } };
  for (let at = 76; at < 512; at += 4) appendFat(bytes.readUInt32LE(at));
  let difAt = bytes.readUInt32LE(68);
  const difIds = [];
  for (let i = 0; i < difCount; i++) {
    difIds.push(difAt);
    const block = claim(difAt);
    for (let at = 0; at < sectorSize - 4; at += 4) appendFat(block.readUInt32LE(at));
    difAt = block.readUInt32LE(sectorSize - 4);
  }
  requireValid((!difCount && [END, FREE].includes(difAt)) || (difCount && difAt === END));
  requireValid(fatIds.length === fatCount);
  const fatBytes = Buffer.concat(fatIds.map(claim)), fat = Array.from({ length: fatBytes.length / 4 }, (_, i) => fatBytes.readUInt32LE(i * 4));
  requireValid(fat.length >= sectorCount);
  for (const id of fatIds) requireValid(fat[id] === 0xfffffffd);
  for (const id of difIds) requireValid(fat[id] === 0xfffffffc);
  function chain(start, expectedBytes) {
    const blocks = [];
    for (let id = start; id !== END; id = fat[id]) { requireValid(blocks.length < sectorCount); blocks.push(claim(id)); }
    if (expectedBytes !== undefined) requireValid(blocks.length === Math.ceil(expectedBytes / sectorSize));
    return Buffer.concat(blocks).subarray(0, expectedBytes);
  }
  const directory = chain(bytes.readUInt32LE(48));
  requireValid(directory.length > 0 && (version !== 4 || directory.length / sectorSize === bytes.readUInt32LE(40)));
  const entries = [];
  for (let at = 0; at < directory.length; at += 128) {
    const block = directory.subarray(at, at + 128), kind = block[66];
    if (!kind) { entries.push(null); continue; }
    const nameSize = block.readUInt16LE(64);
    requireValid([1, 2, 5].includes(kind) && nameSize >= 2 && nameSize <= 64 && !(nameSize % 2) && !block.readUInt16LE(nameSize - 2));
    const name = block.subarray(0, nameSize - 2).toString('utf16le');
    requireValid(name.length && !/[\\/\0:!]/.test(name));
    if (/vba|macro|^project$|projectwm|encryptedpackage|encryptioninfo|ole10native|^package$/i.test(name)) unsafeOffice();
    const size = version === 3 ? block.readUInt32LE(120) : Number(block.readBigUInt64LE(120));
    requireValid(Number.isSafeInteger(size) && size <= bytes.length);
    entries.push({ name, kind, left: block.readUInt32LE(68), right: block.readUInt32LE(72), child: block.readUInt32LE(76), start: block.readUInt32LE(116), size });
  }
  const root = entries[0];
  requireValid(root?.kind === 5 && root.name === 'Root Entry' && root.left === FREE && root.right === FREE);
  const visited = new Set([0]), paths = new Map(), queue = [[root.child, '']];
  while (queue.length) {
    const [id, parent] = queue.pop();
    if (id === FREE) continue;
    requireValid(id > 0 && id < entries.length && !visited.has(id)); visited.add(id);
    const entry = entries[id]; requireValid(entry && entry.kind !== 5);
    const name = (parent + '/' + entry.name).toLowerCase(); requireValid(!paths.has(name)); paths.set(name, entry);
    queue.push([entry.left, parent], [entry.right, parent]);
    if (entry.kind === 1) queue.push([entry.child, name]); else requireValid(entry.child === FREE);
  }
  requireValid(entries.every((entry, id) => !entry || visited.has(id)));
  const miniFatCount = bytes.readUInt32LE(64), miniFatStart = bytes.readUInt32LE(60);
  requireValid(miniFatCount <= sectorCount);
  const miniFatBytes = chain(miniFatStart, miniFatCount * sectorSize), miniRoot = chain(root.start, root.size);
  const miniClaimed = new Set();
  const streams = new Map();
  for (const [name, entry] of paths) {
    if (entry.kind !== 2) continue;
    let content;
    if (entry.size >= 4096) content = chain(entry.start, entry.size);
    else {
      const blocks = [];
      for (let id = entry.start; id !== END; id = miniFatBytes.readUInt32LE(id * 4)) {
        requireValid(Number.isInteger(id) && id >= 0 && id * 4 + 4 <= miniFatBytes.length && (id + 1) * 64 <= miniRoot.length && !miniClaimed.has(id));
        miniClaimed.add(id); blocks.push(miniRoot.subarray(id * 64, (id + 1) * 64));
      }
      requireValid(blocks.length === Math.ceil(entry.size / 64));
      content = Buffer.concat(blocks).subarray(0, entry.size);
    }
    streams.set(name, content);
  }
  return streams;
}

function checkWord(bytes, streams, name) {
  requireValid(bytes.length >= 154 && bytes.readUInt16LE(0) === 0xa5ec);
  const baseVersion = bytes.readUInt16LE(2), counts = { 193: [93, 0], 217: [108, 2], 257: [136, 2], 268: [164, 2], 274: [183, 5] };
  requireValid(counts[baseVersion]);
  const flags = bytes.readUInt16LE(10);
  if (flags & 0x0100) unsafeOffice();
  const table = streams.get(name.replace(/worddocument$/, flags & 0x0200 ? '1table' : '0table'));
  // MS-DOC 2.5.1: fixed-word arrays precede the counted fc/lcb table.
  requireValid(table?.length && bytes.readUInt16LE(32) === 14 && bytes.readUInt16LE(62) === 22);
  const pairs = bytes.readUInt16LE(152), newAt = 154 + pairs * 8;
  requireValid(newAt + 2 <= bytes.length);
  const newWords = bytes.readUInt16LE(newAt);
  requireValid([0, 2, 5].includes(newWords) && newAt + 2 + newWords * 2 <= bytes.length);
  const version = newWords ? bytes.readUInt16LE(newAt + 2) : baseVersion;
  requireValid(counts[version] && pairs === counts[version][0] && newWords === counts[version][1]);
  // The style sheet, character/paragraph formatting, document properties and
  // associated strings must point inside the selected Table stream.
  for (const index of [1, 12, 13, 31, 32]) {
    const offset = bytes.readUInt32LE(154 + index * 8), size = bytes.readUInt32LE(158 + index * 8);
    requireValid(size > 0 && offset + size <= table.length);
  }
}
function checkWorkbook(bytes) {
  let at = 0, depth = 0, globals = false, sheets = 0;
  while (at < bytes.length) {
    if (!depth && at > 0 && bytes.subarray(at).every((byte) => !byte)) break;
    requireValid(at + 4 <= bytes.length);
    const record = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2), data = at + 4;
    requireValid(data + size <= bytes.length && size <= 8224);
    if ([0x002f, 0x00d3].includes(record)) unsafeOffice();
    if (record === 0x0809) {
      requireValid(size === 16 && bytes.readUInt16LE(data) === 0x0600);
      const type = bytes.readUInt16LE(data + 2);
      if ([0x0006, 0x0040].includes(type)) unsafeOffice();
      requireValid([0x0005, 0x0010, 0x0020].includes(type));
      if (!at) { requireValid(type === 5); globals = true; }
      depth++;
    } else if (record === 0x000a) { requireValid(size === 0 && depth > 0); depth--; }
    else if (record === 0x0085) {
      requireValid(size >= 8);
      if ([1, 6].includes(bytes[data + 5])) unsafeOffice();
      requireValid([0, 2].includes(bytes[data + 5]));
      const sheetAt = bytes.readUInt32LE(data);
      requireValid(sheetAt + 8 <= bytes.length && bytes.readUInt16LE(sheetAt) === 0x0809);
      sheets++;
    }
    else requireValid(depth > 0);
    at = data + size;
  }
  requireValid(globals && sheets > 0 && depth === 0);
}
function officeCfb(bytes, suffix) {
  const streams = cfbStreams(bytes);
  for (const [name, content] of streams) {
    if (name.endsWith('/worddocument')) checkWord(content, streams, name);
    if (/\/(workbook|book)$/.test(name)) checkWorkbook(content);
  }
  if (suffix === '.doc') { requireValid(streams.has('/worddocument')); return 'application/msword'; }
  if (suffix === '.xls') { requireValid(streams.has('/workbook') || streams.has('/book')); return 'application/vnd.ms-excel'; }
  // Embedded containers must themselves be recognisable Office documents.
  requireValid(streams.has('/worddocument') || streams.has('/workbook') || streams.has('/book'));
}

function imageOrPdf(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let at = 8, chunks = 0, data = false;
    while (at + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(at), name = bytes.subarray(at + 4, at + 8).toString('ascii');
      requireValid(size <= bytes.length - at - 12 && /^[A-Za-z]{4}$/.test(name));
      requireValid(crc32(bytes.subarray(at + 4, at + 8 + size)) === bytes.readUInt32BE(at + 8 + size));
      if (!chunks++) { requireValid(name === 'IHDR' && size === 13); imageDimensions(bytes.readUInt32BE(at + 8), bytes.readUInt32BE(at + 12)); }
      else requireValid(name !== 'IHDR');
      if (['acTL', 'fcTL', 'fdAT'].includes(name)) animatedImage();
      if (name === 'IDAT') data = true;
      at += 12 + size;
      if (name === 'IEND') { requireValid(!size && data && at === bytes.length); return ['image/png', '.png']; }
    }
    invalid();
  }
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
    const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
    imageDimensions(width, height);
    let at = 13 + (bytes[10] & 0x80 ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0), frames = 0;
    const skipBlocks = () => {
      let total = 0;
      while (at < bytes.length) {
        const size = bytes[at++];
        if (!size) return total;
        requireValid(at + size <= bytes.length); at += size; total += size;
      }
      invalid();
    };
    while (at < bytes.length) {
      const marker = bytes[at++];
      if (marker === 0x3b) { requireValid(at === bytes.length && frames === 1); return ['image/gif', '.gif']; }
      if (marker === 0x21) { requireValid(at < bytes.length); at++; skipBlocks(); continue; }
      requireValid(marker === 0x2c && at + 9 <= bytes.length);
      if (++frames > 1) animatedImage();
      const left = bytes.readUInt16LE(at), top = bytes.readUInt16LE(at + 2), frameWidth = bytes.readUInt16LE(at + 4), frameHeight = bytes.readUInt16LE(at + 6), flags = bytes[at + 8];
      imageDimensions(frameWidth, frameHeight);
      requireValid(left + frameWidth <= width && top + frameHeight <= height);
      at += 9 + (flags & 0x80 ? 3 * (2 ** ((flags & 7) + 1)) : 0);
      requireValid(at < bytes.length && bytes[at] >= 2 && bytes[at] <= 8); at++;
      requireValid(skipBlocks() > 0);
    }
    invalid();
  }
  if (bytes.length >= 20 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    requireValid(bytes.readUInt32LE(4) + 8 === bytes.length);
    let at = 12, frames = 0, canvas, frame;
    while (at + 8 <= bytes.length) {
      const kind = bytes.subarray(at, at + 4).toString(), size = bytes.readUInt32LE(at + 4), dataAt = at + 8;
      requireValid(dataAt + size + (size % 2) <= bytes.length);
      if (['ANIM', 'ANMF'].includes(kind)) animatedImage();
      if (kind === 'VP8X') {
        requireValid(at === 12 && size === 10 && !(bytes[dataAt] & 0xc1) && bytes.subarray(dataAt + 1, dataAt + 4).every((b) => !b));
        if (bytes[dataAt] & 2) animatedImage();
        canvas = [bytes.readUIntLE(dataAt + 4, 3) + 1, bytes.readUIntLE(dataAt + 7, 3) + 1]; imageDimensions(...canvas);
      }
      if (kind === 'VP8 ' || kind === 'VP8L') {
        requireValid(++frames === 1);
        if (kind === 'VP8 ') {
          requireValid(size >= 10 && !(bytes[dataAt] & 1) && bytes.subarray(dataAt + 3, dataAt + 6).equals(Buffer.from([0x9d, 1, 0x2a])) && !(bytes.readUInt16LE(dataAt + 6) & 0xc000) && !(bytes.readUInt16LE(dataAt + 8) & 0xc000));
          frame = [bytes.readUInt16LE(dataAt + 6) & 0x3fff, bytes.readUInt16LE(dataAt + 8) & 0x3fff];
        } else {
          requireValid(size >= 5 && bytes[dataAt] === 0x2f);
          const bits = bytes.readUInt32LE(dataAt + 1); requireValid(!(bits >>> 29));
          frame = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
        }
        imageDimensions(...frame);
      }
      at = dataAt + size + (size % 2);
    }
    requireValid(at === bytes.length && frames === 1 && (!canvas || (canvas[0] === frame[0] && canvas[1] === frame[1])));
    return ['image/webp', '.webp'];
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    requireValid(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9);
    let at = 2, frame = false;
    while (at + 4 <= bytes.length) {
      requireValid(bytes[at] === 0xff);
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++], size = bytes.readUInt16BE(at);
      requireValid(size >= 2 && at + size <= bytes.length);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { requireValid(size >= 8 && !frame); imageDimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)); frame = true; }
      if (marker === 0xda) { requireValid(frame); return ['image/jpeg', '.jpg']; }
      at += size;
    }
    invalid();
  }
  if (bytes.length >= 20 && /^%PDF-[12]\.\d/.test(bytes.subarray(0, 8).toString('ascii'))) {
    requireValid(/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1')) && /\b\d+\s+\d+\s+obj\b/.test(bytes.toString('latin1')));
    return ['application/pdf', '.pdf'];
  }
  invalid();
}

export function detectAttachmentType(buffer, filename) {
  requireValid(Buffer.isBuffer(buffer) && buffer.length > 0 && typeof filename === 'string' && filename.length <= 255 && !filename.includes('\0'));
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new HttpError(400, '单个附件不能超过8MiB');
  const suffix = path.extname(filename).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.docx', '.xlsx', '.doc', '.xls'].includes(suffix)) throw new HttpError(400, '仅支持JPG、PNG、GIF、WebP、PDF、Word或Excel文件');
  try {
    if (['.docx', '.xlsx'].includes(suffix)) return { type: officeZip(buffer, suffix), ext: suffix, inline: false };
    if (['.doc', '.xls'].includes(suffix)) return { type: officeCfb(buffer, suffix), ext: suffix, inline: false };
    const [type, ext] = imageOrPdf(buffer);
    if (!(ext === '.jpg' ? ['.jpg', '.jpeg'] : [ext]).includes(suffix)) throw new HttpError(400, '文件扩展名与实际格式不一致');
    return { type, ext, inline: true };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  }
}
