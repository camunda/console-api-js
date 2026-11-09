const base = require('@camunda8/sdk-infra/configs/release.config.base.cjs');

module.exports = {
  ...base,
  plugins: [
    ...base.plugins,
    ['@semantic-release/npm', { npmPublish: true }],
    [
      '@semantic-release/git',
      {
        assets: ['CHANGELOG.md', 'package.json', 'package-lock.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    [
      '@semantic-release/github',
      {
        successComment:
          'Released in `${nextRelease.gitTag}` (npm: `@camunda8/console-api@${nextRelease.version}`).',
      },
    ],
  ],
};
