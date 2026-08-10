'use strict';
'require view';
'require dom';
'require fs';
'require ui';
'require uci';
'require view.routelists.grammar as grammar';

const LIST_DIR = '/etc/user-lists';
const ZB_INIT = '/etc/init.d/zeroblock';
const MODES = ['auto', 'domain', 'ip'];
const MAX_SIZE = 1048576; /* PRD section 8: file limit 1 MiB */
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
			return Promise.resolve({ file: null });

		return Promise.all([
			L.resolveDefault(uci.load('routelists'), null),
			L.resolveDefault(fs.read(LIST_DIR + '/' + file), null),
			L.resolveDefault(fs.stat(ZB_INIT), null)
		]).then((data) => ({
			file: file,
			content: data[1],
			hasZeroblock: data[2] != null
		}));
	},

	render: function (data) {
		if (!data.file || data.content == null)
			return E('div', { 'class': 'cbi-map' }, [
				E('h2', _('Edit list')),
				E('p', { 'class': 'alert-message warning' },
					data.file
						? _('List file "%s" was not found in %s.').format(data.file, LIST_DIR)
						: _('No list name given.')),
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

		const buttons = [
			E('button', {
				'class': 'btn cbi-button cbi-button-save',
				'click': ui.createHandlerFn(this, 'handlePlainSave')
			}, _('Save'))
		];

		/* D13: apply actions only when the init script exists;
		   reload is the primary action, restart is secondary */
		if (this.hasZeroblock)
			buttons.push(' ', new ui.ComboButton('reload', {
				'reload': _('Save & Apply (reload)'),
				'restart': _('Save & Restart')
			}, {
				'click': ui.createHandlerFn(this, 'handleSaveApplyAction'),
				'classes': {
					'reload': 'btn cbi-button cbi-button-apply',
					'restart': 'btn cbi-button cbi-button-negative'
				}
			}).render());

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

		const node = E('div', { 'class': 'cbi-map' }, [
			E('h2', _('Edit list: %s').format(this.name)),
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('label', {}, [_('Check mode'), ' ', this.modeSelect]),
				this.counter
			]),
			E('div', { 'style': 'margin-bottom:.5em' }, [
				E('code', {}, this.path),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'title': _('Paste this path into the "User lists" field of a ZeroBlock section'),
					'click': L.bind(this.handleCopy, this)
				}, _('Copy path'))
			]),
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
			}, _('line %d: %s').format(p.line, p.message)));
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
				E('p', _('Not saved: the file exceeds the 1 MiB limit.')), 'error');
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
				ui.addNotification(null, E('p', _('Failed to save list: %s').format(err.message)), 'error');
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
					body.push(E('pre', {}, out));

				ui.addNotification(null, body, res.code === 0 ? 'info' : 'error');
			}).catch(function (err) {
				ui.addNotification(null,
					E('p', _('Failed to run ZeroBlock %s: %s').format(action, err.message)), 'error');
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
