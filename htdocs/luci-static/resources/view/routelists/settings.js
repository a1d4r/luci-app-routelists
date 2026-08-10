'use strict';
'require view';
'require form';
'require uci';

return view.extend({
	load: function () {
		return uci.load('routelists').then(function () {
			/* The settings section is created lazily: staged here so the
			   form has something to render, persisted only on save. */
			if (!uci.get('routelists', 'global'))
				uci.add('routelists', 'global', 'global');
		});
	},

	render: function () {
		const m = new form.Map('routelists', _('User Lists — Settings'));
		const s = m.section(form.NamedSection, 'global', 'global');

		let o = s.option(form.Flag, 'suggest_apply',
			_('Suggest applying ZeroBlock after saving'),
			_('After saving a list, show a reminder that changes take effect only after applying (reload) ZeroBlock.'));
		o.default = '1';

		o = s.option(form.DummyValue, '_storage',
			_('Storage directory'),
			_('The directory is fixed by the access policy (ACL). Changing it is only possible by editing the ACL file manually.'));
		o.cfgvalue = function () {
			return '/etc/user-lists';
		};

		return m.render();
	}
});
