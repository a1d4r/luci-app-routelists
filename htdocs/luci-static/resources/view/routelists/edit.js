'use strict';
'require view';

return view.extend({
	render: function() {
		var name = L.env.requestpath[L.env.requestpath.length - 1] || '';

		return E([], [
			E('h2', _('Edit list: %s').format(name)),
			E('p', _('The list editor will appear here.'))
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
