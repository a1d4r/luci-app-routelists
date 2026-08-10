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
/* The file name comes straight from the URL, so it must not be able to escape
   LIST_DIR: the rpcd ACL glob "/etc/user-lists/*" is matched with fnmatch(),
   which spans "/" and does not resolve "..". Leading dots are rejected too. */
const FILE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
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

/* uci.apply() rejects with a bare ubus status code instead of an Error */
function errText(err) {
	return (err instanceof Error) ? err.message : rpc.getStatusText(err);
}

function findUciSection(name) {
	const match = uci.sections('routelists', 'list').filter((s) => s.name == name)[0];

	return match ? match['.name'] : null;
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
		const requestPath = L.env.requestpath;
		const file = requestPath[requestPath.length - 1] || '';

		if (!file || file == 'edit')
			return Promise.resolve({ message: _('No list name given.') });

		if (!FILE_RE.test(file))
			return Promise.resolve({ message: _('Invalid list name in the address.') });

		const path = LIST_DIR + '/' + file;

		return Promise.all([
			L.resolveDefault(uci.load('routelists'), null),
			L.resolveDefault(fs.stat(path), null),
			L.resolveDefault(fs.stat(ZB_INIT), null)
		]).then((data) => {
			const stat = data[1];
			const hasZeroblock = data[2] != null;

			if (stat == null)
				return { message: _('List file "%s" was not found in %s.').format(file, LIST_DIR) };

			/* Empty files are not read at all (their content is known and the
			   rpcd/cgi-io round trip is pointless); for the rest a failed read
			   must not look like an empty list, or Save would overwrite the
			   file with nothing (D14) */
			if (!stat.size)
				return { file: file, content: '', hasZeroblock: hasZeroblock };

			return fs.read_direct(path).then((content) => ({
				file: file,
				content: content,
				hasZeroblock: hasZeroblock
			}), (err) => ({
				message: _('Failed to read the list file: %s. The editor stays closed so that the file cannot be overwritten with empty content.')
					.format(errText(err))
			}));
		});
	},

	render: function (data) {
		if (data.message)
			return E('div', { 'class': 'cbi-map' }, [
				E('h2', _('Edit list')),
				E('p', { 'class': 'alert-message warning' }, [data.message]),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': function () {
						location.href = L.url('admin', 'services', 'routelists');
					}
				}, _('Back to lists'))
			]);

		this.file = data.file;
		this.path = LIST_DIR + '/' + data.file;
		this.name = displayName(data.file);
		this.hasZeroblock = data.hasZeroblock;
		this.dirty = false;
		this.validateTimer = null;

		let mode = uci.get('routelists', findUciSection(this.name), 'mode');

		if (MODES.indexOf(mode) < 0)
			mode = 'auto';

		this.mode = mode;

		this.textarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'style': 'width:100%; height:60vh; font-family:monospace; white-space:pre; overflow:auto; resize:vertical',
			'wrap': 'off',
			'spellcheck': 'false',
			'input': L.bind(this.handleInput, this)
		});
		this.textarea.value = data.content;

		/* A file that is already over the limit cannot be written back, so it
		   is shown read-only instead of letting the user lose their edits */
		const tooBig = new TextEncoder().encode(data.content).length > MAX_SIZE;

		if (tooBig)
			this.textarea.setAttribute('readonly', 'readonly');

		this.counter = E('span', { 'style': 'margin-left:1em' });
		this.issueList = E('div', { 'style': 'margin-top:.5em' });

		this.modeSelect = E('select', { 'class': 'cbi-input-select', 'change': L.bind(this.handleModeChange, this) },
			MODES.map((m) => E('option', { 'value': m, 'selected': m == mode ? '' : null }, modeLabel(m))));

		this.escapeButton = E('button', {
			'class': 'btn cbi-button cbi-button-negative',
			'style': 'display:none',
			'click': ui.createHandlerFn(this, 'handleForceSave')
		}, _('Save with warnings/errors'));

		this.dedupButton = E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'style': 'display:none',
			'click': L.bind(this.handleDeduplicate, this)
		}, _('Remove duplicates'));

		/* Standard LuCI footer order: Apply combo first, then Save
		   (see view.addFooter in luci-base). D13: apply actions only
		   when the init script exists; reload is primary, restart is
		   secondary. */
		const buttons = [];

		if (this.hasZeroblock)
			buttons.push(new ui.ComboButton('reload', {
				'reload': _('Save & Apply (reload)'),
				'restart': _('Save & Restart')
			}, {
				'click': ui.createHandlerFn(this, 'handleSaveApplyAction'),
				'classes': {
					'reload': 'btn cbi-button cbi-button-apply important',
					'restart': 'btn cbi-button cbi-button-negative important'
				}
			}).render(), ' ');

		buttons.push(E('button', {
			'class': 'btn cbi-button cbi-button-save',
			'click': ui.createHandlerFn(this, 'handlePlainSave')
		}, _('Save')));

		buttons.push(' ', this.escapeButton, ' ', this.dedupButton, ' ', E('button', {
			'class': 'btn cbi-button cbi-button-neutral',
			'click': L.bind(this.handleBack, this)
		}, _('Back')));

		/* D10: warn about unsaved changes on any page unload
		   (LuCI pages are full loads, so this covers menu navigation too) */
		window.addEventListener('beforeunload', L.bind(function (ev) {
			if (this.dirty) {
				ev.preventDefault();
				ev.returnValue = '';
			}
		}, this));

		/* Dynamic strings are passed as array children: a bare string child is
		   assigned via innerHTML by dom.append(), an array becomes text nodes */
		const node = E('div', { 'class': 'cbi-map' }, [
			E('h2', [_('Edit list: %s').format(this.name)]),
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('label', {}, [_('Check mode'), ' ', this.modeSelect]),
				this.counter
			]),
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('code', {}, [this.path]),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Paste this path into the "User lists" field of a ZeroBlock section'),
					'click': L.bind(this.handleCopy, this)
				}, _('Copy path'))
			]),
			...(tooBig ? [E('p', { 'class': 'alert-message warning' }, [
				_('This list is larger than %d KiB and cannot be saved back — the editor is read-only. Edit the file over SSH.')
					.format(MAX_SIZE / 1024)
			])] : []),
			this.textarea,
			this.issueList,
			E('div', { 'class': 'cbi-page-actions' }, buttons)
		]);

		this.updateValidation();

		return node;
	},

	handleInput: function () {
		this.dirty = true;

		/* D9: live validation with a 500 ms debounce */
		if (this.validateTimer)
			window.clearTimeout(this.validateTimer);

		this.validateTimer = window.setTimeout(L.bind(this.updateValidation, this), 500);
	},

	handleModeChange: function () {
		/* D5: free mode switching with instant revalidation; conflicts
		   show up as mode errors in the issue list below */
		this.mode = this.modeSelect.value;
		this.dirty = true;
		this.updateValidation();
	},

	updateValidation: function () {
		const res = grammar.validate(this.textarea.value, this.mode);
		const errors = res.problems.filter((p) => p.severity == 'error');
		const warnings = res.problems.filter((p) => p.severity == 'warning');

		this.problems = res.problems;

		dom.content(this.counter, _('%d entries, %d errors, %d warnings')
			.format(res.entries, errors.length, warnings.length));

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

		if (res.problems.length > MAX_SHOWN_PROBLEMS)
			items.push(E('div', {},
				E('em', {}, _('…and %d more problems not shown').format(res.problems.length - MAX_SHOWN_PROBLEMS))));

		dom.content(this.issueList, items);

		this.escapeButton.style.display = res.problems.length ? '' : 'none';
		this.dedupButton.style.display = res.problems.some((p) => p.code == 'duplicate') ? '' : 'none';

		return res;
	},

	jumpToLine: function (line) {
		const ta = this.textarea;
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

	handleDeduplicate: function () {
		/* D14: explicit action — never deduplicate silently */
		this.textarea.value = grammar.deduplicate(this.textarea.value);
		this.dirty = true;
		this.updateValidation();
	},

	/* Write file + persist mode; returns a promise resolving to true if saved */
	doSave: function (force) {
		const text = grammar.normalize(this.textarea.value);
		const res = grammar.validate(text, this.mode);

		/* D9: mandatory validation on save */
		if (res.problems.length && !force) {
			this.textarea.value = text;
			this.updateValidation();
			ui.addNotification(null,
				E('p', _('Not saved: the list has problems. Fix them or use "Save with warnings/errors".')), 'error');
			return Promise.resolve(false);
		}

		if (new TextEncoder().encode(text).length > MAX_SIZE) {
			ui.addNotification(null,
				E('p', [_('Not saved: the file exceeds the %d KiB limit.').format(MAX_SIZE / 1024)]), 'error');
			return Promise.resolve(false);
		}

		return fs.write(this.path, text)
			.then(L.bind(function () {
				let sid = findUciSection(this.name);

				if (!sid && this.mode == 'auto')
					return; /* no record needed for the default mode (D6) */

				if (!sid) {
					sid = uci.add('routelists', 'list');
					uci.set('routelists', sid, 'name', this.name);
				}

				uci.set('routelists', sid, 'mode', this.mode);

				return uci.save().then(() => uci.apply());
			}, this))
			.then(L.bind(function () {
				this.textarea.value = text;
				this.dirty = false;
				this.updateValidation();
				return true;
			}, this))
			.catch((err) => {
				ui.addNotification(null, E('p', [_('Failed to save list: %s').format(errText(err))]), 'error');
				return false;
			});
	},

	maybeSuggestApply: function () {
		/* D4 flag, default enabled; pointless without the init script (D13) */
		if (!this.hasZeroblock || uci.get('routelists', 'global', 'suggest_apply') == '0')
			return;

		ui.addNotification(null,
			E('p', _('Saved. Changes take effect after applying (reload) ZeroBlock.')), 'info');
	},

	handlePlainSave: function () {
		return this.doSave(false).then(L.bind(function (saved) {
			if (saved)
				this.maybeSuggestApply();
		}, this));
	},

	handleForceSave: function () {
		return this.doSave(true).then(L.bind(function (saved) {
			if (saved)
				this.maybeSuggestApply();
		}, this));
	},

	handleSaveApplyAction: function (ev, action) {
		return this.doSave(false).then(L.bind(function (saved) {
			if (!saved)
				return;

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
		}, this));
	},

	handleCopy: function (ev) {
		const btn = ev.currentTarget;

		return copyToClipboard(this.path).then(function () {
			btn.textContent = _('Copied');
			window.setTimeout(function () {
				btn.textContent = _('Copy path');
			}, 1000);
		});
	},

	handleBack: function () {
		if (!this.dirty) {
			location.href = L.url('admin', 'services', 'routelists');
			return;
		}

		ui.showModal(_('Unsaved changes'), [
			E('p', _('The list has unsaved changes. Leave without saving?')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('Stay')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-negative',
					'click': L.bind(function () {
						this.dirty = false;
						location.href = L.url('admin', 'services', 'routelists');
					}, this)
				}, _('Leave'))
			])
		]);
	}
});
