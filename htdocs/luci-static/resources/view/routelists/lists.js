'use strict';
'require view';
'require dom';
'require fs';
'require rpc';
'require ui';
'require uci';
'require view.routelists.grammar as grammar';

const LIST_DIR = '/etc/user-lists';
const ZB_INIT = '/etc/init.d/zeroblock';
const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const MODES = ['auto', 'domain', 'ip'];

function modeLabel(mode) {
	switch (mode) {
	case 'domain':
		return _('Domains only');
	case 'ip':
		return _('IP only');
	default:
		return _('Auto');
	}
}

function displayName(filename) {
	return filename.replace(/\.txt$/, '');
}

function filePath(filename) {
	return LIST_DIR + '/' + filename;
}

/* uci.apply() rejects with a bare ubus status code instead of an Error */
function errText(err) {
	return (err instanceof Error) ? err.message : rpc.getStatusText(err);
}

/* Empty files are not read at all (their content is known); fs.read_direct()
   bypasses the ubus message size limit, so large lists are counted correctly.
   null means the read genuinely failed and the content is unknown. */
function readList(filename, size) {
	return size ? L.resolveDefault(fs.read_direct(filePath(filename)), null) : Promise.resolve('');
}

function findUciSection(name) {
	const match = uci.sections('routelists', 'list').filter((s) => s.name == name)[0];

	return match ? match['.name'] : null;
}

/* D11: which ZeroBlock sections reference this file path in user_lists */
function usedBySections(path, zbLoaded) {
	if (!zbLoaded)
		return [];

	return uci.sections('zeroblock')
		.filter((s) => L.toArray(s.user_lists).indexOf(path) >= 0)
		.map((s) => s['.name']);
}

function copyToClipboard(text) {
	if (navigator.clipboard && window.isSecureContext)
		return navigator.clipboard.writeText(text);

	/* http:// context (typical router UI): clipboard API is unavailable */
	const ta = document.createElement('textarea');

	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.appendChild(ta);
	ta.select();

	try {
		document.execCommand('copy');
	}
	finally {
		ta.remove();
	}

	return Promise.resolve();
}

return view.extend({
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	load: function () {
		return Promise.all([
			L.resolveDefault(uci.load('routelists'), null),
			L.resolveDefault(uci.load('zeroblock'), null),
			L.resolveDefault(fs.list(LIST_DIR), []),
			L.resolveDefault(fs.stat(ZB_INIT), null)
		]).then((data) => {
			const files = data[2].filter((e) => e.type == 'file');

			return Promise.all(
				files.map((f) => readList(f.name, f.size))
			).then((contents) => ({
				files: files,
				contents: contents,
				zbLoaded: data[1] != null,
				hasZeroblock: data[3] != null
			}));
		});
	},

	buildState: function (data) {
		this.state = {
			hasZeroblock: data.hasZeroblock,
			lists: data.files.map((f, i) => {
				const name = displayName(f.name);
				const sid = findUciSection(name);
				let mode = sid ? uci.get('routelists', sid, 'mode') : 'auto';

				if (MODES.indexOf(mode) < 0)
					mode = 'auto';

				const path = filePath(f.name);

				return {
					file: f.name,
					name: name,
					mode: mode,
					size: f.size,
					path: path,
					entries: data.contents[i] === null
						? null /* unreadable — do not pretend the list is empty */
						: grammar.validate(data.contents[i], mode).entries,
					usedBy: usedBySections(path, data.zbLoaded)
				};
			})
		};
	},

	render: function (data) {
		this.root = E('div', { 'class': 'cbi-map' });
		this.buildState(data);
		dom.content(this.root, this.renderContent());

		return this.root;
	},

	refresh: function () {
		return this.load().then(L.bind(function (data) {
			this.buildState(data);
			dom.content(this.root, this.renderContent());
		}, this));
	},

	renderContent: function () {
		const nodes = [
			E('h2', _('User Lists')),
			E('div', { 'class': 'cbi-map-descr' },
				_('User list files (domains / IP / CIDR) stored in %s. Attach a list to a ZeroBlock section by pasting its file path into the section\'s "User lists" field.').format(LIST_DIR)),
			this.renderControls(),
			E('div', { 'class': 'cbi-section' }, this.renderTable())
		];

		/* D13: ZeroBlock actions only when the init script exists;
		   reload is the primary action, restart is secondary.
		   Rendered as a standard page footer (cbi-page-actions). */
		if (this.state.hasZeroblock)
			nodes.push(E('div', { 'class': 'cbi-page-actions' },
				new ui.ComboButton('reload', {
					'reload': _('Apply ZeroBlock changes (reload)'),
					'restart': _('Restart ZeroBlock')
				}, {
					'click': ui.createHandlerFn(this, 'handleZeroblock'),
					'classes': {
						'reload': 'btn cbi-button cbi-button-apply important',
						'restart': 'btn cbi-button cbi-button-negative important'
					}
				}).render()));

		return nodes;
	},

	renderControls: function () {
		const controls = [
			E('input', {
				'type': 'text',
				'id': 'routelists-new-name',
				'class': 'cbi-input-text',
				'maxlength': 32,
				'placeholder': _('List name'),
				'style': 'width: 16em'
			}),
			' ',
			E('select', { 'id': 'routelists-new-mode', 'class': 'cbi-input-select' },
				MODES.map((m) => E('option', { 'value': m }, modeLabel(m)))),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-add',
				'click': ui.createHandlerFn(this, 'handleCreate')
			}, _('Add'))
		];

		return E('div', { 'class': 'cbi-section', 'style': 'padding: .5em 0' }, controls);
	},

	renderTable: function () {
		const rows = this.state.lists.map(L.bind(this.renderRow, this));

		if (!rows.length)
			rows.push(E('div', { 'class': 'tr placeholder' },
				E('div', { 'class': 'td' },
					E('em', {}, _('No lists yet. Create the first one and attach it to a ZeroBlock section via its file path.')))));

		return E('div', { 'class': 'table' }, [
			E('div', { 'class': 'tr table-titles' }, [
				E('div', { 'class': 'th' }, _('Name')),
				E('div', { 'class': 'th' }, _('Check mode')),
				E('div', { 'class': 'th' }, _('Entries')),
				E('div', { 'class': 'th' }, _('Size')),
				E('div', { 'class': 'th' }, _('Path')),
				E('div', { 'class': 'th right' }, _('Actions'))
			])
		].concat(rows));
	},

	renderRow: function (list) {
		/* Dynamic strings are passed as array children: a bare string child is
		   assigned via innerHTML by dom.append(), an array becomes text nodes */
		return E('div', { 'class': 'tr' }, [
			E('div', { 'class': 'td', 'data-title': _('Name') }, [list.name]),
			E('div', { 'class': 'td', 'data-title': _('Check mode') }, modeLabel(list.mode)),
			E('div', { 'class': 'td', 'data-title': _('Entries') },
				list.entries === null ? '?' : String(list.entries)),
			E('div', { 'class': 'td', 'data-title': _('Size') }, '%1024.2mB'.format(list.size)),
			E('div', { 'class': 'td', 'data-title': _('Path') }, [
				E('code', {}, [list.path]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Paste this path into the "User lists" field of a ZeroBlock section'),
					'click': L.bind(this.handleCopy, this, list.path)
				}, _('Copy path'))
			]),
			E('div', { 'class': 'td right', 'data-title': _('Actions') }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': function () {
						location.href = L.url('admin', 'services', 'routelists', 'edit', list.file);
					}
				}, _('Edit')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': L.bind(this.handleRename, this, list)
				}, _('Rename')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': L.bind(this.handleRemove, this, list)
				}, _('Delete'))
			])
		]);
	},

	handleCopy: function (path, ev) {
		const btn = ev.currentTarget;

		return copyToClipboard(path).then(function () {
			btn.textContent = _('Copied');
			window.setTimeout(function () {
				btn.textContent = _('Copy path');
			}, 1000);
		});
	},

	handleCreate: function () {
		const name = document.getElementById('routelists-new-name').value.trim();
		const mode = document.getElementById('routelists-new-mode').value;

		if (!NAME_RE.test(name)) {
			ui.addNotification(null,
				E('p', _('Invalid list name — allowed: letters, digits, "-" and "_", at most 32 characters.')), 'error');
			return;
		}

		if (this.state.lists.some((l) => l.name == name)) {
			ui.addNotification(null, E('p', [_('A list named "%s" already exists.').format(name)]), 'error');
			return;
		}

		const file = name + '.txt';

		return fs.exec('/bin/mkdir', ['-p', LIST_DIR])
			.then(() => fs.write(filePath(file), ''))
			.then(() => {
				const sid = uci.add('routelists', 'list');

				uci.set('routelists', sid, 'name', name);
				uci.set('routelists', sid, 'mode', mode);

				return uci.save().then(() => uci.apply());
			})
			.then(() => {
				location.href = L.url('admin', 'services', 'routelists', 'edit', file);
			})
			.catch((err) => {
				ui.addNotification(null, E('p', [_('Failed to create list: %s').format(errText(err))]), 'error');
			});
	},

	handleRename: function (list) {
		const input = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'maxlength': 32,
			'value': list.name
		});
		const body = [
			E('p', [_('New name for list "%s" (the file keeps the .txt extension):').format(list.name)]),
			input
		];

		/* D12: paths inside ZeroBlock sections are never rewritten by us */
		if (list.usedBy.length)
			body.push(E('p', { 'class': 'alert-message warning' }, [
				_('This file is referenced by ZeroBlock section(s): %s. The paths there are not updated automatically — fix them manually after renaming.')
					.format(list.usedBy.join(', '))
			]));

		body.push(E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, function () {
					return this.doRename(list, input.value.trim());
				})
			}, _('Rename'))
		]));

		ui.showModal(_('Rename list'), body);
	},

	doRename: function (list, newName) {
		if (!NAME_RE.test(newName)) {
			ui.addNotification(null,
				E('p', _('Invalid list name — allowed: letters, digits, "-" and "_", at most 32 characters.')), 'error');
			return;
		}

		if (newName == list.name)
			return ui.hideModal();

		if (this.state.lists.some((l) => l.name == newName)) {
			ui.addNotification(null, E('p', [_('A list named "%s" already exists.').format(newName)]), 'error');
			return;
		}

		const newFile = newName + '.txt';

		return readList(list.file, list.size)
			.then((content) => {
				if (content === null)
					return Promise.reject(new Error(_('the list file could not be read')));

				return fs.write(filePath(newFile), content);
			})
			.then(() => fs.remove(list.path))
			.then(() => {
				const sid = findUciSection(list.name);

				if (!sid)
					return;

				uci.set('routelists', sid, 'name', newName);

				return uci.save().then(() => uci.apply());
			})
			.then(L.bind(function () {
				ui.hideModal();

				return this.refresh();
			}, this))
			.catch((err) => {
				ui.hideModal();
				ui.addNotification(null, E('p', [_('Failed to rename list: %s').format(errText(err))]), 'error');
			});
	},

	handleRemove: function (list) {
		const body = [E('p', [_('Delete list "%s"? The file will be removed permanently.').format(list.name)])];

		/* PRD 7.1: reinforced warning when the file is referenced (D11) */
		if (list.usedBy.length)
			body.push(E('p', { 'class': 'alert-message warning' }, [
				_('This file is referenced by ZeroBlock section(s): %s. Depending on lists_failure_mode, a missing file may disable the section or stop the whole proxy service (teardown). Remove the path from the sections first.')
					.format(list.usedBy.join(', '))
			]));

		body.push(E('div', { 'class': 'right' }, [
			E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Cancel')),
			' ',
			E('button', {
				'class': 'btn cbi-button cbi-button-negative',
				'click': ui.createHandlerFn(this, function () {
					return this.doRemove(list);
				})
			}, _('Delete'))
		]));

		ui.showModal(_('Delete list'), body);
	},

	doRemove: function (list) {
		return fs.remove(list.path)
			.then(() => {
				const sid = findUciSection(list.name);

				if (!sid)
					return;

				uci.remove('routelists', sid);

				return uci.save().then(() => uci.apply());
			})
			.then(L.bind(function () {
				ui.hideModal();

				return this.refresh();
			}, this))
			.catch((err) => {
				ui.hideModal();
				ui.addNotification(null, E('p', [_('Failed to delete list: %s').format(errText(err))]), 'error');
			});
	},

	handleZeroblock: function (ev, action) {
		return fs.exec(ZB_INIT, [action]).then(function (res) {
			const out = [res.stdout, res.stderr].filter((s) => s).join('\n').trim();
			const body = [];

			if (res.code === 0)
				body.push(E('p', _('ZeroBlock %s finished successfully.').format(action)));
			else
				body.push(E('p', _('ZeroBlock %s failed (exit code %d).').format(action, res.code)));

			if (out)
				body.push(E('pre', {}, [out]));

			ui.addNotification(null, body, res.code === 0 ? 'info' : 'error');
		}).catch(function (err) {
			ui.addNotification(null,
				E('p', [_('Failed to run ZeroBlock %s: %s').format(action, errText(err))]), 'error');
		});
	}
});
