// Shared by scripts/silver.js (builds the silver reference), scripts/benchmark.js (grades model choices
// against it), scripts/single_call.js, and scripts/pipeline_runs.js (grade whole runs against it). All run the
// page's own pipeline (runPipeline); the first two replace the stages that are not under test with fixed
// responses, so a stage is always measured on the same inputs.
const fs = require('node:fs');
const path = require('node:path');
const { loadCore, readArgument, readNumberArgument, requireApiKey, makeFileStore, readThreadItem } = require('./load_core');

const core = loadCore();
const REPO_ROOT = path.join(__dirname, '..');
const SILVER_FILE = path.join(REPO_ROOT, 'data', 'silver.json');
const BENCHMARK_FILE = path.join(REPO_ROOT, 'data', 'silver-benchmark.json');
// Not in git: the thread snapshot and every finished model call, so a rerun pays for nothing twice.
const WORK_DIRECTORY = path.join(REPO_ROOT, 'outputs', 'silver');
// The model calls of the reference and of each choice's first benchmark run.
const CACHE_DIRECTORY = path.join(WORK_DIRECTORY, 'cache');
// One directory per repeat of a benchmark run, so that an identical request is a separate sample.
const REPEATS_DIRECTORY = path.join(WORK_DIRECTORY, 'repeats');

// The silver reference is what these two models agree on: the strongest OpenAI and Anthropic models at a
// high reasoning effort. No person annotated anything.
const SILVER_SEED = 12345;
const SILVER_MODELS = Object.freeze([
    Object.freeze({ key: 'sol61xhigh', name: 'GPT-6.1 Sol', effort: 'xhigh', model: 'openai/gpt-6.1-sol', sampling: Object.freeze({ seed: SILVER_SEED }), reasoning: Object.freeze({ effort: 'xhigh' }) }),
    Object.freeze({ key: 'opus55high', name: 'Claude Opus 5.5', effort: 'high', model: 'anthropic/claude-opus-5.5', sampling: null, reasoning: Object.freeze({ effort: 'high' }) }),
]);
// Output ceilings of the silver models by stage key. Reasoning tokens count against the ceiling.
const SILVER_MAX_TOKENS = Object.freeze({ extract: 64000, consolidate: 128000, score: 64000 });
const JUDGE_MAX_TOKENS = 64000;
// Decimal places of the shares and seconds stored in results.
const PRECISION_DIGITS = 4;
// The longest error message a result stores.
const FAILURE_MESSAGE_CHARS = 300;

// A stage handler is MODEL (send every call of the stage to the configured model) or a function that returns
// the fixed response JSON for the call, or MODEL to send that one call to the configured model.
const MODEL = Symbol('model');

// The pipeline config of a silver model in every stage of a staged run.
function silverConfig(silverModel) {
    const { name, model, sampling, reasoning } = silverModel;
    return core.optionEntry(core.STAGED_ROLES, { name, model, sampling, reasoning, maxTokens: SILVER_MAX_TOKENS }).config;
}

// The thread snapshot the reference was built on, as the pipeline sees it. A later fetch can differ (edited or
// deleted comments), so the snapshot is kept in the work directory and reused.
async function loadThread(threadId) {
    fs.mkdirSync(WORK_DIRECTORY, { recursive: true });
    const threadFile = path.join(WORK_DIRECTORY, `thread-${threadId}.json`);
    if (!fs.existsSync(threadFile)) {
        process.stderr.write(`Fetching thread ${threadId}\n`);
        fs.writeFileSync(threadFile, JSON.stringify(await core.fetchThreadItem(String(threadId))), 'utf8');
    }
    return core.flattenThread(readThreadItem(threadFile, threadId));
}

// Stops when the thread is not the snapshot silver was built on, which would make every grade meaningless.
function checkSilverSnapshot(thread, silver) {
    if (thread.comments.length !== silver.comments || core.totalCommentChars(thread.comments) !== silver.chars) {
        throw new Error(`the thread snapshot (${thread.comments.length} comments) is not the one silver was built on (${silver.comments} comments)`);
    }
}

// The keys a command names with --<name>=<key>[,<key>...], or every key of the table with --all.
function readKeyList(name, table) {
    const list = readArgument(name);
    const keys = process.argv.includes('--all') ? Object.keys(table) : list === null ? [] : list.split(',');
    if (keys.length === 0) throw new Error(`pass --${name}=<key>[,<key>...] or --all`);
    const unknown = keys.filter(key => table[key] === undefined);
    if (unknown.length > 0) throw new Error(`unknown ${name} ${unknown.join(', ')}; the keys are ${Object.keys(table).join(', ')}`);
    return keys;
}

// The results stored in a results file, or null when there is none or it was graded against another build
// of silver, whose results do not compare with new ones.
function readStoredResults(file, silver) {
    if (!fs.existsSync(file)) return null;
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    return stored.silverBuiltAt === silver.builtAt ? stored.results : null;
}

// Writes a results file that readStoredResults reads back.
function writeStoredResults(file, benchmark) {
    fs.writeFileSync(file, JSON.stringify(benchmark, null, 1) + '\n', 'utf8');
}

// The model call path: a cache in cacheDirectory over a timed, capped OpenRouter client. ledger = { spentUsd, capUsd }. A call
// is refused once the spend has reached the cap; calls already in flight still finish, so keep the
// concurrency low enough that their cost is an acceptable overshoot. The call's wall-clock seconds are stored
// with its usage, so a replay from the cache still reports how long the call took.
function makeModelCallChat({ apiKey, ledger, cacheDirectory }) {
    const direct = core.makeOpenRouterCallChat({ apiKey });
    async function timed(call) {
        if (ledger.spentUsd >= ledger.capUsd) {
            throw new Error(`Spending cap of $${ledger.capUsd} reached ($${ledger.spentUsd.toFixed(2)} spent) before a ${call.stage} call to ${call.model}`);
        }
        const startedAt = Date.now();
        try {
            const response = await direct({ ...call, costLimit: core.COST_LIMIT.benchmarkLedger });
            ledger.spentUsd += response.usage.cost;
            return { ...response, usage: { ...response.usage, seconds: (Date.now() - startedAt) / 1000 } };
        } catch (error) {
            if (error.usage) {
                if (typeof error.usage.cost === 'number') ledger.spentUsd += error.usage.cost;
                error.usage = { ...error.usage, seconds: (Date.now() - startedAt) / 1000 };
            }
            throw error;
        }
    }
    return core.makeCachedCallChat(timed, makeFileStore(cacheDirectory));
}

// The call path of run `runNumber` of a measurement. Run 1 uses firstCacheDirectory, which is shared, so
// measuring again replays it. Every later run keeps its model calls in its own directory under
// REPEATS_DIRECTORY, so an identical request is answered anew and a rerun of that run is free. name identifies
// the measurement, such as "consolidation-sonnet55"; run 2 is its "run1" directory.
function runCallChat({ apiKey, ledger, name, runNumber, firstCacheDirectory }) {
    if (!Number.isInteger(runNumber) || runNumber < 1) throw new Error(`runNumber must be a whole number from 1, not ${runNumber}`);
    const cacheDirectory = runNumber === 1 ? firstCacheDirectory : path.join(REPEATS_DIRECTORY, `${name}-run${runNumber - 1}`);
    return makeModelCallChat({ apiKey, ledger, cacheDirectory });
}

// The number of runs a measurement has after `repeats` more: --repeats=<n> on the command line, 0 when absent.
function readRepeats() {
    const repeats = readNumberArgument('repeats') ?? 0;
    if (!Number.isInteger(repeats) || repeats < 0) throw new Error('--repeats must be a whole number of runs');
    return repeats;
}

// Collects what each model call cost and how long it took, whether it ran now or was replayed from cache.
function makeMeter() {
    const calls = [];
    function add(stage, usage, failed) {
        if (!usage) return;
        calls.push({ stage, usd: usage.originalCost ?? usage.cost, seconds: usage.seconds ?? null,
            promptTokens: usage.promptTokens ?? 0, completionTokens: usage.completionTokens ?? 0, failed });
    }
    return {
        calls,
        wrap: callChat => async call => {
            try {
                const response = await callChat(call);
                add(call.stage, response.usage, false);
                return response;
            } catch (error) {
                add(call.stage, error.usage, true);
                throw error;
            }
        },
        // The measured totals of one stage: dollars, calls, and the mean and longest call latency.
        stage(stageKey) {
            const stageCalls = calls.filter(call => call.stage === stageKey);
            // A successful call always has its latency; a failed call has it unless an earlier version stored it.
            const untimed = stageCalls.filter(call => call.seconds === null);
            if (untimed.some(call => !call.failed)) throw new Error(`${untimed.length} ${stageKey} calls have no recorded latency`);
            const timed = stageCalls.filter(call => call.seconds !== null).map(call => call.seconds);
            const sum = values => values.reduce((total, value) => total + value, 0);
            return {
                usd: sum(stageCalls.map(call => call.usd)),
                calls: stageCalls.length,
                failedCalls: stageCalls.filter(call => call.failed).length,
                meanCallSeconds: timed.length ? sum(timed) / timed.length : 0,
                maxCallSeconds: timed.length ? Math.max(...timed) : 0,
                promptTokens: sum(stageCalls.map(call => call.promptTokens)),
                completionTokens: sum(stageCalls.map(call => call.completionTokens)),
            };
        },
    };
}

const FIXED_USAGE = Object.freeze({ promptTokens: 0, completionTokens: 0, cost: 0 });

// Runs the page pipeline on the thread. handlers maps each stage key (extract, consolidate, score) to MODEL or
// to a function returning that call's fixed response, or MODEL for that call.
async function runStages({ thread, config, handlers, modelCallChat, label }) {
    const callChat = async call => {
        const handler = handlers[call.stage];
        if (handler === undefined) throw new Error(`${label}: no handler for stage ${call.stage}`);
        const fixed = handler === MODEL ? MODEL : handler(call);
        if (fixed === MODEL) return modelCallChat(call);
        return { json: fixed, usage: FIXED_USAGE };
    };
    let lastLine = '';
    return core.runPipeline({
        thread,
        // The benchmarks measure the analysis, so the linked article's summary is left out.
        config: { ...config, budgetUsd: Number.MAX_SAFE_INTEGER, articleSummary: false },
        callChat,
        onProgress: update => {
            const line = `${label}: ${update.stage} ${update.done}/${update.total}`;
            if (line !== lastLine) process.stderr.write(line + '\n');
            lastLine = line;
        },
    });
}

// Fixed responses -----------------------------------------------------------

// Extraction: the pool candidates of the call's batch, in pool order.
function fixedCandidates(pool) {
    return call => ({ candidates: pool.filter(candidate => candidate.batchIndex === call.meta.batchIndex)
        .map(({ statementA, statementB, commentsA, commentsB }) => ({ statementA, statementB, commentsA, commentsB })) });
}

// Consolidation: the given axes.
function fixedAxes(axes) {
    return () => ({ axes: axes.map(({ statementA, statementB, candidates }) => ({ statementA, statementB, candidates })) });
}

// Consolidation for a run that only needs the extraction result: one axis that holds every candidate.
function oneAxisOfAllCandidates(call) {
    return { axes: [{ statementA: 'placeholder', statementB: 'placeholder',
        candidates: Array.from({ length: call.meta.candidateCount }, (unused, index) => index + 1) }] };
}

// Scoring: the stances of a table Map("commentId|axisId" -> "A" | "B" | "M"), the same in both passes.
function fixedStances(table) {
    return call => {
        const stances = [];
        call.meta.presentedAxes.forEach((axis, index) => {
            for (const commentId of call.meta.commentIds) {
                const stance = table.get(core.stanceKey(commentId, axis.id));
                if (stance !== undefined) stances.push({ comment: commentId, axis: index + 1, stance: call.meta.swapPoles ? core.flipStance(stance) : stance });
            }
        });
        return { stances };
    };
}

function noStances() {
    return { stances: [] };
}

// Reading results -----------------------------------------------------------

// The stances of a pipeline result in each axis's own orientation (rows put the larger side first):
// agreed = Map("commentId|axisId" -> stance both passes gave); unsure = Set of keys only one pass
// classified or the passes classified differently.
function stancesOfResult(result) {
    const axisById = new Map(result.axes.map(axis => [axis.id, axis]));
    const agreed = new Map();
    const unsure = new Set();
    for (const row of result.rows) {
        const axis = axisById.get(row.axisId);
        const flipped = row.statementA !== axis.statementA;
        if (flipped && row.statementA !== axis.statementB) throw new Error(`row ${row.axisId} matches neither statement of its axis`);
        const sides = flipped ? { A: row.commentIdsB, B: row.commentIdsA } : { A: row.commentIdsA, B: row.commentIdsB };
        for (const commentId of sides.A) agreed.set(core.stanceKey(commentId, row.axisId), 'A');
        for (const commentId of sides.B) agreed.set(core.stanceKey(commentId, row.axisId), 'B');
        for (const commentId of row.commentIdsM) agreed.set(core.stanceKey(commentId, row.axisId), 'M');
        for (const comment of row.unverifiedComments) unsure.add(core.stanceKey(comment.commentId, row.axisId));
    }
    for (const axis of result.unverifiedAxes) {
        for (const comment of axis.unverifiedComments) unsure.add(core.stanceKey(comment.commentId, axis.id));
    }
    return { agreed, unsure };
}

// Metrics -------------------------------------------------------------------

// Agreement is the harmonic mean of precision and recall, 0 when either is 0.
function agreementOf(precision, recall) {
    return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

// For each candidate number 1..count, the set of candidates that share an axis with it (itself excluded).
function companions(axes, candidateCount) {
    const sets = Array.from({ length: candidateCount + 1 }, () => new Set());
    for (const axis of axes) {
        for (const first of axis.candidates) {
            for (const second of axis.candidates) {
                if (first !== second) sets[first].add(second);
            }
        }
    }
    return sets;
}

// Consolidation agreement (B-cubed over candidates). A pair of candidates is "together" when both silver
// partitions put it in one axis, "apart" when neither does, and disputed otherwise; disputed pairs are not
// graded. Precision of a candidate: of the graded candidates the model put with it, the share that are
// together. Recall of a candidate: of the candidates that are together with it, the share the model put
// with it. Each is averaged over the candidates for which it is defined.
function consolidationAgreement(modelAxes, silverPartitions, candidateCount) {
    const model = companions(modelAxes, candidateCount);
    const [first, second] = silverPartitions.map(axes => companions(axes, candidateCount));
    const precisions = [];
    const recalls = [];
    for (let candidate = 1; candidate <= candidateCount; candidate += 1) {
        const together = [...first[candidate]].filter(other => second[candidate].has(other));
        const disputed = other => first[candidate].has(other) !== second[candidate].has(other);
        const graded = [...model[candidate]].filter(other => !disputed(other));
        if (graded.length > 0) precisions.push(graded.filter(other => first[candidate].has(other)).length / graded.length);
        if (together.length > 0) recalls.push(together.filter(other => model[candidate].has(other)).length / together.length);
    }
    const mean = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
    const precision = mean(precisions);
    const recall = mean(recalls);
    return { agreement: agreementOf(precision, recall), precision, recall };
}

// Scoring agreement over the cells (comment, axis) on which the silver models agree. Precision: of the
// stances the model gave on graded cells, the share equal to the silver stance. Recall: of the silver stances,
// the share the model gave. silver = { stances: Map(key -> stance), disputed: Set(key) }.
function scoringAgreement(modelAgreed, silver) {
    let given = 0;
    let correct = 0;
    for (const [key, stance] of modelAgreed) {
        if (silver.disputed.has(key)) continue;
        given += 1;
        if (silver.stances.get(key) === stance) correct += 1;
    }
    const precision = given === 0 ? 0 : correct / given;
    const recall = silver.stances.size === 0 ? 0 : correct / silver.stances.size;
    return { agreement: agreementOf(precision, recall), precision, recall, given, correct };
}

// The mean, lowest, and highest of one numeric field over runs; a run whose field is null is left out, and
// null is returned when every run's field is null.
function runSpread(runs, field) {
    const values = runs.map(run => run[field]).filter(value => value !== null && value !== undefined);
    if (values.some(value => !Number.isFinite(value))) throw new Error(`a run's ${field} is not a number`);
    if (values.length === 0) return null;
    return { mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length), lowest: Math.min(...values), highest: Math.max(...values), runs: values.length };
}

// A response that stays invalid or truncated after the pipeline's own splitting and repair has no usable output,
// which is a result graded 0. Any other error (network, spending cap) is rethrown and stops the measurement.
function failedGrade(error) {
    if (!(error instanceof core.InvalidResponseError || error instanceof core.TruncationError)) throw error;
    return { agreement: 0, precision: 0, recall: 0, failed: error.message.slice(0, FAILURE_MESSAGE_CHARS) };
}

// The mean, lowest, and highest of each field over runs, keyed by field.
function runSummary(runs, fields) {
    return Object.fromEntries(fields.map(field => [field, runSpread(runs, field)]));
}

function rounded(value) {
    return Number(value.toFixed(PRECISION_DIGITS));
}

// A share as a percentage with one decimal, as the benchmark scripts print it.
function percent(share) {
    return `${(share * 100).toFixed(1)}%`;
}

// Whole runs --------------------------------------------------------------------
// A whole run is the output of every stage of one configuration, as a pipeline result. It is graded against a
// reference, which is silver or another whole run. A reference has axes, stances, and disputed cells: for
// silver, the cells its two models do not agree on; for a whole run, the cells only one of its scoring passes
// gave a stance or its passes gave different stances. A run axis's comments are those with a counted stance on
// it; a reference axis's comments are those with a reference stance on it. The similarity of a run axis and a
// reference axis is the number of comments on both over the number on either, leaving out the run comments on
// the reference axis's disputed cells. A run axis and a reference axis are paired when each is the other's
// most similar axis and they share at least MIN_SHARED_COMMENTS comments. Similarity is used, not the bare
// count that scripts/silver.js pairs the two silver models' axes by, because one comment has stances on several
// axes, so a large axis shares comments with many small ones. The run's stances on a paired axis are then
// graded as the scoring role is graded: precision is the share of the stances given on undisputed cells that
// equal the reference stance, recall is the share of all reference stances given, and agreement is their
// harmonic mean, the F1 score. A reference stance on an unpaired reference axis counts as not given, and a
// stance on an unpaired run axis is not graded, so the grade also states how many axes were paired.
const MIN_SHARED_COMMENTS = 2;

// Pairs the run's axes with the reference's axes and grades the run's stances on the paired axes.
// run = { axes: [{ id }], agreed: Map("commentId|axisId" -> stance) }.
function gradeStancesAgainst(run, reference) {
    const table = silverStanceTable(reference);
    const runComments = new Map(run.axes.map(axis => [axis.id, new Map()]));
    for (const [key, stance] of run.agreed) {
        const { commentId, axisId } = core.parseStanceKey(key);
        if (!runComments.has(axisId)) throw new Error(`stance on comment ${commentId} names axis ${axisId}, which the run does not list`);
        runComments.get(axisId).set(commentId, stance);
    }
    const commentsByAxis = cells => {
        const sets = new Map(reference.axes.map(axis => [axis.id, new Set()]));
        for (const [commentId, axisId] of cells) sets.get(axisId).add(commentId);
        return sets;
    };
    const referenceComments = commentsByAxis(reference.stances);
    const disputedComments = commentsByAxis(reference.disputedCells);
    // The comments the two axes share, and that count over the count of comments on either axis. A run comment
    // on a disputed cell of the reference axis is on neither side of that division.
    const overlap = (runAxis, referenceAxis) => {
        const onReference = referenceComments.get(referenceAxis.id);
        const disputed = disputedComments.get(referenceAxis.id);
        let sharedComments = 0;
        let eitherComments = onReference.size;
        for (const commentId of runComments.get(runAxis.id).keys()) {
            if (onReference.has(commentId)) sharedComments += 1;
            else if (!disputed.has(commentId)) eitherComments += 1;
        }
        return { sharedComments, similarity: eitherComments === 0 ? 0 : sharedComments / eitherComments };
    };
    const bestMatch = (others, similarityTo) => others.reduce((best, other) => (similarityTo(other) > (best ? similarityTo(best) : 0) ? other : best), null);
    const translated = new Map();
    const pairs = [];
    for (const runAxis of run.axes) {
        const referenceAxis = bestMatch(reference.axes, other => overlap(runAxis, other).similarity);
        if (referenceAxis === null || bestMatch(run.axes, other => overlap(other, referenceAxis).similarity) !== runAxis) continue;
        const { sharedComments, similarity } = overlap(runAxis, referenceAxis);
        if (sharedComments < MIN_SHARED_COMMENTS) continue;
        // The run's statements can be in the opposite order: the order under which more stances equal the
        // reference stances is taken. A middle stance equals itself under both orders.
        let equalAsGiven = 0;
        let equalSwapped = 0;
        for (const [commentId, stance] of runComments.get(runAxis.id)) {
            const referenceStance = table.stances.get(core.stanceKey(commentId, referenceAxis.id));
            if (referenceStance === undefined) continue;
            if (referenceStance === stance) equalAsGiven += 1;
            if (referenceStance === core.flipStance(stance)) equalSwapped += 1;
        }
        const swapped = equalSwapped > equalAsGiven;
        for (const [commentId, stance] of runComments.get(runAxis.id)) {
            translated.set(core.stanceKey(commentId, referenceAxis.id), swapped ? core.flipStance(stance) : stance);
        }
        pairs.push({ runAxisId: runAxis.id, referenceAxisId: referenceAxis.id, sharedComments, similarity: rounded(similarity), swapped });
    }
    const { precision, recall, given, correct } = scoringAgreement(translated, table);
    const pairedReferenceAxes = new Set(pairs.map(pair => pair.referenceAxisId));
    const people = reference.rows.reduce((sum, row) => sum + row.people, 0);
    const pairedPeople = reference.rows.filter(row => pairedReferenceAxes.has(row.axisId)).reduce((sum, row) => sum + row.people, 0);
    return { agreement: rounded(agreementOf(precision, recall)), precision: rounded(precision), recall: rounded(recall), given, correct,
        referenceStances: reference.stances.length, axes: run.axes.length, pairedAxes: pairs.length, referenceAxes: reference.axes.length,
        pairedPeopleShare: rounded(people === 0 ? 0 : pairedPeople / people), pairs };
}

// What a whole run shows the reader, which needs no reference: its scored axes, the axes left out below the
// floor, the counted stances, and the rows the page does not mark "few people", the ones with enough people behind a
// count. Runs recorded before 2026-10-22 counted the rows outside "too few", a group decided by a 95% interval.
function wholeRunShape(result) {
    return { axes: result.axes.length, axesBelowFloor: result.stats.axesBelowFloor, stances: result.stats.agreedStances,
        rows: result.rows.length, rowsWithEnoughPeople: result.rows.filter(row => !core.hasFewPeople(row)).length };
}

// A whole run graded against a reference, with its shape.
function gradeWholeRun(result, reference) {
    const { agreed } = stancesOfResult(result);
    return { ...gradeStancesAgainst({ axes: result.axes, agreed }, reference), ...wholeRunShape(result) };
}

// The latency of a run's calls, by stage, as the page forecasts it: a stage takes at least its slowest call,
// and its calls run up to `concurrency` at once. null when a call has no recorded time, as calls made by
// scripts/run_node.js do not.
function runLatencySeconds(calls, concurrency) {
    if (calls.some(call => call.seconds === null)) return null;
    let total = 0;
    for (const stage of new Set(calls.map(call => call.stage))) {
        const seconds = calls.filter(call => call.stage === stage).map(call => call.seconds);
        total += Math.max(Math.max(...seconds), seconds.reduce((sum, value) => sum + value, 0) / concurrency);
    }
    return rounded(total);
}

// Judges ---------------------------------------------------------------------

const MATCH_SYSTEM_PROMPT = `You match candidate axes to reference axes. Both come from one Hacker News thread. The submission title is: "{title}".

An axis is a pair of incompatible statements, A and B, that answer the same question. The reference axes are the questions the thread argues about. Each candidate axis was extracted from one batch of the thread's comments.

A candidate matches a reference axis when its two statements answer the same question as the reference axis, in either order, or state a narrower facet, reason, example, or consequence of one side of that question, so that a commenter holding one side of the candidate would usually hold one particular side of the reference axis.

For each candidate, return the number of the one reference axis it matches best, or 0 when it matches none. Return exactly one entry per candidate, as JSON matching the schema and nothing else.`;
const MATCH_SCHEMA = { name: 'match_candidates', schema: { type: 'object', additionalProperties: false, required: ['matches'],
    properties: { matches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['candidate', 'axis'],
        properties: { candidate: { type: 'integer' }, axis: { type: 'integer' } } } } } } };

async function judgeCall(modelCallChat, silverModel, stage, systemPrompt, title, userContent, schema) {
    const call = { stage, model: silverModel.model, sampling: silverModel.sampling, reasoning: silverModel.reasoning, maxTokens: JUDGE_MAX_TOKENS,
        messages: [{ role: 'system', content: systemPrompt.replace('{title}', title) }, { role: 'user', content: userContent }], schema };
    return (await modelCallChat(call)).json;
}

// Each silver model matches the candidates to the reference axes. Returns, per candidate (index 0 is
// candidate 1), the axis id both models chose, 0 when both chose none, or null when they differ or either
// gave no valid answer.
async function matchCandidates({ modelCallChat, title, axes, candidates }) {
    const axisLines = axes.map((axis, index) => `${index + 1}. A: ${axis.statementA} | B: ${axis.statementB}`);
    const candidateLines = candidates.map((candidate, index) => `#${index + 1} A: ${candidate.statementA} | B: ${candidate.statementB}`);
    const userContent = `Reference axes:\n\n${axisLines.join('\n')}\n\nCandidates:\n\n${candidateLines.join('\n')}`;
    const answers = await Promise.all(SILVER_MODELS.map(async silverModel => {
        const json = await judgeCall(modelCallChat, silverModel, 'matchCandidates', MATCH_SYSTEM_PROMPT, title, userContent, MATCH_SCHEMA);
        const byCandidate = new Map();
        for (const match of json.matches || []) {
            if (Number.isInteger(match.candidate) && Number.isInteger(match.axis) && match.axis >= 0 && match.axis <= axes.length) byCandidate.set(match.candidate, match.axis);
        }
        return byCandidate;
    }));
    return candidates.map((candidate, index) => {
        const [first, second] = answers.map(byCandidate => byCandidate.get(index + 1));
        if (first === undefined || second === undefined || first !== second) return null;
        return first === 0 ? 0 : axes[first - 1].id;
    });
}

// Silver file -----------------------------------------------------------------

function readSilver() {
    if (!fs.existsSync(SILVER_FILE)) throw new Error(`${SILVER_FILE} not found; build it with: node scripts/silver.js --thread=<id>`);
    return JSON.parse(fs.readFileSync(SILVER_FILE, 'utf8'));
}

// The silver stances as scoringAgreement and fixedStances use them.
function silverStanceTable(silver) {
    return {
        stances: new Map(silver.stances.map(([commentId, axisId, stance]) => [core.stanceKey(commentId, axisId), stance])),
        disputed: new Set(silver.disputedCells.map(([commentId, axisId]) => core.stanceKey(commentId, axisId))),
    };
}

module.exports = {
    core, REPO_ROOT, SILVER_FILE, BENCHMARK_FILE, CACHE_DIRECTORY, SILVER_MODELS, MODEL,
    readArgument, readNumberArgument, requireApiKey, silverConfig, loadThread, checkSilverSnapshot, readKeyList, readStoredResults, writeStoredResults,
    makeModelCallChat, runCallChat, readRepeats, makeMeter, runStages,
    fixedCandidates, fixedAxes, oneAxisOfAllCandidates, fixedStances, noStances,
    stancesOfResult, agreementOf, consolidationAgreement, scoringAgreement, runSpread, runSummary, rounded, percent, failedGrade, FAILURE_MESSAGE_CHARS,
    wholeRunShape, gradeWholeRun, runLatencySeconds,
    matchCandidates, readSilver, silverStanceTable,
};
