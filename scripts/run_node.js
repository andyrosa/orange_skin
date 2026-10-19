// Headless runner: executes the same core pipeline as hn_polarization.html from Node.
// Usage: node scripts/run_node.js --thread=49525378 [--key=sk-or-...] [--out=result.json] [--thread-file=path] [--cache-dir=path]
//        [--config-file=path] [--extraction=<key>] [--consolidation=<key>] [--scoring=<key>] [--summary=<key>] [--singleCall=<key>] [--model=id] [--temperature=0] [--seed=12345] [--concurrency=30]
//        [--share=<percent>] [--budget=<usd>]
// --singleCall sends one request in place of extraction, consolidation, and scoring, as the page's Single call box does.
// --share analyzes only the top N percent of comments, the same selection as the page's slider; default 100.
// --budget stops the run once the spend passes this many dollars; default DEFAULT_CONFIG.budgetUsd.
// The OpenRouter key comes from --key, else from the OPENROUTER_API_KEY environment variable.
// --thread-file reads the thread from that file when it exists; otherwise the thread is fetched and saved there.
//   A live thread gains comments over time, which changes every prompt, so reruns need the same snapshot to hit the cache.
// --cache-dir stores each finished model call as <dir>/<key>.json and reuses it on later runs.
// Config flags apply in the order given in buildConfig; later flags override earlier ones.
const fs = require('node:fs');
const { loadCore, readArgument, requireApiKey, makeFileStore } = require('./load_core');

const core = loadCore();
const DEFAULT_SHARE_PERCENT = 100;
const RANK_DIGITS = 3;
// Statements 2 and 3 of a row line up under statement 1, which follows "#", the rank, and a space.
const STATEMENT_INDENT = ' '.repeat('#'.length + RANK_DIGITS + ' '.length);

// Config overrides, applied in this order so that later flags win: config file, role choices (each
// touching only its own stages), one model for every stage, one sampling setting for every stage,
// concurrency.
function buildConfig() {
    const config = {};
    const configFile = readArgument('config-file');
    if (configFile !== null) {
        Object.assign(config, JSON.parse(fs.readFileSync(configFile, 'utf8')));
    }
    for (const role of ['extraction', 'consolidation', 'scoring', 'summary', 'singleCall']) {
        const key = readArgument(role);
        if (key !== null) {
            Object.assign(config, core.roleConfig(role, key), role === 'singleCall' ? { singleCall: true } : {});
        }
    }
    const model = readArgument('model');
    if (model !== null) {
        core.applyToAllStages(config, { model });
    }
    const temperature = readArgument('temperature');
    const seed = readArgument('seed');
    if (temperature !== null || seed !== null) {
        const sampling = {};
        if (temperature !== null) sampling.temperature = Number(temperature);
        if (seed !== null) sampling.seed = Number(seed);
        core.applyToAllStages(config, { sampling });
    }
    const concurrency = readArgument('concurrency');
    if (concurrency !== null) {
        config.concurrency = Number(concurrency);
    }
    const budget = readArgument('budget');
    if (budget !== null) {
        config.budgetUsd = Number(budget);
    }
    return config;
}

// Reads the thread from threadFile when it exists, otherwise fetches it (and saves it when threadFile is given).
async function loadThreadItem(threadId, threadFile) {
    if (threadFile && fs.existsSync(threadFile)) {
        process.stderr.write(`Reading thread ${threadId} from ${threadFile}\n`);
        const item = JSON.parse(fs.readFileSync(threadFile, 'utf8'));
        if (String(item.id) !== threadId) {
            throw new Error(`${threadFile} holds thread ${item.id}, not ${threadId}`);
        }
        return item;
    }
    process.stderr.write(`Fetching thread ${threadId}\n`);
    const item = await core.fetchThreadItem(threadId);
    if (threadFile) {
        fs.writeFileSync(threadFile, JSON.stringify(item), 'utf8');
        process.stderr.write(`Saved thread snapshot to ${threadFile}\n`);
    }
    return item;
}

// Each axis prints as three lines: statement 1, statement 2, then the counts.
function formatRow(row) {
    return [
        `#${String(row.rank).padStart(RANK_DIGITS)} ${row.statementA}`,
        `${STATEMENT_INDENT}${row.statementB}`,
        `${STATEMENT_INDENT}${row.countA} on statement 1, ${row.countB} on statement 2; group ${row.group}; ${core.axisMetaText(row)}`,
    ].join('\n');
}

function report(result, elapsedSeconds) {
    if (result.articleSummary) {
        console.log(`Article summary${result.articleSummary.fetched ? '' : ' (not fetched)'}: ${result.articleSummary.summary}
`);
    } else if (result.articleSummaryError) {
        console.error(`Article summary unavailable: ${result.articleSummaryError}`);
    }
    if (result.synthesis) {
        for (const section of result.synthesis.sections) console.log(`${section.text}\n`);
        for (const caveat of result.synthesis.caveats) console.log(`Caveat: ${caveat}`);
    } else if (result.synthesisError) {
        console.error(`Summary unavailable: ${result.synthesisError}; comparisons preserved.`);
    }
    for (const row of result.rows) {
        console.log(formatRow(row));
    }
    console.log('');
    for (const line of core.formatRunSummary(result)) {
        console.log(line);
    }
    console.log(`${core.formatRunCost(result)}, ${result.warnings.length} warnings, ${core.formatElapsed(elapsedSeconds)}`);
}

async function main() {
    const threadId = readArgument('thread');
    const articleFile = readArgument('article-file');
    if (articleFile && threadId) throw new Error('Choose --article-file or --thread, not both');
    if (!articleFile && (!threadId || !core.isThreadId(threadId))) {
        throw new Error('pass --thread=<numeric Hacker News item id> or --article-file=<plain text file>');
    }
    const apiKey = requireApiKey();
    const config = buildConfig();
    const fullThread = articleFile
        ? core.createArticleSource(fs.readFileSync(articleFile, 'utf8'), readArgument('title') || '')
        : core.flattenThread(await loadThreadItem(threadId, readArgument('thread-file')));
    const share = readArgument('share');
    if (articleFile && share !== null && Number(share) !== 100) throw new Error('Pasted articles require --share=100; the app never silently analyzes only a prefix');
    const thread = articleFile ? fullThread : core.threadShare(fullThread, share === null ? DEFAULT_SHARE_PERCENT : Number(share));
    process.stderr.write(articleFile ? `${thread.title} (complete article, ${thread.text.length} characters)\n` : `${thread.title} (${thread.comments.length} of ${fullThread.comments.length} comments)\n`);

    const cacheDirectory = readArgument('cache-dir');
    // runPipeline applies DEFAULT_CONFIG under these flags; the spending cap uses the same effective budget.
    const budgetUsd = { ...core.DEFAULT_CONFIG, ...config }.budgetUsd;
    const directCallChat = core.makeBudgetedCallChat(core.makeOpenRouterCallChat({ apiKey }), () => core.fetchModelPriceTable(globalThis.fetch), budgetUsd);
    const callChat = cacheDirectory ? core.makeCachedCallChat(directCallChat, makeFileStore(cacheDirectory)) : directCallChat;

    const startedAt = Date.now();
    const result = await core.runPipeline({
        thread,
        config,
        onProgress: update => process.stderr.write(core.formatProgress(update) + '\n'),
        callChat,
    });
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    report(result, elapsedSeconds);

    const outPath = readArgument('out');
    if (outPath) {
        // The role choices given on the command line, null for a role without one; other config flags can override them.
        const roleChoices = Object.fromEntries(Object.keys(core.ROLE_CHOICES).map(role => [role, readArgument(role)]));
        fs.writeFileSync(outPath, JSON.stringify({ threadId, title: thread.title, url: thread.url, roleChoices, elapsedSeconds, ...result }, null, 2), 'utf8');
        process.stderr.write(`wrote ${outPath}\n`);
    }
    if (result.synthesisError) process.exitCode = 1;
}

main().catch(error => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
});
