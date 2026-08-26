'use strict';
'require view';

function formatRow(format, example, modes) {
	return E('div', { 'class': 'tr' }, [
		E('div', { 'class': 'td' }, format),
		E('div', { 'class': 'td' }, example ? E('code', {}, example) : '—'),
		E('div', { 'class': 'td' }, modes)
	]);
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	render: function () {
		return E('div', { 'class': 'cbi-map' }, [
			E('h2', _('User Lists — Help')),

			E('h3', _('Supported entry formats')),
			E('div', { 'class': 'table' }, [
				E('div', { 'class': 'tr table-titles' }, [
					E('div', { 'class': 'th' }, _('Format')),
					E('div', { 'class': 'th' }, _('Example')),
					E('div', { 'class': 'th' }, _('Allowed in modes'))
				]),
				formatRow(_('Empty line'), null, _('all')),
				formatRow(_('Comment line'), '# my sites', _('all')),
				formatRow(_('Domain'), 'example.com', _('Auto, Domains only')),
				formatRow(_('IPv4'), '1.2.3.4', _('Auto, IP only')),
				formatRow(_('IPv4 CIDR'), '1.2.3.0/24', _('Auto, IP only')),
				formatRow(_('IPv6'), '2a00:1450::1', _('Auto, IP only')),
				formatRow(_('IPv6 CIDR'), '2a00::/32', _('Auto, IP only'))
			]),
			E('p', _('One entry per line, plain text. The following are rejected as errors because the ZeroBlock file contract explicitly excludes them: %s prefixes, hosts-style lines (%s) and adblock syntax (%s). Those notations only work when entered manually inside a ZeroBlock section, not in list files.')
				.format('full: / keyword: / regexp:', '0.0.0.0 example.com', '||ads.example^')),

			E('h3', _('Check modes')),
			E('p', _('The check mode only affects validation in this app; ZeroBlock itself always auto-detects each line. "Auto" accepts every valid entry type, "Domains only" and "IP only" restrict the list to one entry type — useful to catch mistakes in lists meant for a single purpose.')),

			E('h3', _('Comments')),
			E('p', _('Full-line comments (# ...) are ignored by ZeroBlock and are valid here. An inline comment after an entry (%s) is still flagged: it is not documented, and ZeroBlock\'s auto-detection is binary — a line with "/" or consisting of digits and dots is treated as IP/CIDR, everything else silently becomes a "domain". That is also why invalid lines are worth fixing: ZeroBlock will never report them.')
				.format('1.2.3.4 # note')),

			E('h3', _('Attaching a list to a ZeroBlock section')),
			E('ol', {}, [
				E('li', _('Copy the list path on the Lists tab ("Copy path").')),
				E('li', _('Open the desired section in ZeroBlock.')),
				E('li', _('Switch to its Lists tab.')),
				E('li', _('Paste the path into the "User lists" field and apply.'))
			]),
			E('p', _('Public, ready-made lists are better attached directly by URL in ZeroBlock; this app is for maintaining your own local lists.')),

			E('h3', _('Deleting lists that are in use')),
			E('p', _('If a file referenced by a ZeroBlock section disappears, then depending on lists_failure_mode the section may be disabled (degrade) or the whole proxy service may stop (teardown). Remove the path from the sections before deleting a list.')),

			E('h3', _('Backups')),
			E('p', _('The lists (/etc/user-lists) and this app\'s settings are included in the standard LuCI configuration backup. A sysupgrade without keeping settings erases them — make a backup before flashing.')),

			E('p', {}, E('em', {}, _('Entry formats verified against ZeroBlock full manual v0.8.4-r248, section 11.')))
		]);
	}
});
