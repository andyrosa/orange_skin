// Runs whole pipelines, one configuration of the four role choices at a time, several times each, and records
// what each run shows the reader and, on the silver thread, how its stances grade against silver. This is the
// measurement behind the page defaults: two runs of one configuration differ, so a configuration is judged by
// the mean and range of its runs. Results go to data/pipeline-benchmark.json.
// Usage: node scripts/pipeline_runs.js --config=<key>[,<key>...] [--thread=<id>[,<id>...]] [--repeats=<n>]
//        node scripts/pipeline_runs.js --all [--repeats=<n>]
//        [--budget=<usd>] [--concurrency=<calls>] [--key=sk-or-...]
// Each configuration runs on the threads it lists, or on those given with --thread. Run 1 replays the call
// cache of the configuration's first run, which scripts/run_node.js made, so it costs nothing; each repeat has
// its own call cache, so its requests are answered anew. A call made by scripts/run_node.js has no recorded
// time, so a run replayed from such a cache has no latency, and the latency figures cover the repeats only.
// For each run:
//   axes, rowsWithEnoughPeople  the scored axes, and the rows not marked "few people", which have enough
//                               people behind their counts (before 2026-10-22: the rows outside "too few")
//   stances                     the stances both scoring passes gave
//   agreement, precision, recall  on the silver thread only: the run graded against silver as
//                               scripts/silver_lib.js grades a whole run (gradeWholeRun)
//   usd, seconds                what the run's calls cost when they were made, and its latency as the page
//                               forecasts it (runLatencySeconds)
const path = require('node:path');
const lib = require('./silver_lib');
const { runMain } = require('./load_core');

const { core, MODEL } = lib;
const RESULT_FILE = path.join(lib.REPO_ROOT, 'data', 'pipeline-benchmark.json');
const DEFAULT_BUDGET_USD = 20;
const SILVER_THREAD_ID = 22866284;
const LARGE_THREAD_ID = 44163063;
const PIPELINE_HANDLERS = Object.freeze({ extract: MODEL, consolidate: MODEL, score: MODEL, synthesize: MODEL });
const SPREAD_FIELDS = Object.freeze(['axes', 'rowsWithEnoughPeople', 'stances', 'agreement', 'precision', 'recall', 'usd', 'seconds']);
// Where scripts/run_node.js kept the calls of a configuration's first run on a thread.
const firstRunDirectory = folder => threadId => path.join(lib.REPO_ROOT, 'outputs', `${folder}-${threadId}`, 'cache');

// The configurations: the four pairs compared for the defaults, each with GPT-6 Luna low extraction and GPT-6
// Sol low summary, and the highest-agreement choice of each role. Claude Opus 5.5 scoring on the large thread
// would cost about $10 a run, so that configuration runs on the silver thread only.
function configuration(consolidation, scoring, overrides) {
    return { keys: { extraction: 'luna6Low', consolidation, scoring, summary: 'sol6Low' }, threads: [SILVER_THREAD_ID, LARGE_THREAD_ID],
        firstRunDirectory: firstRunDirectory('defaults'), ...overrides };
}
const CONFIGURATIONS = Object.freeze({
    sol61Luna56: configuration('sol61Low', 'lunaLow'),
    sol61Luna6: configuration('sol61Low', 'luna6Low'),
    sonnet55Luna56: configuration('sonnet55', 'lunaLow'),
    sonnet55Luna6: configuration('sonnet55', 'luna6Low'),
    best: configuration('sonnet55', 'opus55', { threads: [SILVER_THREAD_ID], firstRunDirectory: firstRunDirectory('best') }),
});

function runLine(label, run) {
    const silverPart = run.agreement === null ? '' : `; F1 against silver ${lib.percent(run.agreement)} (precision ${lib.percent(run.precision)}, recall ${lib.percent(run.recall)})`;
    const latencyPart = run.seconds === null ? 'latency not recorded' : `${run.seconds} s`;
    return `${label}: ${run.axes} axes, ${run.rowsWithEnoughPeople} with enough people, ${run.stances} stances${silverPart}; $${run.usd.toFixed(4)}, ${latencyPart}, ${run.calls} calls (${run.cachedCalls} replayed)`;
}

async function runOnce({ keys, thread, silver, modelCallChat, concurrency, label }) {
    const meter = lib.makeMeter();
    const result = await lib.runStages({ thread, config: { ...core.buildRunConfig(keys), concurrency }, handlers: PIPELINE_HANDLERS,
        modelCallChat: meter.wrap(modelCallChat), label });
    const graded = silver === null ? { ...lib.wholeRunShape(result), agreement: null, precision: null, recall: null } : lib.gradeWholeRun(result, silver);
    return { ...graded, usd: meter.calls.reduce((sum, call) => sum + call.usd, 0), seconds: lib.runLatencySeconds(meter.calls, concurrency),
        calls: meter.calls.length, cachedCalls: result.stats.cachedCalls, summaryFailed: result.synthesis === null };
}

async function measure({ configKey, threadId, repeats, silver, apiKey, ledger, concurrency }) {
    const { keys, firstRunDirectory: firstRunDirectoryOf } = CONFIGURATIONS[configKey];
    const thread = await lib.loadThread(threadId);
    const reference = threadId === silver.threadId ? silver : null;
    if (reference !== null) lib.checkSilverSnapshot(thread, silver);
    const runs = [];
    for (let runNumber = 1; runNumber <= 1 + repeats; runNumber += 1) {
        const modelCallChat = lib.runCallChat({ apiKey, ledger, name: `pipeline-${threadId}-${configKey}`, runNumber, firstCacheDirectory: firstRunDirectoryOf(threadId) });
        const label = `${configKey} thread ${threadId} run ${runNumber}`;
        const run = await runOnce({ keys, thread, silver: reference, modelCallChat, concurrency, label });
        console.log(runLine(label, run));
        runs.push(run);
    }
    const models = Object.fromEntries(Object.entries(keys).map(([role, key]) => [role, core.modelDisplayName(core.roleChoice(role, key))]));
    return { config: configKey, threadId, keys, models, runs, ...lib.runSummary(runs, SPREAD_FIELDS), measuredAt: new Date().toISOString() };
}

async function main() {
    const silver = lib.readSilver();
    if (silver.threadId !== SILVER_THREAD_ID) throw new Error(`silver is built on thread ${silver.threadId}, not ${SILVER_THREAD_ID}`);
    const configKeys = lib.readKeyList('config', CONFIGURATIONS);
    const threadList = lib.readArgument('thread');
    const threadIds = threadList === null ? null : threadList.split(',').map(Number);
    const tasks = configKeys.flatMap(configKey => CONFIGURATIONS[configKey].threads
        .filter(threadId => threadIds === null || threadIds.includes(threadId))
        .map(threadId => ({ configKey, threadId })));
    if (tasks.length === 0) throw new Error('no listed configuration runs on the given threads');
    const repeats = lib.readRepeats();
    const benchmark = { silverThreadId: silver.threadId, silverBuiltAt: silver.builtAt, results: lib.readStoredResults(RESULT_FILE, silver) ?? {} };
    const ledger = { spentUsd: 0, capUsd: lib.readNumberArgument('budget') ?? DEFAULT_BUDGET_USD };
    const apiKey = lib.requireApiKey();
    const concurrency = lib.readNumberArgument('concurrency') ?? core.DEFAULT_CONFIG.concurrency;
    // The tasks run side by side; the runs of one task run one after another, so that the calls in flight stay
    // within one run's concurrency per task. Each result is saved as it arrives.
    await Promise.all(tasks.map(async task => {
        benchmark.results[`${task.configKey}-${task.threadId}`] = await measure({ ...task, repeats, silver, apiKey, ledger, concurrency });
        lib.writeStoredResults(RESULT_FILE, benchmark);
    }));
    console.log(`wrote ${RESULT_FILE}; $${ledger.spentUsd.toFixed(2)} spent in this run`);
}

runMain(main);
