// Measures how well one model does when one request replaces the extraction, consolidation, and scoring
// stages of the page pipeline. The request holds the whole thread and returns the axes and, for each comment,
// its stance on each axis it addresses. The summary stage is not part of the request. Each run is graded
// against the silver reference (data/silver.json, built by scripts/silver.js) as scripts/silver_lib.js grades a
// whole run, and the runs are written to data/single-call-benchmark.json.
// Usage: node scripts/single_call.js --choice=<key>[,<key>...]   choices of SINGLE_CALL_CHOICES
//        node scripts/single_call.js --all                       every choice
//        [--repeats=<n>] n more runs of each choice, each with its own call cache  [--budget=<usd>] [--key=sk-or-...]
// Run 1 replays the shared call cache, so measuring a choice again costs only its repeats.
// Each run measures two variants:
//   oneCall   the request alone: every stance it returns counts.
//   twoCalls  the request plus one scoring call, which is the pipeline's second scoring pass (axes shuffled,
//             statements swapped) over the whole thread in one request. Only the stances both calls give
//             count, as the pipeline counts only the stances both of its scoring passes give.
// Both variants run through the page pipeline (runPipeline) with the request's output as the fixed response of
// extraction, consolidation, and the first scoring pass, so the rows are the rows the page would show. The
// pipeline's floor applies: an axis on whose two statements the request put fewer than MIN_AXIS_PEOPLE people
// is dropped.
const path = require('node:path');
const lib = require('./silver_lib');
const { runMain } = require('./load_core');

const { core, MODEL } = lib;
const RESULT_FILE = path.join(lib.REPO_ROOT, 'data', 'single-call-benchmark.json');
const DEFAULT_BUDGET_USD = 10;
const SINGLE_CALL_STAGE = 'singleCall';
// One extraction batch holds the whole thread, so the request's axes are the candidates of one batch.
const WHOLE_THREAD_BATCH_CHARS = Number.MAX_SAFE_INTEGER;

// The single-call choices: the page's, and Claude Fable 5.1 at low, which the page leaves out for its cost.
const choiceOf = entry => ({ name: entry.name, effort: entry.effort, ...core.stageSettings(entry.config, SINGLE_CALL_STAGE) });
const SINGLE_CALL_CHOICES = Object.freeze({
    ...Object.fromEntries(Object.entries(core.SINGLE_CALL_MODELS).map(([key, entry]) => [key, choiceOf(entry)])),
    fableLow: choiceOf(core.singleCallEntry('fableLow', 'low')),
});

// The request the page's single-call mode sends, with the core block's prompt, schema, and parser.
async function requestSingleCall({ choice, thread, modelCallChat }) {
    const commentsById = core.indexCommentsById(thread.comments);
    const call = {
        stage: SINGLE_CALL_STAGE, model: choice.model, sampling: choice.sampling, reasoning: choice.reasoning, maxTokens: choice.maxTokens,
        messages: core.buildSingleCallMessages(thread.title, thread.postText, thread.comments, commentsById, core.DEFAULT_CONFIG.parentSnippetChars),
        schema: core.SINGLE_CALL_SCHEMA,
    };
    return core.parseSingleCallResponse((await modelCallChat(call)).json, new Set(thread.comments.map(comment => comment.id)));
}

// The pipeline config of both variants: the choice's model in every stage, and one batch per stage.
function pipelineConfig(choice, thread) {
    return { ...core.applyToAllStages({}, { model: choice.model, sampling: choice.sampling, reasoning: choice.reasoning, maxTokens: choice.maxTokens }),
        extractBatchChars: WHOLE_THREAD_BATCH_CHARS, scoreBatchComments: thread.comments.length, concurrency: 1 };
}

// The fixed pipeline responses that stand for the request: one candidate per axis holding the comments the
// request put on its two statements, one axis per candidate (both as parseSingleCallResponse returns them), and
// the request's stances as the first scoring pass. The second scoring pass repeats those stances
// (secondPassByModel false) or goes to the model.
function handlersOf(single, secondPassByModel) {
    const requestStances = lib.fixedStances(single.stances);
    return {
        extract: () => ({ candidates: single.candidates }),
        consolidate: lib.fixedAxes(single.axes),
        score: call => (secondPassByModel && call.meta.passIndex === 1 ? MODEL : requestStances(call)),
        synthesize: lib.noSummary,
    };
}

// The dollars, seconds, and count of the given metered calls. The calls of a variant run one after another.
function spent(calls) {
    const sum = values => values.reduce((total, value) => total + value, 0);
    return { usd: sum(calls.map(call => call.usd)), seconds: lib.rounded(sum(calls.map(call => call.seconds ?? 0))), calls: calls.length,
        promptTokens: sum(calls.map(call => call.promptTokens)), completionTokens: sum(calls.map(call => call.completionTokens)) };
}

function runLine(label, run) {
    const figures = run.failed
        ? `FAILED: ${run.failed}`
        : `${run.axes} axes, ${run.rowsWithEnoughPeople} with enough people, ${run.stances} stances; F1 against silver ${lib.percent(run.agreement)} `
            + `(precision ${lib.percent(run.precision)}, recall ${lib.percent(run.recall)}), ${run.pairedAxes} of ${run.referenceAxes} silver axes paired`;
    return `${label}: ${figures}; $${run.usd.toFixed(4)}, ${run.seconds} s, ${run.calls} calls`;
}

// One run of a choice: the request, then both variants through the pipeline, graded against silver.
async function runChoice({ choiceKey, silver, thread, modelCallChat, label }) {
    const choice = SINGLE_CALL_CHOICES[choiceKey];
    const meter = lib.makeMeter();
    const meteredCallChat = meter.wrap(modelCallChat);
    const callsOf = stage => meter.calls.filter(call => call.stage === stage);
    let single;
    try {
        single = await requestSingleCall({ choice, thread, modelCallChat: meteredCallChat });
    } catch (error) {
        const failed = { ...lib.failedGrade(error), ...spent(callsOf(SINGLE_CALL_STAGE)) };
        return { oneCall: failed, twoCalls: failed };
    }
    const config = pipelineConfig(choice, thread);
    const run = (variant, secondPassByModel) => lib.runStages({ thread, config, handlers: handlersOf(single, secondPassByModel), modelCallChat: meteredCallChat, label: `${label} ${variant}` });
    const returned = { axesReturned: single.axes.length, stancesReturned: single.stances.size, warnings: single.warnings.length };
    const oneCall = { ...returned, ...lib.gradeWholeRun(await run('oneCall', false), silver), ...spent(callsOf(SINGLE_CALL_STAGE)) };
    let twoCalls;
    try {
        twoCalls = { ...returned, ...lib.gradeWholeRun(await run('twoCalls', true), silver), ...spent(meter.calls) };
    } catch (error) {
        twoCalls = { ...lib.failedGrade(error), ...spent(meter.calls) };
    }
    return { oneCall, twoCalls };
}

// The runs of one variant and, over them, the mean, lowest, and highest of each figure. A failed run counts as
// F1 0 and has no shape.
const SPREAD_FIELDS = Object.freeze(['agreement', 'precision', 'recall', 'axes', 'rowsWithEnoughPeople', 'stances', 'usd', 'seconds']);
function variantSummary(runs) {
    return { runs, ...lib.runSummary(runs, SPREAD_FIELDS) };
}

async function measureChoice({ choiceKey, repeats, silver, thread, apiKey, ledger }) {
    const choice = SINGLE_CALL_CHOICES[choiceKey];
    const runs = [];
    for (let runNumber = 1; runNumber <= 1 + repeats; runNumber += 1) {
        const modelCallChat = lib.runCallChat({ apiKey, ledger, name: `single-${choiceKey}`, runNumber, firstCacheDirectory: lib.CACHE_DIRECTORY });
        const label = `${choiceKey} run ${runNumber}`;
        const result = await runChoice({ choiceKey, silver, thread, modelCallChat, label });
        console.log(runLine(`${label} oneCall`, result.oneCall));
        console.log(runLine(`${label} twoCalls`, result.twoCalls));
        runs.push(result);
    }
    return { name: choice.name, effort: choice.effort, model: choice.model, oneCall: variantSummary(runs.map(run => run.oneCall)),
        twoCalls: variantSummary(runs.map(run => run.twoCalls)), measuredAt: new Date().toISOString() };
}

async function main() {
    const silver = lib.readSilver();
    const keys = lib.readKeyList('choice', SINGLE_CALL_CHOICES);
    const repeats = lib.readRepeats();
    const benchmark = { threadId: silver.threadId, title: silver.title, comments: silver.comments, chars: silver.chars, silverBuiltAt: silver.builtAt,
        results: lib.readStoredResults(RESULT_FILE, silver) ?? {} };
    const ledger = { spentUsd: 0, capUsd: lib.readNumberArgument('budget') ?? DEFAULT_BUDGET_USD };
    const apiKey = lib.requireApiKey();
    const thread = await lib.loadThread(silver.threadId);
    lib.checkSilverSnapshot(thread, silver);
    // The choices run side by side; each result is saved as it arrives.
    await Promise.all(keys.map(async key => {
        benchmark.results[key] = await measureChoice({ choiceKey: key, repeats, silver, thread, apiKey, ledger });
        lib.writeStoredResults(RESULT_FILE, benchmark);
    }));
    console.log(`wrote ${RESULT_FILE}; $${ledger.spentUsd.toFixed(2)} spent in this run`);
}

runMain(main);
