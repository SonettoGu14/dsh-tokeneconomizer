#!/usr/bin/env node
/**
 * One-command release for the five packages.
 *
 *   pnpm release patch           # 0.1.0 -> 0.1.1
 *   pnpm release minor|major
 *   pnpm release 0.2.0
 *   pnpm release patch --dry-run # checks only, prints what it would do
 *   pnpm release patch --skip-verify
 *
 * It bumps every package.json, commits, tags v<version> and pushes the tag.
 * Publishing itself happens in GitHub Actions through OIDC Trusted Publishing
 * (.github/workflows/publish.yml); no npm token is involved.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/** Root package.json is private; it only carries the version the tag must match. */
const MANIFESTS = [
  'package.json',
  'packages/core/package.json',
  'packages/cost/package.json',
  'packages/facts/package.json',
  'packages/prune/package.json',
  'packages/bundle/package.json',
];
const BRANCH = 'master';
const WORKFLOW = 'publish.yml';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const bump = positional[0] ?? 'patch';
const dryRun = flags.has('--dry-run');
const skipVerify = flags.has('--skip-verify');

function run(command, args, options = {}) {
  const shown = [command, ...args].join(' ');
  if (dryRun) {
    console.log('  [dry-run] ' + shown);
    return '';
  }
  console.log('  $ ' + shown);
  return execFileSync(command, args, { encoding: 'utf8', stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function fail(message) {
  console.error('\n' + message);
  process.exit(1);
}

function nextVersion(currentVersion, input) {
  if (/^\d+\.\d+\.\d+$/.test(input)) return input;
  const [major, minor, patch] = currentVersion.split('.').map((part) => Number.parseInt(part, 10));
  if (input === 'major') return `${major + 1}.0.0`;
  if (input === 'minor') return `${major}.${minor + 1}.0`;
  if (input === 'patch') return `${major}.${minor}.${patch + 1}`;
  return fail(`version argument must be patch, minor, major or x.y.z — got "${input}"`);
}

const current = JSON.parse(readFileSync(MANIFESTS[0], 'utf8')).version;
const version = nextVersion(current, bump);
const tag = 'v' + version;

console.log(`release ${current} -> ${version}${dryRun ? ' (dry run)' : ''}`);

// 1. Repository state: clean tree, right branch, tag free, in sync with origin.
if (git('status', '--porcelain') !== '') fail('working tree is not clean — commit or stash first');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== BRANCH) fail(`release from ${BRANCH}, not ${branch}`);
if (git('tag', '--list', tag) !== '') fail(`tag ${tag} already exists`);
if (!dryRun) {
  run('git', ['fetch', 'origin', '--tags']);
  if (git('rev-list', '--count', `origin/${BRANCH}..HEAD`) !== '0') fail(`local is ahead of origin/${BRANCH} — push first`);
  if (git('rev-list', '--count', `HEAD..origin/${BRANCH}`) !== '0') fail(`local is behind origin/${BRANCH} — pull first`);
}

// 2. The same gate CI runs, so a broken release fails here and not at publish.
if (skipVerify) console.log('  (verify skipped)');
else run('pnpm', ['verify']);

// 3. Bump every manifest. Only the version line is rewritten, so the diff is one
//    line per file.
for (const manifest of MANIFESTS) {
  const before = readFileSync(manifest, 'utf8');
  const after = before.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (after === before) fail(`${manifest} has no top-level "version" to bump`);
  if (!dryRun) writeFileSync(manifest, after);
}
if (dryRun) console.log('  [dry-run] would bump ' + MANIFESTS.length + ' manifests to ' + version);

// 4. Commit and tag. The tag is what CI reacts to.
run('git', ['add', ...MANIFESTS]);
run('git', ['commit', '-m', 'release: ' + tag]);
run('git', ['tag', '-a', tag, '-m', 'release: ' + tag]);
run('git', ['push', 'origin', BRANCH, '--follow-tags']);

console.log(`\n${tag} pushed — npm publish and the GitHub Release run in CI`);
console.log(`  watch:   gh run list --workflow ${WORKFLOW} --limit 1`);
console.log('  verify:  npm view dsh-te version   (registry lags 1-3 min)');
console.log(`  release: gh release view ${tag}`);
