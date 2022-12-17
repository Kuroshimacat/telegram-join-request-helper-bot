const baseRule = require('eslint-config-standard-with-typescript');

return {
	overrides: [
		Object.assign({}, baseRule.overrides[0], {
			files: ['*.cts', '*.mts']
		})
	]
};
