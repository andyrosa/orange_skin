// Build line for orange_skin.html.
// Writes a copy of the page whose build line names the published build: the release tag, or "Development build"
// without one, then the full commit SHA, the commit time, and the publication time, both in UTC. The committed page
// keeps the unstamped line, so a page opened from a checkout reads "Development build" alone.
//   node scripts/stamp.js --out=<file>                  a development build; .github/workflows/pages.yml deploys one
//   node scripts/stamp.js --out=<file> --release=<tag>  a release; Publish-Release.ps1 attaches one
// The build line sits outside the hashed inline blocks, so the copy keeps the page's Content-Security-Policy current.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HTML_PATH, readPage, readArgument } = require('./load_core');

const DEVELOPMENT_LABEL = 'Development build';
const BUILD_LINE = `<p id="build-info" class="verbose-only">${DEVELOPMENT_LABEL}</p>`;
const RELEASE_TAG_PATTERN = /^release-\d{8}T\d{6}[+-]\d{4}$/;

function git(...args) {
    return execFileSync('git', ['-C', path.dirname(HTML_PATH), ...args], { encoding: 'utf8' }).trim();
}

// An ISO 8601 UTC time to the second, such as 2026-10-25T13:34:19Z.
function utcSeconds(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function main() {
    const out = readArgument('out');
    if (!out) {
        throw new Error('--out=<file> is required');
    }
    const release = readArgument('release');
    if (release !== null && !RELEASE_TAG_PATTERN.test(release)) {
        throw new Error(`--release must match ${RELEASE_TAG_PATTERN}, not ${JSON.stringify(release)}`);
    }
    // The build line names a commit, so the page must be that commit's page.
    const pageName = path.basename(HTML_PATH);
    if (git('status', '--porcelain', '--', pageName) !== '') {
        throw new Error(`${pageName} differs from HEAD, so no commit describes it`);
    }
    const commit = git('rev-parse', 'HEAD');
    const committed = utcSeconds(new Date(git('show', '-s', '--format=%cI', 'HEAD')));
    const html = readPage();
    const lineCount = html.split(BUILD_LINE).length - 1;
    if (lineCount !== 1) {
        throw new Error(`${HTML_PATH} holds the build line ${lineCount} times instead of once: ${BUILD_LINE}`);
    }
    const label = release === null ? DEVELOPMENT_LABEL : `Release ${release}`;
    const text = `${label}, commit ${commit}, committed ${committed}, published ${utcSeconds(new Date())}`;
    fs.writeFileSync(out, html.replace(BUILD_LINE, () => BUILD_LINE.replace(DEVELOPMENT_LABEL, text)), 'utf8');
    console.log(`Wrote ${out}: ${text}`);
}

main();
