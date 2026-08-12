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
/* PRD section 8: writes go through the ubus "file write" call, whose message
   size limit is well below a megabyte — luci-app-adblock caps its own list
   editor at the same order of magnitude for exactly this reason. Reads use
   fs.read_direct(), which bypasses ubus and is not bound by this limit. */
const MAX_SIZE = 102400;
const MAX_SHOWN_PROBLEMS = 100;

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

/* Deliberately not uci.apply(): that is apply-with-rollback, whose deferred
   confirm step runs detached and unretried in luci-base — when it misfires,
   rpcd silently reverts the config 10 s later and the page state desyncs
   (phantom sections, "no data" / "access denied" on later applies). The
   routelists config is metadata only and cannot cut connectivity, so it is
   applied unchecked. apply is skipped when nothing is staged (rpcd answers
   NO_DATA otherwise), and the header's "Unsaved Changes" badge is refreshed,
   since it snapshots the changeset when uci.save() reloads the config. */
function saveAndApply() {
	return uci.save()
		.then(() => uci.changes())
		.then((changes) => Object.keys(changes).length ? uci.callApply(0, false) : null)
		.then(() => ui.changes.init());
}

/* Empty files are not read at all (their content is known); fs.read_direct()
   bypasses the ubus message size limit, so large lists are counted correctly.
   null means the read genuinely failed and the content is unknown. */
function readList(filename, size) {
	return size ? L.resolveDefault(fs.read_direct(filePath(filename)), null) : Promise.resolve('');
}

function listMode(name) {
	const sid = findUciSection(name);
	const mode = sid ? uci.get('routelists', sid, 'mode') : 'auto';

	return MODES.indexOf(mode) < 0 ? 'auto' : mode;
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

			/* Entry counts are the only reason to read the files at all, so
			   they are cached per file and recomputed only when the file or
			   its check mode changed — a refresh after create/rename/delete
			   would otherwise re-read every list in full. */
			this.counts = this.counts || {};

			return Promise.all(files.map((f) => {
				const mode = listMode(displayName(f.name));
				const key = [f.mtime, f.size, mode].join(':');
				const cached = this.counts[f.name];

				if (cached && cached.key == key)
					return cached.entries;

				return readList(f.name, f.size).then((content) => {
					/* null content means the read failed and the count is
					   unknown; that state is not cached, so the next refresh
					   tries again */
					const entries = content === null ? null : grammar.validate(content, mode).entries;

					if (entries !== null)
						this.counts[f.name] = { key: key, entries: entries };

					return entries;
				});
			})).then((entries) => ({
				files: files,
				entries: entries,
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
				const path = filePath(f.name);

				return {
					file: f.name,
					name: name,
					mode: listMode(name),
					size: f.size,
					path: path,
					/* null: the file could not be read, so the count is unknown */
					entries: data.entries[i],
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
					'click': ui.createHandlerFn(this, 'handleEdit', list)
				}, _('Edit')),
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
				if (mode == 'auto')
					return; /* no record needed for the default mode (D6) */

				const sid = uci.add('routelists', 'list');

				uci.set('routelists', sid, 'name', name);
				uci.set('routelists', sid, 'mode', mode);

				return saveAndApply();
			})
			.then(L.bind(this.refresh, this))
			.then(L.bind(function () {
				const list = this.state.lists.filter((l) => l.name == name)[0];

				if (list)
					this.openEditor(list, '');
			}, this))
			.catch((err) => {
				ui.addNotification(null, E('p', [_('Failed to create list: %s').format(errText(err))]), 'error');
			});
	},

	handleEdit: function (list) {
		/* A failed read must not look like an empty list, or Save would
		   overwrite the file with nothing — the editor stays closed */
		const read = list.size ? fs.read_direct(list.path) : Promise.resolve('');

		return read.then(L.bind(function (content) {
			this.openEditor(list, content);
		}, this), function (err) {
			ui.addNotification(null,
				E('p', [_('Failed to read the list file: %s. The editor stays closed so that the file cannot be overwritten with empty content.')
					.format(errText(err))]), 'error');
		});
	},

	/* D7: the editor is a modal on the Lists tab; 'cbi-modal' widens it
	   to 900px. One modal per page — nested showModal calls replace the
	   content, so the editor nodes are kept in ed.nodes for restoring. */
	openEditor: function (list, content) {
		/* A file that is already over the limit cannot be written back, so it
		   is shown read-only instead of letting the user lose their edits */
		const tooBig = new TextEncoder().encode(content).length > MAX_SIZE;
		const ed = this.editor = { list: list, dirty: false, validateTimer: null };

		ed.nameInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'maxlength': 32,
			'style': 'width: 12em',
			'input': L.bind(this.handleEditorNameInput, this)
		});
		ed.nameInput.value = list.name;

		ed.modeSelect = E('select', { 'class': 'cbi-input-select', 'change': L.bind(this.handleEditorModeChange, this) },
			MODES.map((m) => E('option', { 'value': m, 'selected': m == list.mode ? '' : null }, modeLabel(m))));

		ed.counter = E('span', { 'style': 'margin-left:1em' });
		ed.issueList = E('div', { 'style': 'margin-top:.5em' });

		/* D12: paths inside ZeroBlock sections are never rewritten by us; the
		   warning shows up as soon as the name differs from the original */
		ed.renameWarning = E('p', { 'class': 'alert-message warning', 'style': 'display:none' }, [
			_('This file is referenced by ZeroBlock section(s): %s. The paths there are not updated automatically — fix them manually after renaming.')
				.format(list.usedBy.join(', '))
		]);

		ed.textarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width:100%; height:50vh; font-family:monospace; white-space:pre; overflow:auto; resize:vertical',
			'wrap': 'off',
			'spellcheck': 'false',
			'input': L.bind(this.handleEditorInput, this)
		});
		ed.textarea.value = content;

		if (tooBig)
			ed.textarea.setAttribute('readonly', 'readonly');

		ed.escapeButton = E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'style': 'display:none',
			'click': ui.createHandlerFn(this, 'handleEditorSave', true)
		}, _('Save with warnings/errors'));

		ed.dedupButton = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'display:none',
			'click': L.bind(this.handleEditorDeduplicate, this)
		}, _('Remove duplicates'));

		/* Cancel must be the first button in the row: Esc (ui.cancelModal)
		   clicks the first '.right > button', which routes it through the
		   unsaved-changes check. D13: apply actions only when the init
		   script exists; reload is primary, restart is secondary. */
		const buttons = [
			E('button', {
				'class': 'btn',
				'click': L.bind(this.handleEditorCancel, this)
			}, _('Cancel')),
			' ', ed.dedupButton,
			' ', ed.escapeButton,
			' ', E('button', {
				'class': 'btn cbi-button cbi-button-save',
				'click': ui.createHandlerFn(this, 'handleEditorSave', false)
			}, _('Save'))
		];

		if (this.state.hasZeroblock)
			buttons.push(' ', new ui.ComboButton('reload', {
				'reload': _('Save & Apply (reload)'),
				'restart': _('Save & Restart')
			}, {
				'click': ui.createHandlerFn(this, 'handleEditorSaveApply'),
				'classes': {
					'reload': 'btn cbi-button cbi-button-apply important',
					'restart': 'btn cbi-button cbi-button-negative important'
				}
			}).render());

		/* Dynamic strings are passed as array children: a bare string child is
		   assigned via innerHTML by dom.append(), an array becomes text nodes */
		ed.nodes = [
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('label', { 'style': 'margin-right:1em' }, [_('Name'), ' ', ed.nameInput]),
				E('label', {}, [_('Check mode'), ' ', ed.modeSelect]),
				ed.counter
			]),
			ed.renameWarning,
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('code', {}, [list.path]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Paste this path into the "User lists" field of a ZeroBlock section'),
					'click': L.bind(this.handleCopy, this, list.path)
				}, _('Copy path'))
			]),
			...(tooBig ? [E('p', { 'class': 'alert-message warning' }, [
				_('This list is larger than %d KiB and cannot be saved back — the editor is read-only. Edit the file over SSH.')
					.format(MAX_SIZE / 1024)
			])] : []),
			ed.textarea,
			ed.issueList,
			E('div', { 'class': 'right' }, buttons)
		];

		/* D10: warn about unsaved changes on any page unload while the
		   modal is open (LuCI pages are full loads, so this covers menu
		   navigation too); removed again in closeEditor() */
		ed.beforeunload = L.bind(function (ev) {
			if (this.editor && this.editor.dirty) {
				ev.preventDefault();
				ev.returnValue = '';
			}
		}, this);
		window.addEventListener('beforeunload', ed.beforeunload);

		ui.showModal(_('Edit list'), ed.nodes, 'cbi-modal');
		this.updateEditorValidation();
	},

	closeEditor: function () {
		window.removeEventListener('beforeunload', this.editor.beforeunload);
		this.editor = null;
		ui.hideModal();
	},

	handleEditorCancel: function () {
		const ed = this.editor;

		if (!ed.dirty)
			return this.closeEditor();

		/* "Stay" must be the first button so that Esc keeps the editor;
		   restoring ed.nodes via showModal brings back the same DOM nodes —
		   the textarea value survives being detached */
		ui.showModal(_('Unsaved changes'), [
			E('p', _('The list has unsaved changes. Leave without saving?')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					'click': function () {
						ui.showModal(_('Edit list'), ed.nodes, 'cbi-modal');
					}
				}, _('Stay')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': L.bind(this.closeEditor, this)
				}, _('Leave'))
			])
		]);
	},

	handleEditorInput: function () {
		const ed = this.editor;

		ed.dirty = true;

		/* D9: live validation with a 500 ms debounce */
		if (ed.validateTimer)
			window.clearTimeout(ed.validateTimer);

		ed.validateTimer = window.setTimeout(L.bind(this.updateEditorValidation, this), 500);
	},

	handleEditorModeChange: function () {
		/* D5: free mode switching with instant revalidation; conflicts
		   show up as mode errors in the issue list below */
		this.editor.dirty = true;
		this.updateEditorValidation();
	},

	handleEditorNameInput: function () {
		const ed = this.editor;
		const renamed = ed.nameInput.value.trim() != ed.list.name;

		ed.dirty = true;
		ed.renameWarning.style.display = (renamed && ed.list.usedBy.length) ? '' : 'none';
	},

	updateEditorValidation: function () {
		const ed = this.editor;
		const res = grammar.validate(ed.textarea.value, ed.modeSelect.value);
		const errors = res.problems.filter((p) => p.severity == 'error');
		const warnings = res.problems.filter((p) => p.severity == 'warning');

		/* Each count needs its own plural form, so the three parts are
		   translated separately and only then joined by a format string */
		dom.content(ed.counter, [_('%s, %s, %s').format(
			N_(res.entries, '%d entry', '%d entries').format(res.entries),
			N_(errors.length, '%d error', '%d errors').format(errors.length),
			N_(warnings.length, '%d warning', '%d warnings').format(warnings.length))]);

		const items = res.problems.slice(0, MAX_SHOWN_PROBLEMS).map(L.bind(function (p) {
			return E('div', {}, E('a', {
				'href': '#',
				'style': p.severity == 'error' ? 'color:#c44' : 'color:#c80',
				'click': L.bind(function (line, ev) {
					ev.preventDefault();
					this.jumpToLine(line);
				}, this, p.line)
			}, [_('line %d: %s').format(p.line, p.message)]));
		}, this));

		if (res.problems.length > MAX_SHOWN_PROBLEMS) {
			const rest = res.problems.length - MAX_SHOWN_PROBLEMS;

			items.push(E('div', {}, E('em', {}, [
				N_(rest, '…and %d more problem not shown', '…and %d more problems not shown').format(rest)
			])));
		}

		dom.content(ed.issueList, items);

		ed.escapeButton.style.display = res.problems.length ? '' : 'none';
		ed.dedupButton.style.display = res.problems.some((p) => p.code == 'duplicate') ? '' : 'none';
	},

	jumpToLine: function (line) {
		const ta = this.editor.textarea;
		const lines = ta.value.split('\n');
		let start = 0;

		for (let i = 0; i < line - 1 && i < lines.length; i++)
			start += lines[i].length + 1;

		ta.focus();
		ta.setSelectionRange(start, start + (lines[line - 1] || '').length);

		const lh = parseFloat(window.getComputedStyle(ta).lineHeight) ||
			parseFloat(window.getComputedStyle(ta).fontSize) * 1.2 || 16;

		ta.scrollTop = Math.max(0, (line - 1) * lh - ta.clientHeight / 2);
	},

	handleEditorDeduplicate: function () {
		/* D14: explicit action — never deduplicate silently */
		const ed = this.editor;

		ed.textarea.value = grammar.deduplicate(ed.textarea.value);
		ed.dirty = true;
		this.updateEditorValidation();
	},

	/* Write file + persist name/mode; resolves to true if saved */
	doEditorSave: function (force) {
		const ed = this.editor;
		const newName = ed.nameInput.value.trim();
		const renamed = newName != ed.list.name;
		const mode = ed.modeSelect.value;

		if (!NAME_RE.test(newName)) {
			ui.addNotification(null,
				E('p', _('Invalid list name — allowed: letters, digits, "-" and "_", at most 32 characters.')), 'error');
			return Promise.resolve(false);
		}

		if (renamed && this.state.lists.some((l) => l.name == newName)) {
			ui.addNotification(null, E('p', [_('A list named "%s" already exists.').format(newName)]), 'error');
			return Promise.resolve(false);
		}

		const text = grammar.normalize(ed.textarea.value);
		const res = grammar.validate(text, mode);

		/* D9: mandatory validation on save */
		if (res.problems.length && !force) {
			ed.textarea.value = text;
			this.updateEditorValidation();
			ui.addNotification(null,
				E('p', _('Not saved: the list has problems. Fix them or use "Save with warnings/errors".')), 'error');
			return Promise.resolve(false);
		}

		if (new TextEncoder().encode(text).length > MAX_SIZE) {
			ui.addNotification(null,
				E('p', [_('Not saved: the file exceeds the %d KiB limit.').format(MAX_SIZE / 1024)]), 'error');
			return Promise.resolve(false);
		}

		/* D12: a rename writes the content under the new name and drops the
		   old file; paths in ZeroBlock sections are left untouched */
		return fs.write(filePath(newName + '.txt'), text)
			.then(() => renamed ? fs.remove(ed.list.path) : null)
			.then(() => {
				let sid = findUciSection(ed.list.name);

				if (!sid && mode == 'auto')
					return; /* no record needed for the default mode (D6) */

				/* unchanged values produce no uci delta, and uci.apply()
				   without staged changes fails with UBUS_STATUS_NO_DATA */
				if (sid && uci.get('routelists', sid, 'name') == newName &&
				    uci.get('routelists', sid, 'mode') == mode)
					return;

				if (!sid) {
					sid = uci.add('routelists', 'list');
				}

				uci.set('routelists', sid, 'name', newName);
				uci.set('routelists', sid, 'mode', mode);

				return saveAndApply();
			})
			.then(() => true)
			.catch((err) => {
				ui.addNotification(null, E('p', [_('Failed to save list: %s').format(errText(err))]), 'error');
				return false;
			});
	},

	maybeSuggestApply: function () {
		/* D4 flag, default enabled; pointless without the init script (D13) */
		if (!this.state.hasZeroblock || uci.get('routelists', 'global', 'suggest_apply') == '0')
			return;

		ui.addNotification(null,
			E('p', _('Saved. Changes take effect after applying (reload) ZeroBlock.')), 'info');
	},

	handleEditorSave: function (force) {
		return this.doEditorSave(force).then(L.bind(function (saved) {
			if (!saved)
				return;

			this.closeEditor();

			return this.refresh().then(L.bind(this.maybeSuggestApply, this));
		}, this));
	},

	handleEditorSaveApply: function (ev, action) {
		return this.doEditorSave(false).then(L.bind(function (saved) {
			if (!saved)
				return;

			this.closeEditor();

			return this.refresh().then(L.bind(function () {
				return this.runZeroblock(action);
			}, this));
		}, this));
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

				return saveAndApply();
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

	runZeroblock: function (action) {
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
	},

	handleZeroblock: function (ev, action) {
		return this.runZeroblock(action);
	}
});
