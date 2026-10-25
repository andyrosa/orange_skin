// Loads the <script id="core"> block out of the page and evaluates it as a CommonJS module.
// This is the project's only packaging seam: the page stays a single file with no build step,
// and the Node runner shares the exact same code. Also holds the command-line helpers every script uses.
const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.join(__dirname, '..', 'orange_skin.html');
const KEY_ENV_NAME = 'OPENROUTER_API_KEY';
const CORE_SCRIPT_PATTERN = /<script id="core">([\s\S]*?)<\/script>/;

function readPage() {
    return fs.readFileSync(HTML_PATH, 'utf8');
}

// The text between a block's open and close tags, which `pattern` captures.
function blockText(html, pattern) {
    const match = html.match(pattern);
    if (!match) {
        throw new Error(`inline block ${pattern} not found in ${HTML_PATH}`);
    }
    return match[1];
}

function loadCore() {
    const moduleShim = { exports: {} };
    new Function('module', blockText(readPage(), CORE_SCRIPT_PATTERN))(moduleShim);
    return moduleShim.exports;
}

function readArgument(name) {
    const prefix = `--${name}=`;
    const found = process.argv.find(argument => argument.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

// A numeric --<name>=<value>, or null when the argument is absent. A value that is not a number is an error, so a
// mistyped budget or concurrency stops the script instead of becoming NaN.
function readNumberArgument(name) {
    const text = readArgument(name);
    if (text === null) return null;
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) throw new Error(`--${name} must be a number, not ${JSON.stringify(text)}`);
    return value;
}

// The OpenRouter key: --key=..., else the environment variable named by KEY_ENV_NAME.
function requireApiKey() {
    const apiKey = readArgument('key') || process.env[KEY_ENV_NAME];
    if (!apiKey) throw new Error(`pass --key=... or set ${KEY_ENV_NAME}`);
    return apiKey;
}

// A call cache that keeps each entry as <directory>/<key>.json.
function makeFileStore(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const pathFor = key => path.join(directory, key + '.json');
    return {
        get(key) {
            try {
                return JSON.parse(fs.readFileSync(pathFor(key), 'utf8'));
            } catch (error) {
                if (error.code === 'ENOENT') return undefined;
                throw error;
            }
        },
        set(key, value) {
            fs.writeFileSync(pathFor(key), JSON.stringify(value), 'utf8');
        },
    };
}

// A saved thread snapshot, the Hacker News item as fetched, checked to hold the expected thread.
function readThreadItem(threadFile, threadId) {
    const item = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
    if (String(item.id) !== String(threadId)) throw new Error(`${threadFile} holds thread ${item.id}, not ${threadId}`);
    return item;
}

// Runs a script's async main function; a failure prints one ERROR line and sets exit code 1.
function runMain(main) {
    main().catch(error => {
        process.stderr.write(`ERROR: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { HTML_PATH, CORE_SCRIPT_PATTERN, readPage, blockText, loadCore, readArgument, readNumberArgument, requireApiKey, makeFileStore,
    readThreadItem, runMain };
