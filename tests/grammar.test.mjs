import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/* grammar.js is a LuCI client module (function body with a top-level return),
   so it cannot be imported directly — evaluate it with LuCI globals stubbed. */
globalThis._ = (s) => s;
if (!String.prototype.format)
	String.prototype.format = function (...args) {
		let i = 0;
		return this.replace(/%[sd]/g, () => String(args[i++]));
	};

const src = readFileSync(
	new URL('../htdocs/luci-static/resources/view/routelists/grammar.js', import.meta.url),
	'utf8'
);
const grammar = new Function('baseclass', src)({ extend: (obj) => obj });

function validate(text, mode = 'auto') {
	return grammar.validate(text, mode);
}

function codes(text, mode = 'auto') {
	return validate(text, mode).problems.map((p) => p.code);
}

test('empty file: no entries, no problems', () => {
	assert.deepEqual(validate(''), { entries: 0, problems: [] });
});

test('blank lines are allowed and are not entries', () => {
	assert.deepEqual(validate('\n\n  \n'), { entries: 0, problems: [] });
});

test('valid mixed list in auto mode', () => {
	const r = validate('example.com\n1.2.3.4\n1.2.3.0/24\n2a00:1450::1\n2a00::/32\n');
	assert.equal(r.entries, 5);
	assert.deepEqual(r.problems, []);
});

test('whitespace around entries is tolerated', () => {
	assert.deepEqual(validate('  example.com  '), { entries: 1, problems: [] });
});

test('CRLF input validates cleanly with correct line numbers', () => {
	const r = validate('example.com\r\nfoo bar\r\n1.2.3.4\r\n');
	assert.equal(r.entries, 2);
	assert.equal(r.problems.length, 1);
	assert.equal(r.problems[0].line, 2);
	assert.equal(r.problems[0].code, 'garbage');
});

test('domains: case, hyphens, punycode labels', () => {
	assert.deepEqual(codes('EXAMPLE.COM'), []);
	assert.deepEqual(codes('foo-bar.example.com'), []);
	assert.deepEqual(codes('xn--e1afmkfd.xn--p1ai'), []);
	assert.deepEqual(codes('-foo.com'), ['garbage']);
	assert.deepEqual(codes('foo-.com'), ['garbage']);
});

test('single-label names and trailing dots are rejected', () => {
	assert.deepEqual(codes('localhost'), ['garbage']);
	assert.deepEqual(codes('example.com.'), ['garbage']);
});

test('almost-IPv4 garbage is an error, not a "domain"', () => {
	assert.deepEqual(codes('256.1.1.1'), ['garbage']);
	assert.deepEqual(codes('1.2.3'), ['garbage']);
});

test('IPv4 CIDR bounds', () => {
	assert.deepEqual(codes('1.2.3.0/24'), []);
	assert.deepEqual(codes('0.0.0.0/0'), []);
	assert.deepEqual(codes('1.2.3.4/33'), ['garbage']);
});

test('IPv6 forms', () => {
	assert.deepEqual(codes('::'), []);
	assert.deepEqual(codes('::1'), []);
	assert.deepEqual(codes('1:2:3:4:5:6:7:8'), []);
	assert.deepEqual(codes('::ffff:192.0.2.1'), []);
	assert.deepEqual(codes(':::1'), ['garbage']);
	assert.deepEqual(codes('2a00:1450::8b::1'), ['garbage']);
	assert.deepEqual(codes('1:2:3:4:5:6:7:8:9'), ['garbage']);
	assert.deepEqual(codes('fe80::1%eth0'), ['garbage']);
});

test('IPv6 CIDR bounds', () => {
	assert.deepEqual(codes('::/0'), []);
	assert.deepEqual(codes('2a00::/32'), []);
	assert.deepEqual(codes('::ffff:192.0.2.1/96'), []);
	assert.deepEqual(codes('2a00::/129'), ['garbage']);
});

test('domain length limits', () => {
	const label = 'a'.repeat(63);

	assert.deepEqual(codes(label + '.com'), []);
	assert.deepEqual(codes('a'.repeat(64) + '.com'), ['garbage']);

	/* 4 × 63-char labels + ".com" is 259 characters — over the 253 limit */
	assert.deepEqual(codes([label, label, label, label, 'com'].join('.')), ['garbage']);
});

test('full-line comment is a warning, not an entry', () => {
	const r = validate('# my sites');
	assert.equal(r.entries, 0);
	assert.equal(r.problems.length, 1);
	assert.equal(r.problems[0].code, 'comment');
	assert.equal(r.problems[0].severity, 'warning');
});

test('inline comment is a warning, not an entry', () => {
	const r = validate('example.com # note');
	assert.equal(r.entries, 0);
	assert.equal(r.problems.length, 1);
	assert.equal(r.problems[0].code, 'inline-comment');
	assert.equal(r.problems[0].severity, 'warning');
});

test('inline comment after an IP entry is a warning, not a hosts-style error', () => {
	assert.deepEqual(codes('1.2.3.4 # note'), ['inline-comment']);
	assert.deepEqual(codes('2a00::1 # note'), ['inline-comment']);
	assert.deepEqual(codes('1.2.3.0/24 # note'), ['inline-comment']);
});

test('full:/keyword:/regexp: prefixes are errors', () => {
	for (const line of ['regexp:^a$', 'full:example.com', 'keyword:ads', 'FULL:example.com']) {
		const r = validate(line);
		assert.equal(r.entries, 0, line);
		assert.equal(r.problems.length, 1, line);
		assert.equal(r.problems[0].code, 'prefix', line);
		assert.equal(r.problems[0].severity, 'error', line);
	}
});

test('hosts-style lines are errors', () => {
	assert.deepEqual(codes('0.0.0.0 example.com'), ['hosts']);
	assert.deepEqual(codes('127.0.0.1 localhost'), ['hosts']);
	assert.deepEqual(codes('0.0.0.0\texample.com'), ['hosts']);
});

test('adblock syntax is an error', () => {
	assert.deepEqual(codes('||ads.example^'), ['adblock']);
	assert.deepEqual(codes('@@allowed.example'), ['adblock']);
	assert.deepEqual(codes('example.com##.ad'), ['adblock']);
	assert.deepEqual(codes('ads.example^'), ['adblock']);
	assert.deepEqual(codes('##.ads'), ['adblock']);
});

test('a "##" comment with text stays a comment warning', () => {
	assert.deepEqual(codes('## my sites'), ['comment']);
});

test('other garbage is an error', () => {
	assert.deepEqual(codes('foo bar'), ['garbage']);
	assert.deepEqual(codes('*.example.com'), ['garbage']);
	assert.deepEqual(codes('example.com/path'), ['garbage']);
});

test('domain-only mode rejects IP entries', () => {
	const r = validate('example.com\n1.2.3.4\n2a00::/32', 'domain');
	assert.equal(r.entries, 1);
	assert.deepEqual(r.problems.map((p) => [p.line, p.code, p.severity]), [
		[2, 'mode', 'error'],
		[3, 'mode', 'error']
	]);
});

test('ip-only mode rejects domain entries', () => {
	const r = validate('example.com\n1.2.3.4', 'ip');
	assert.equal(r.entries, 1);
	assert.deepEqual(r.problems.map((p) => [p.line, p.code]), [[1, 'mode']]);
});

test('ip-only mode: the mode error wins over the IDN warning', () => {
	const r = validate('домен.рф', 'ip');
	assert.equal(r.entries, 0);
	assert.deepEqual(r.problems.map((p) => [p.line, p.code]), [[1, 'mode']]);
});

test('IDN domain: warning with punycode suggestion, still an entry', () => {
	const r = validate('домен.рф');
	assert.equal(r.entries, 1);
	assert.equal(r.problems.length, 1);
	assert.equal(r.problems[0].code, 'idn');
	assert.equal(r.problems[0].severity, 'warning');
	assert.ok(r.problems[0].message.includes('xn--d1acufc.xn--p1ai'));
});

test('duplicates: warning, case-insensitive for domains', () => {
	const r = validate('example.com\nEXAMPLE.com\n1.2.3.4\n1.2.3.4\nexample.org');
	assert.equal(r.entries, 5);
	assert.deepEqual(r.problems.map((p) => [p.line, p.code, p.severity]), [
		[2, 'duplicate', 'warning'],
		[4, 'duplicate', 'warning']
	]);
	assert.ok(r.problems[0].message.includes('1'));
});

test('problems carry 1-based line numbers', () => {
	const r = validate('example.com\nfoo bar\n# c\n1.2.3.4/33');
	assert.deepEqual(r.problems.map((p) => p.line), [2, 3, 4]);
});

test('normalize: trims lines and converts CRLF to LF', () => {
	assert.equal(grammar.normalize('  a.com \r\nb.com\r\n'), 'a.com\nb.com\n');
	assert.equal(grammar.normalize('a.com\rb.com'), 'a.com\nb.com');
});

test('deduplicate: removes later duplicate entries, keeps everything else as-is', () => {
	const text = 'example.com\n# keep\nEXAMPLE.com\n1.2.3.4\nfoo bar\n1.2.3.4\nexample.org';
	assert.equal(
		grammar.deduplicate(text),
		'example.com\n# keep\n1.2.3.4\nfoo bar\nexample.org'
	);
});

test('deduplicate: text without duplicates is returned unchanged', () => {
	const text = 'a.com\nb.com\n\n# c\n';
	assert.equal(grammar.deduplicate(text), text);
});

test('performance: 10k lines validate in under 1 second', () => {
	const chunk = ['example%d.com', '10.0.%d.1', '2a00::%d', 'bad line %d', '# c %d'];
	const lines = [];
	for (let i = 0; i < 2000; i++)
		for (const t of chunk) lines.push(t.replace('%d', String(i)));
	const started = process.hrtime.bigint();
	validate(lines.join('\n'));
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	assert.ok(ms < 1000, `took ${ms} ms`);
});
