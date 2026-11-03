import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { detectAttachmentType, MAX_ATTACHMENT_BYTES } from '../server/attachment-types.mjs';
import { HttpError } from '../server/errors.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(items, { deflate = false, declaredSize } = {}) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, value] of items) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value), rawName = Buffer.from(name);
    const compressed = deflate ? deflateRawSync(bytes) : bytes, size = declaredSize ?? bytes.length, crc = crc32(bytes);
    const local = Buffer.alloc(30), entry = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(rawName.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(size, 24); entry.writeUInt16LE(rawName.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, rawName, compressed); central.push(entry, rawName); offset += local.length + rawName.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(items.length, 8); end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function ooxml(kind = 'word', additions = []) {
  const word = kind === 'word', main = word ? 'word/document.xml' : 'xl/workbook.xml';
  const content = word ? 'wordprocessingml.document' : 'spreadsheetml.sheet', namespace = word ? 'wordprocessingml' : 'spreadsheetml', root = word ? 'document' : 'workbook';
  return [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/' + main + '" ContentType="application/vnd.openxmlformats-officedocument.' + content + '.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="' + main + '"/></Relationships>'],
    [main, '<' + root + ' xmlns="http://schemas.openxmlformats.org/' + namespace + '/2006/main"></' + root + '>'],
    ...additions
  ];
}
const END = 0xfffffffe, FREE = 0xffffffff;
function cfb(streams) {
  const sectors = [Buffer.alloc(512, 255)], directoryCount = Math.ceil((streams.length + 1) / 4);
  for (let i = 0; i < directoryCount; i++) sectors.push(Buffer.alloc(512));
  const fat = sectors[0]; fat.writeUInt32LE(0xfffffffd, 0);
  const append = (bytes) => {
    if (!bytes.length) return END;
    const start = sectors.length;
    for (let at = 0; at < bytes.length; at += 512) {
      const block = Buffer.alloc(512); bytes.copy(block, 0, at, at + 512); sectors.push(block);
      fat.writeUInt32LE(at + 512 < bytes.length ? sectors.length : END, (sectors.length - 1) * 4);
    }
    return start;
  };
  for (let i = 0; i < directoryCount; i++) fat.writeUInt32LE(i + 1 < directoryCount ? i + 2 : END, (i + 1) * 4);
  const small = streams.filter(([, bytes]) => bytes.length < 4096), miniFat = Buffer.alloc(512, 255), miniBlocks = [];
  const starts = new Map();
  for (const [name, bytes] of small) {
    starts.set(name, bytes.length ? miniBlocks.length : END);
    for (let at = 0; at < bytes.length; at += 64) {
      const block = Buffer.alloc(64); bytes.copy(block, 0, at, at + 64); miniBlocks.push(block);
      miniFat.writeUInt32LE(at + 64 < bytes.length ? miniBlocks.length : END, (miniBlocks.length - 1) * 4);
    }
  }
  const miniFatStart = miniBlocks.length ? append(miniFat) : END, miniData = Buffer.concat(miniBlocks), miniStart = append(miniData);
  for (const [name, bytes] of streams) if (bytes.length >= 4096) starts.set(name, append(bytes));
  const directory = Buffer.alloc(directoryCount * 512);
  function entry(index, name, kind, start, size, child = FREE, right = FREE) {
    const at = index * 128, rawName = Buffer.from(name + '\0', 'utf16le');
    rawName.copy(directory, at); directory.writeUInt16LE(rawName.length, at + 64); directory[at + 66] = kind; directory[at + 67] = 1;
    directory.writeUInt32LE(FREE, at + 68); directory.writeUInt32LE(right, at + 72); directory.writeUInt32LE(child, at + 76);
    directory.writeUInt32LE(start, at + 116); directory.writeUInt32LE(size, at + 120);
  }
  entry(0, 'Root Entry', 5, miniStart, miniData.length, streams.length ? 1 : FREE);
  streams.forEach(([name, bytes], i) => entry(i + 1, name, 2, starts.get(name), bytes.length, FREE, i + 1 < streams.length ? i + 2 : FREE));
  for (let i = 0; i < directoryCount; i++) directory.copy(sectors[i + 1], 0, i * 512, (i + 1) * 512);
  const header = Buffer.alloc(512); Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header);
  header.writeUInt16LE(0x3e, 24); header.writeUInt16LE(3, 26); header.writeUInt16LE(0xfffe, 28); header.writeUInt16LE(9, 30); header.writeUInt16LE(6, 32);
  header.writeUInt32LE(1, 44); header.writeUInt32LE(1, 48); header.writeUInt32LE(4096, 56); header.writeUInt32LE(miniFatStart, 60); header.writeUInt32LE(miniBlocks.length ? 1 : 0, 64); header.writeUInt32LE(END, 68);
  header.fill(255, 76); header.writeUInt32LE(0, 76);
  return Buffer.concat([header, ...sectors]);
}
function wordStreams({ mini = true, encrypted = false } = {}) {
  const bytes = Buffer.alloc(mini ? 1024 : 4096), table = Buffer.alloc(mini ? 64 : 4096);
  bytes.writeUInt16LE(0xa5ec); bytes.writeUInt16LE(0xc1, 2); bytes.writeUInt16LE(encrypted ? 0x0100 : 0, 10);
  bytes.writeUInt16LE(14, 32); bytes.writeUInt16LE(22, 62); bytes.writeUInt16LE(93, 152);
  for (const index of [1, 12, 13, 31, 32]) bytes.writeUInt32LE(2, 158 + index * 8);
  return [['WordDocument', bytes], ['0Table', table]];
}
function record(id, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(4); header.writeUInt16LE(id); header.writeUInt16LE(data.length, 2); return Buffer.concat([header, data]);
}
function workbook({ macro = false, sheetMacro = false, encrypted = false, vba = false } = {}) {
  const bof = (type) => { const data = Buffer.alloc(16); data.writeUInt16LE(0x0600); data.writeUInt16LE(type, 2); return record(0x0809, data); };
  const bound = Buffer.alloc(9); bound[5] = macro ? 1 : 0; bound[6] = 1; bound[8] = 65;
  const optional = encrypted ? record(0x002f, Buffer.alloc(2)) : vba ? record(0x00d3) : Buffer.alloc(0);
  bound.writeUInt32LE(20 + 13 + optional.length + 4);
  return Buffer.concat([bof(5), record(0x0085, bound), optional, record(0x000a), bof(sheetMacro ? 0x40 : 0x10), record(0x0200, Buffer.alloc(14)), record(0x000a)]);
}
function pngChunk(name, content) {
  const body = Buffer.concat([Buffer.from(name), content]), header = Buffer.alloc(4), crc = Buffer.alloc(4);
  header.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([header, body, crc]);
}
function png() {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 255]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function monochromePng(width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 1;
  // One bit grayscale, complete scanlines and filter bytes: a valid large image
  // can be tiny on disk without allocating a four-byte RGBA fixture in tests.
  const image = Buffer.alloc((Math.ceil(width / 8) + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(image)), pngChunk('IEND', Buffer.alloc(0))]);
}
function sizedGif(width, height) {
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  bytes.writeUInt16LE(width, 6); bytes.writeUInt16LE(height, 8); return bytes;
}
function sizedJpeg(width, height) {
  const bytes = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex');
  bytes.writeUInt16BE(height, 7); bytes.writeUInt16BE(width, 9); return bytes;
}
function webpChunk(kind, content) {
  const header = Buffer.alloc(8); header.write(kind); header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content, Buffer.alloc(content.length % 2)]);
}
function webpContainer(chunks) {
  const content = Buffer.concat(chunks), header = Buffer.from('RIFF\0\0\0\0WEBP'); header.writeUInt32LE(content.length + 4, 4);
  return Buffer.concat([header, content]);
}
function sizedWebp(width, height, { lossy = false, extended = false } = {}) {
  let frame;
  if (lossy) {
    const data = Buffer.alloc(10); Buffer.from([0x9d, 1, 0x2a]).copy(data, 3); data.writeUInt16LE(width, 6); data.writeUInt16LE(height, 8);
    frame = webpChunk('VP8 ', data);
  } else {
    const data = Buffer.alloc(5); data[0] = 0x2f; data.writeUInt32LE((((height - 1) << 14) | (width - 1)) >>> 0, 1);
    frame = webpChunk('VP8L', data);
  }
  if (!extended) return webpContainer([frame]);
  const canvas = Buffer.alloc(10); canvas.writeUIntLE(width - 1, 4, 3); canvas.writeUIntLE(height - 1, 7, 3);
  return webpContainer([webpChunk('VP8X', canvas), frame]);
}
function rejected(bytes, name) {
  assert.throws(() => detectAttachmentType(bytes, name), (error) => error instanceof HttpError && error.status === 400 && /[\u4e00-\u9fff]/.test(error.message));
}

test('attachment detection supports structural raster images and PDF, with extension agreement', () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const webp = Buffer.from('5249464612000000574542505650384c050000002f0000000000', 'hex');
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex');
  for (const [bytes, name, type, ext] of [[png(), 'a.PNG', 'image/png', '.png'], [gif, 'a.gif', 'image/gif', '.gif'], [webp, 'a.webp', 'image/webp', '.webp'], [jpeg, 'a.JPEG', 'image/jpeg', '.jpg'], [Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'), 'a.pdf', 'application/pdf', '.pdf']]) {
    assert.deepEqual(detectAttachmentType(bytes, name), { type, ext, inline: true });
    rejected(bytes, name.endsWith('.pdf') ? 'wrong.png' : 'wrong.pdf');
  }
});

test('plain HTML, SVG, truncated signatures and unsupported extensions cannot masquerade as attachments', () => {
  for (const name of ['a.doc', 'a.xls', 'a.docx', 'a.xlsx', 'a.png', 'a.pdf']) rejected(Buffer.from('<html><body>report</body></html>'), name);
  for (const [bytes, name] of [[Buffer.from('<svg onload="alert(1)"/>'), 'a.svg'], [png().subarray(0, 33), 'a.png'], [Buffer.from('%PDF-1.7\n'), 'a.pdf'], [Buffer.from([0xff, 0xd8, 0xff]), 'a.jpg'], [png(), 'a.html'], [png(), 'a.png\0.html']]) rejected(bytes, name);
});

test('compressed large PNGs are bounded by both dimensions and decoded pixel count', () => {
  const large = monochromePng(12000, 12000);
  assert.ok(large.length < 100000);
  assert.throws(() => detectAttachmentType(large, 'large.png'), /请缩小图片后上传/);
  assert.equal(detectAttachmentType(monochromePng(10000, 2400), 'limit.png').type, 'image/png');
  for (const [width, height] of [[10001, 1], [1, 10001], [6001, 4000]]) assert.throws(() => detectAttachmentType(monochromePng(width, height), 'large.png'), /请缩小图片后上传/);
});

test('GIF, JPEG and every WebP frame header share the 10000-side and 24MP budget', () => {
  const formats = [[sizedGif, '.gif'], [sizedJpeg, '.jpg'], [sizedWebp, '.webp'], [(w, h) => sizedWebp(w, h, { lossy: true }), '.webp'], [(w, h) => sizedWebp(w, h, { extended: true }), '.webp']];
  for (const [make, ext] of formats) {
    assert.equal(detectAttachmentType(make(10000, 2400), 'limit' + ext).inline, true);
    for (const [width, height] of [[10001, 1], [1, 10001], [6001, 4000]]) assert.throws(() => detectAttachmentType(make(width, height), 'large' + ext), /请缩小图片后上传/);
  }
  const oversizedFrame = sizedWebp(10001, 1, { extended: true }); oversizedFrame.writeUIntLE(0, 24, 3);
  assert.throws(() => detectAttachmentType(oversizedFrame, 'frame.webp'), /请缩小图片后上传/);
  const oversizedCanvas = sizedWebp(1, 1, { extended: true }); oversizedCanvas.writeUIntLE(10000, 24, 3);
  assert.throws(() => detectAttachmentType(oversizedCanvas, 'canvas.webp'), /请缩小图片后上传/);
});

test('APNG, multi-frame GIF and animated WebP cannot bypass the static image budget', () => {
  for (const name of ['acTL', 'fcTL', 'fdAT']) {
    const still = png(), animated = Buffer.concat([still.subarray(0, 33), pngChunk(name, Buffer.alloc(name === 'acTL' ? 8 : 26)), still.subarray(33)]);
    assert.throws(() => detectAttachmentType(animated, 'animated.png'), /暂不支持动态图/);
  }
  const gif = sizedGif(1, 1), frameAt = gif.indexOf(0x2c, 13), animatedGif = Buffer.concat([gif.subarray(0, -1), gif.subarray(frameAt)]);
  assert.throws(() => detectAttachmentType(animatedGif, 'animated.gif'), /暂不支持动态图/);
  const animationFlag = sizedWebp(1, 1, { extended: true }); animationFlag[20] |= 2;
  assert.throws(() => detectAttachmentType(animationFlag, 'animated.webp'), /暂不支持动态图/);
  for (const kind of ['ANIM', 'ANMF']) {
    const animated = webpContainer([webpChunk(kind, Buffer.alloc(16)), sizedWebp(1, 1).subarray(12)]);
    assert.throws(() => detectAttachmentType(animated, 'animated.webp'), /暂不支持动态图/);
  }
});

test('image dimensions are read from valid frame structures rather than metadata-like byte strings', () => {
  const gif = sizedGif(1, 1); gif.writeUInt16LE(0, 6); rejected(gif, 'bad.gif');
  const malformedGif = sizedGif(1, 1); malformedGif[malformedGif.indexOf(0x2c, 13) + 9] = 0x80; rejected(malformedGif, 'bad.gif');
  const duplicateIhdr = Buffer.concat([png().subarray(0, 33), png().subarray(8)]); rejected(duplicateIhdr, 'bad.png');
  const mismatchedWebp = sizedWebp(1, 1, { extended: true }); mismatchedWebp.writeUIntLE(1, 24, 3); rejected(mismatchedWebp, 'bad.webp');
  const malformedWebp = sizedWebp(1, 1, { lossy: true }); malformedWebp[23] = 0; rejected(malformedWebp, 'bad.webp');
});

test('single attachment has an exact 8MiB maximum', () => {
  assert.equal(MAX_ATTACHMENT_BYTES, 8 * 1024 * 1024);
  rejected(Buffer.alloc(MAX_ATTACHMENT_BYTES + 1), 'a.doc');
  rejected(Buffer.alloc(0), 'a.doc');
});

test('ordinary stored and compressed OOXML is identified and is always download only', () => {
  for (const [kind, suffix, type] of [['word', '.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], ['excel', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']]) {
    for (const deflate of [false, true]) assert.deepEqual(detectAttachmentType(zip(ooxml(kind), { deflate }), 'report' + suffix), { type, ext: suffix, inline: false });
    const unicode = ooxml(kind).map(([name, text]) => [name, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])]);
    assert.equal(detectAttachmentType(zip(unicode), 'unicode' + suffix).type, type);
    rejected(zip(ooxml(kind)), kind === 'word' ? 'wrong.xlsx' : 'wrong.docx');
  }
});

test('OOXML verifies package relation, content type and main XML root', () => {
  const cases = [ooxml().slice(1), [['empty.txt', 'hello']], ooxml().map(([name, text]) => [name, text.replace('wordprocessingml.document.main+xml', 'text/html')]), ooxml().map(([name, text]) => [name, name === 'word/document.xml' ? '<html></html>' : text]), ooxml().map(([name, text]) => [name, text.replace('Target="word/document.xml"', 'Target="https://example.invalid/a" TargetMode="External"')])];
  for (const items of cases) rejected(zip(items), 'a.docx');
});

test('OOXML refuses VBA paths, macro-enabled types and Excel4 macro-sheet relationships', () => {
  const cases = [ooxml('word', [['word/vbaProject.bin', 'payload']]), ooxml('word', [['word/%76baProject.bin', 'payload']]), ooxml('word', [['word/Macros/a.xml', '<x/>']]), ooxml().map(([name, text]) => [name, text.replace('wordprocessingml.document.main+xml', 'wordprocessingml.document.macroEnabled.main+xml')]), ooxml('excel', [['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet" Target="s.xml"/></Relationships>']]), ooxml('excel', [['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/xlM&#x61;crosheet" Target="s.xml"/></Relationships>']]), ooxml('excel', [['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Type="http://schemas.microsoft.com/office/2006/relationships/%76baProject" Target="s.bin"/></Relationships>']])];
  for (const items of cases) rejected(zip(items), items.some(([name]) => name.startsWith('xl/')) ? 'a.xlsx' : 'a.docx');
});

test('OOXML rejects duplicate paths, traversal, local-directory mismatches and corrupt CRC', () => {
  for (const items of [ooxml('word', [['word/document.xml', '<x/>']]), ooxml('word', [['WORD/DOCUMENT.XML', '<x/>']]), ooxml('word', [['../outside.xml', '<x/>']]), ooxml('word', [['word\\vbaProject.bin', 'x']])]) rejected(zip(items), 'a.docx');
  const mismatched = zip(ooxml()); mismatched[30] ^= 1; rejected(mismatched, 'a.docx');
  const corrupt = zip(ooxml()); corrupt[50] ^= 1; rejected(corrupt, 'a.docx');
  const overlap = zip(ooxml()); const firstCentral = overlap.readUInt32LE(overlap.length - 6); overlap.writeUInt32LE(0, firstCentral + 46 + Buffer.byteLength('[Content_Types].xml') + 42); rejected(overlap, 'a.docx');
});

test('OOXML enforces bounded decompression, entry count and aggregate declared size', () => {
  rejected(zip(ooxml(), { deflate: true, declaredSize: 8 }), 'a.docx');
  const singleLarge = zip([['[Content_Types].xml', Buffer.alloc(16 * 1024 * 1024 + 1)]], { deflate: true });
  assert.throws(() => detectAttachmentType(singleLarge, 'a.docx'), /附件展开后过大/);
  const expanded = Buffer.alloc(13 * 1024 * 1024), totalLarge = zip([['a', expanded], ['b', expanded]], { deflate: true });
  assert.throws(() => detectAttachmentType(totalLarge, 'a.docx'), /附件展开后过大/);
  const bomb = zip(ooxml('word', [['word/large.xml', Buffer.alloc(1024 * 1024)]]), { deflate: true, declaredSize: 8 }); rejected(bomb, 'a.docx');
  const tooMany = zip(Array.from({ length: 2049 }, (_, i) => ['part' + i, ''])); rejected(tooMany, 'a.docx');
});

test('OOXML does not expand XML entities or accept unknown embedded binary objects', () => {
  const entities = ooxml().map(([name, text]) => [name, name === '[Content_Types].xml' ? '<!DOCTYPE Types [<!ENTITY a "x">]>' + text : text]);
  rejected(zip(entities), 'a.docx');
  rejected(zip(ooxml('word', [['word/embeddings/unknown.bin', 'not inspectable']])), 'a.docx');
  rejected(zip(ooxml('word', [['word/embeddings/object.bin', cfb([...wordStreams(), ['Macros', Buffer.from('macro')]])]])), 'a.docx');
});

test('normal and mini CFB streams support Word97-2003 and BIFF8 as download only', () => {
  for (const mini of [true, false]) assert.deepEqual(detectAttachmentType(cfb(wordStreams({ mini })), 'report.doc'), { type: 'application/msword', ext: '.doc', inline: false });
  assert.deepEqual(detectAttachmentType(cfb([['Workbook', workbook()]]), 'report.xls'), { type: 'application/vnd.ms-excel', ext: '.xls', inline: false });
  const padded = Buffer.alloc(4096); workbook().copy(padded);
  assert.equal(detectAttachmentType(cfb([['Workbook', padded]]), 'report.xls').inline, false);
  rejected(cfb(wordStreams()), 'wrong.xls'); rejected(cfb([['Workbook', workbook()]]), 'wrong.doc');
});

test('CFB validates full container, directory ownership and FAT chains', () => {
  rejected(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'a.doc');
  rejected(cfb([['unrelated', Buffer.from('fake')]]), 'a.doc');
  const loop = cfb(wordStreams()); loop.writeUInt32LE(1, 512 + 4); rejected(loop, 'a.doc');
  const orphan = cfb(wordStreams()); orphan.writeUInt32LE(FREE, 1024 + 76); rejected(orphan, 'a.doc');
  const duplicate = cfb([['WordDocument', wordStreams()[0][1]], ['worddocument', wordStreams()[0][1]], ['0Table', Buffer.alloc(64)]]); rejected(duplicate, 'a.doc');
  const miniLoop = cfb(wordStreams()); const miniFatAt = (miniLoop.readUInt32LE(60) + 1) * 512; miniLoop.writeUInt32LE(0, miniFatAt); rejected(miniLoop, 'a.doc');
  const badShift = cfb(wordStreams()); badShift.writeUInt16LE(12, 30); rejected(badShift, 'a.doc');
});

test('CFB refuses macro directories, embedded package streams and encryption containers', () => {
  for (const name of ['Macros', 'VBA', '_VBA_PROJECT_CUR', 'PROJECT', 'PROJECTwm', 'EncryptedPackage', 'EncryptionInfo', '\u0001Ole10Native', 'Package']) rejected(cfb([...wordStreams(), [name, Buffer.from('payload')]]), 'a.doc');
  rejected(cfb(wordStreams({ encrypted: true })), 'a.doc');
});

test('Word checks FIB counts and mandatory table pointers, refusing legacy or malformed files', () => {
  for (const mutate of [(b) => b.writeUInt16LE(0x65, 2), (b) => b.writeUInt16LE(13, 32), (b) => b.writeUInt16LE(92, 152), (b) => b.writeUInt32LE(1000, 154 + 8), (b) => b.writeUInt32LE(0, 158 + 8)]) {
    const streams = wordStreams(); mutate(streams[0][1]); rejected(cfb(streams), 'a.doc');
  }
  rejected(cfb([wordStreams()[0]]), 'a.doc');
  const recent = wordStreams({ mini: false });
  recent[0][1].writeUInt16LE(183, 152); recent[0][1].writeUInt16LE(5, 154 + 183 * 8); recent[0][1].writeUInt16LE(0x112, 156 + 183 * 8);
  assert.equal(detectAttachmentType(cfb(recent), 'recent.doc').type, 'application/msword');
});

test('BIFF8 refuses VBA, Excel4 macro sheets, encrypted or truncated streams', () => {
  for (const flags of [{ macro: true }, { sheetMacro: true }, { encrypted: true }, { vba: true }]) rejected(cfb([['Workbook', workbook(flags)]]), 'a.xls');
  rejected(cfb([['Workbook', workbook().subarray(0, -1)]]), 'a.xls');
  const legacy = workbook(); legacy.writeUInt16LE(0x0500, 4); rejected(cfb([['Book', legacy]]), 'a.xls');
  const badSheet = workbook(); badSheet.writeUInt32LE(999999, 24); rejected(cfb([['Workbook', badSheet]]), 'a.xls');
});

test('ordinary document text mentioning macros is not mistaken for an executable macro part', () => {
  const items = ooxml().map(([name, text]) => [name, name === 'word/document.xml' ? text.replace('</document>', '<p>VBA macroEnabled 会议纪要</p></document>') : text]);
  assert.equal(detectAttachmentType(zip(items), 'a.docx').inline, false);
});
