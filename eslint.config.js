const globals = require('globals');
const js = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'coverage',
            'test/public'
        ]
    },
    js.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'brace-style': ['error', '1tbs', { allowSingleLine: true }],
            'comma-dangle': ['error', 'never'],
            'dot-notation': 'error',
            'no-console': 'error',
            'no-inline-comments': 'warn',
            'no-trailing-spaces': 'error',
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
            'object-curly-spacing': ['error', 'always'],
            quotes: ['error', 'single'],
            semi: ['error', 'always'],
            'space-before-function-paren': ['error', {
                anonymous: 'never',
                named: 'never',
                asyncArrow: 'always'
            }]
        }
    }
];
