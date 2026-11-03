import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpload, storagePath, imageType } from '../server/files.mjs';

test('file paths reject traversal, ambiguous separators and active content', () => {
  for (const name of ['../x', 'drawings/../x.png', 'drawings/p/../../x.png', 'drawings/p/x\\q.png', '/drawings/p/x.png']) assert.throws(() => storagePath(name));
  assert.equal(storagePath('drawings/demo-res/test.png').projectId, 'demo-res');
  assert.throws(() => imageType(Buffer.from('<svg onload=alert(1)>')));
  assert.equal(imageType(Buffer.from([137,80,78,71,13,10,26,10])).type, 'image/png');
});

test('multipart parsing preserves binary bytes and enforces the two-field upload contract', () => {
  const boundary = 'testing-boundary';
  const bytes = Buffer.from([137,80,78,71,13,10,26,10,0,1,2,255]);
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="path"\r\n\r\ndrawings/demo-res/a.png\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="../../ignored.png"\r\nContent-Type: image/png\r\n\r\n'),
    bytes, Buffer.from('\r\n--' + boundary + '--\r\n')
  ]);
  const parsed = parseUpload(body, 'multipart/form-data; boundary=' + boundary);
  assert.equal(parsed.path, 'drawings/demo-res/a.png'); assert.deepEqual(parsed.file, bytes);
  assert.throws(() => parseUpload(body.subarray(0, body.length - 20), 'multipart/form-data; boundary=' + boundary));
});
