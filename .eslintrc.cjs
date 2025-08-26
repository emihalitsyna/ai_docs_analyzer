module.exports = {
  root: true,
  env: { node: true, es2021: true },
  extends: ['airbnb-base'],
  parserOptions: { sourceType: 'module' },
  rules: {
    'no-console': 'off',
    'import/extensions': ['error', 'ignorePackages', { js: 'always' }],
    'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
  },
}; 