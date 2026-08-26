'use strict';
'require baseclass';

/* Line format contract: ZeroBlock full manual v0.8.4-r248, section 11.1.
   Valid entries: domain, IPv4, IPv6, CIDR — one per line (plain mixed TXT).
   Full-line "#" comments are ignored by ZeroBlock (verified in practice on
   v0.8.4, not documented). Everything else is rejected here because
   ZeroBlock's own autodetect is binary (IP-ish or domain) and silently
   swallows garbage as a "domain". */

const RE_LABEL = /^(xn--[a-z0-9-]{1,59}|[a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/i;
const RE_TLD = /^(xn--[a-z0-9-]+|[a-z]{2,})$/i;
const RE_IDN_LABEL = /^[\p{L}\p{N}]([\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
const RE_NONASCII = /[^\x00-\x7f]/;

function isIPv4(s) {
	const parts = s.split('.');

	if (parts.length != 4)
		return false;

	return parts.every((p) => /^\d{1,3}$/.test(p) && +p <= 255);
}

function isIPv6(s) {
	if (s.indexOf(':') < 0)
		return false;

	/* Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) counts as two hex groups */
	if (s.indexOf('.') >= 0) {
		const i = s.lastIndexOf(':');

		if (!isIPv4(s.slice(i + 1)))
			return false;

		s = s.slice(0, i + 1) + '0:0';
	}

	const isGroup = (g) => /^[0-9a-f]{1,4}$/i.test(g);
	const dbl = s.split('::');

	if (dbl.length > 2)
		return false;

	if (dbl.length == 2) {
		const left = dbl[0] ? dbl[0].split(':') : [];
		const right = dbl[1] ? dbl[1].split(':') : [];

		return left.concat(right).every(isGroup) && (left.length + right.length) <= 7;
	}

	const groups = s.split(':');

	return groups.length == 8 && groups.every(isGroup);
}

function isCidr(s) {
	const parts = s.split('/');

	if (parts.length != 2 || !/^\d{1,3}$/.test(parts[1]))
		return false;

	if (isIPv4(parts[0]))
		return +parts[1] <= 32;

	if (isIPv6(parts[0]))
		return +parts[1] <= 128;

	return false;
}

function isDomain(s) {
	if (s.length > 253)
		return false;

	const labels = s.split('.');

	if (labels.length < 2 || !RE_TLD.test(labels[labels.length - 1]))
		return false;

	return labels.every((l) => l.length <= 63 && RE_LABEL.test(l));
}

function isIdnDomain(s) {
	if (!RE_NONASCII.test(s))
		return false;

	const labels = s.split('.');

	if (labels.length < 2 || !/\p{L}/u.test(labels[labels.length - 1]))
		return false;

	return labels.every((l) => RE_IDN_LABEL.test(l));
}

function toPunycode(s) {
	try {
		return new URL('http://' + s).hostname;
	}
	catch (e) {
		return null;
	}
}

/* Ordered predicate table for a single trimmed, non-empty line.
   First matching row wins; rows are checked before entry parsing. */
const LINE_CHECKS = [
	{
		code: 'prefix',
		severity: 'error',
		test: (s) => /^(full|keyword|regexp):/i.test(s),
		message: () => _('prefixes are not supported in list files (ZeroBlock contract, manual 11.1) — they only work when entered manually in a section')
	},
	{
		code: 'adblock',
		severity: 'error',
		test: (s) => /^\|\||^@@|##|\^$/.test(s),
		message: () => _('adblock syntax is explicitly excluded by the ZeroBlock file contract (manual 11.1)')
	},
	{
		code: 'hosts',
		severity: 'error',
		test: (s) => {
			const t = s.split(/\s+/);

			/* an IP followed by a comment is an inline comment, not a host map */
			return t.length > 1 && t[1].charAt(0) != '#' &&
				(isIPv4(t[0]) || isIPv6(t[0]) || isCidr(t[0]));
		},
		message: () => _('hosts-style format is explicitly excluded by the ZeroBlock file contract (manual 11.1)')
	},
	{
		code: 'inline-comment',
		severity: 'warning',
		test: (s) => s.indexOf('#') > 0,
		message: () => _('inline comments are not documented by ZeroBlock — the whole line may be interpreted as a domain')
	}
];

const GARBAGE = () => _('not a domain or IP/CIDR');

const MODE_MESSAGES = {
	domain: () => _('not a domain (this list allows domains only)'),
	ip: () => _('not an IP/CIDR (this list allows IP entries only)')
};

/* Classify one raw line: { type: 'empty'|'invalid'|'domain'|'ip', problem? } */
function classifyLine(raw) {
	const s = raw.trim();

	if (!s)
		return { type: 'empty' };

	/* Full-line comments are ignored by ZeroBlock — valid, not an entry.
	   "##" directly followed by a selector is adblock syntax, not a comment. */
	if (s.charAt(0) == '#' && !/^##\S/.test(s))
		return { type: 'empty' };

	for (const check of LINE_CHECKS)
		if (check.test(s))
			return {
				type: 'invalid',
				problem: { code: check.code, severity: check.severity, message: check.message() }
			};

	if (isIPv4(s) || isIPv6(s) || isCidr(s))
		return { type: 'ip', key: s.toLowerCase() };

	if (isDomain(s))
		return { type: 'domain', key: s.toLowerCase() };

	if (isIdnDomain(s)) {
		const puny = toPunycode(s);

		if (puny)
			return {
				type: 'domain',
				key: s.toLowerCase(),
				problem: {
					code: 'idn',
					severity: 'warning',
					message: _('non-ASCII (IDN) domain is not documented by ZeroBlock — consider the punycode form: %s').format(puny)
				}
			};
	}

	return {
		type: 'invalid',
		problem: { code: 'garbage', severity: 'error', message: GARBAGE() }
	};
}

return baseclass.extend({
	/* Validate whole file text against a check mode ('auto'|'domain'|'ip').
	   Returns { entries, problems: [{ line, code, severity, message }] };
	   line numbers are 1-based. User data is never modified here. */
	validate: function (text, mode) {
		mode = mode || 'auto';

		const lines = String(text || '').split(/\r\n|\r|\n/);
		const problems = [];
		const seen = new Map();
		let entries = 0;

		lines.forEach((raw, i) => {
			const line = i + 1;
			const c = classifyLine(raw);

			if (c.type == 'empty')
				return;

			if (c.type == 'invalid') {
				problems.push(Object.assign({ line: line }, c.problem));
				return;
			}

			if (mode != 'auto' && c.type != mode) {
				problems.push({
					line: line,
					code: 'mode',
					severity: 'error',
					message: MODE_MESSAGES[mode]()
				});
				return;
			}

			if (c.problem)
				problems.push(Object.assign({ line: line }, c.problem));

			entries++;

			const first = seen.get(c.key);

			if (first)
				problems.push({
					line: line,
					code: 'duplicate',
					severity: 'warning',
					message: _('duplicate of line %d').format(first)
				});
			else
				seen.set(c.key, line);
		});

		return { entries: entries, problems: problems };
	},

	/* Trim every line and convert CRLF/CR endings to LF (PRD section 6:
	   silent normalization is allowed only for whitespace and line endings). */
	normalize: function (text) {
		return String(text || '').split(/\r\n|\r|\n/).map((l) => l.trim()).join('\n');
	},

	/* D14: explicit user action only — drop later duplicates of valid
	   entries (case-insensitive), keep all other lines untouched. */
	deduplicate: function (text) {
		const seen = new Set();

		return String(text || '').split(/\r\n|\r|\n/).filter((raw) => {
			const c = classifyLine(raw);

			if (c.type != 'domain' && c.type != 'ip')
				return true;

			if (seen.has(c.key))
				return false;

			seen.add(c.key);
			return true;
		}).join('\n');
	}
});
