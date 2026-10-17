import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { xlsx } from './xlsx';

/** Read back every file in a zip made by zip() (local headers only). */
function unzip(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; buf.readUInt32LE(at) === 0x04034b50;) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen;
    out[name] = inflateRawSync(buf.subarray(start, start + size)).toString('utf8');
    at = start + size;
  }
  return out;
}

describe('xlsx', () => {
  it('writes a workbook with a header row and escaped cells', () => {
    const files = unzip(xlsx('LinkedIn jobs', ['Title', 'Company'], [['AI Lead <Dubai>', 'Acme & Co']]));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/styles.xml']),
    );
    const sheet = files['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(sheet).toContain('AI Lead &lt;Dubai&gt;');
    expect(sheet).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">Acme &amp; Co</t>');
    expect(files['xl/workbook.xml']).toContain('name="LinkedIn jobs"');
  });
});
