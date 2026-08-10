'use strict';
'require view';

return view.extend({
	render: function() {
		return E('p', _('Help will appear here.'));
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
