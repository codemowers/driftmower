const js = require('@eslint/js');
const ts = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
    {
        ignores: ['dist/', 'node_modules/', 'lib/'],
    },
    {
        files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: ['./tsconfig.json'],
                tsconfigRootDir: __dirname,
                sourceType: 'module',
            },
            globals: {
                describe: 'readonly',
                it: 'readonly',
                beforeAll: 'readonly',
                afterAll: 'readonly',
                beforeEach: 'readonly',
                afterEach: 'readonly',
                expect: 'readonly',
                vitest: 'readonly',
                console: 'readonly',
                fetch: 'readonly',
                process: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': ts,
        },
        rules: {
            ...js.configs.recommended.rules,
            ...ts.configs.recommended.rules,
            // Disallow console.log; allow warn/error
            'no-console': ['error', { allow: ['warn', 'error'] }],
            // Allow empty object/interface types in this codebase
            '@typescript-eslint/no-empty-object-type': 'off',
            'padding-line-between-statements': [
                'error',
                { blankLine: 'always', prev: ['const', 'let', 'var'], next: '*' },
                { blankLine: 'any', prev: ['const', 'let', 'var'], next: ['const', 'let', 'var'] },
                { blankLine: 'always', prev: '*', next: 'if' },
                { blankLine: 'always', prev: 'if', next: '*' },
                { blankLine: 'always', prev: ['block', 'block-like'], next: '*' },
                { blankLine: 'always', prev: '*', next: 'return' },
            ],
        },
    },
    {
        files: ['src/web/**/*.ts'],
        languageOptions: {
            globals: {
                document: 'readonly',
                window: 'readonly',
                location: 'readonly',
                history: 'readonly',
                crypto: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
            },
        },
    },
];
