import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseXmltv, parseXmltvDate, formatXmltvDate, writeXmltv } from '../src/core/xmltv.js';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
  <channel id="BBCNews.uk">
    <display-name lang="en">BBC News</display-name>
    <display-name>BBC News HD</display-name>
    <icon src="https://example.com/bbc.png" />
  </channel>
  <channel id="TRT1.tr">
    <display-name lang="tr">TRT 1</display-name>
  </channel>
  <programme start="20240115143000 +0300" stop="20240115153000 +0300" channel="TRT1.tr">
    <title lang="tr">Haber Bülteni</title>
    <sub-title lang="tr">Ana Haber</sub-title>
    <desc lang="tr">Günün özeti.</desc>
    <category lang="tr">Haber</category>
    <category lang="tr">Güncel</category>
    <episode-num system="xmltv_ns">2.14.</episode-num>
    <rating><value>TV-G</value></rating>
  </programme>
  <programme start="20240115120000 +0000" channel="BBCNews.uk">
    <title>World News</title>
  </programme>
</tv>`;

describe('parseXmltvDate', () => {
  it('converts offsets to UTC', () => {
    assert.equal(parseXmltvDate('20240115143000 +0300'), '2024-01-15T11:30:00.000Z');
    assert.equal(parseXmltvDate('20240115143000 -0500'), '2024-01-15T19:30:00.000Z');
  });

  it('defaults to UTC when no offset is given', () => {
    assert.equal(parseXmltvDate('20240115143000'), '2024-01-15T14:30:00.000Z');
  });

  it('accepts date-only values', () => {
    assert.equal(parseXmltvDate('20240115'), '2024-01-15T00:00:00.000Z');
  });

  it('returns null for junk', () => {
    assert.equal(parseXmltvDate('not-a-date'), null);
    assert.equal(parseXmltvDate(null), null);
  });
});

describe('formatXmltvDate', () => {
  it('round-trips through the parser', () => {
    const iso = '2024-01-15T11:30:00.000Z';
    assert.equal(formatXmltvDate(iso), '20240115113000 +0000');
    assert.equal(parseXmltvDate(formatXmltvDate(iso)), iso);
  });
});

describe('parseXmltv', () => {
  const parsed = parseXmltv(SAMPLE, 'test-site');

  it('reads channels with all display names', () => {
    assert.equal(parsed.channels.length, 2);
    const bbc = parsed.channels.find((channel) => channel.id === 'BBCNews.uk')!;
    assert.deepEqual(bbc.display_names, ['BBC News', 'BBC News HD']);
    assert.equal(bbc.icon, 'https://example.com/bbc.png');
    assert.equal(bbc.site, 'test-site');
  });

  it('reads programmes and normalises times', () => {
    assert.equal(parsed.programmes.length, 2);
    const trt = parsed.programmes.find((programme) => programme.channel === 'TRT1.tr')!;
    assert.equal(trt.title, 'Haber Bülteni');
    assert.equal(trt.sub_title, 'Ana Haber');
    assert.equal(trt.start, '2024-01-15T11:30:00.000Z');
    assert.deepEqual(trt.categories, ['Haber', 'Güncel']);
    assert.equal(trt.rating, 'TV-G');
  });

  it('parses xmltv_ns episode numbering as 1-based', () => {
    const trt = parsed.programmes.find((programme) => programme.channel === 'TRT1.tr')!;
    assert.equal(trt.season, 3);
    assert.equal(trt.episode_num, 15);
  });

  it('falls back to start when stop is missing', () => {
    const bbc = parsed.programmes.find((programme) => programme.channel === 'BBCNews.uk')!;
    assert.equal(bbc.stop, bbc.start);
  });

  it('does not throw on malformed input', () => {
    assert.doesNotThrow(() => parseXmltv('<tv><channel/></tv>'));
    assert.deepEqual(parseXmltv('<tv></tv>').programmes, []);
  });
});

describe('writeXmltv', () => {
  it('round-trips channels and programmes', () => {
    const parsed = parseXmltv(SAMPLE, 'test');
    const xml = writeXmltv(parsed.channels, parsed.programmes);
    const reparsed = parseXmltv(xml, 'test');

    assert.equal(reparsed.channels.length, parsed.channels.length);
    assert.equal(reparsed.programmes.length, parsed.programmes.length);
    assert.equal(
      reparsed.programmes.find((programme) => programme.channel === 'TRT1.tr')?.title,
      'Haber Bülteni',
    );
  });

  it('escapes XML-special characters', () => {
    const xml = writeXmltv(
      [{ id: 'x', display_names: ['A & B <c>'], icon: null, site: 't', lang: null }],
      [],
    );
    assert.ok(xml.includes('A &amp; B &lt;c&gt;'));
    assert.doesNotThrow(() => parseXmltv(xml));
  });
});

describe('parseXmltv entity limits', () => {
  it('parses a large guide full of predefined entities', () => {
    // Regression: fast-xml-parser capped *all* entity replacements at 1000 per
    // document, so every large real-world guide failed to parse.
    const programmes = Array.from(
      { length: 3000 },
      (_, i) =>
        `<programme start="20240101${String(i % 24).padStart(2, '0')}0000 +0000" channel="a">` +
        `<title>Tom &amp; Jerry &lt;${i}&gt;</title><desc>Cats &amp; mice &quot;live&quot;</desc></programme>`,
    ).join('');
    const xml = `<?xml version="1.0"?><tv><channel id="a"><display-name>A &amp; B</display-name></channel>${programmes}</tv>`;

    const parsed = parseXmltv(xml);
    assert.equal(parsed.programmes.length, 3000);
    assert.equal(parsed.programmes[0]!.title, 'Tom & Jerry <0>');
    assert.equal(parsed.programmes[0]!.description, 'Cats & mice "live"');
    assert.equal(parsed.channels[0]!.display_names[0], 'A & B');
  });

  it('still refuses a billion-laughs style declared-entity bomb', () => {
    const entities = ['<!ENTITY a "lollollollollollollollollollol">'];
    for (let i = 1; i < 10; i++) {
      const prev = String.fromCharCode(96 + i);
      const next = String.fromCharCode(97 + i);
      entities.push(`<!ENTITY ${next} "${`&${prev};`.repeat(10)}">`);
    }
    const bomb = `<?xml version="1.0"?><!DOCTYPE tv [${entities.join('')}]><tv><channel id="x"><display-name>&j;</display-name></channel></tv>`;

    let expandedLength = 0;
    try {
      const parsed = parseXmltv(bomb);
      expandedLength = parsed.channels[0]?.display_names[0]?.length ?? 0;
    } catch {
      return; // refused outright — the desired outcome
    }
    // If it parsed at all, the expansion must have been capped, not 30 GB.
    assert.ok(expandedLength <= 100_000, `expanded to ${expandedLength} chars`);
  });
});
