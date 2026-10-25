// Builds the silver reference for one Hacker News thread: what the two silver models (SILVER_MODELS in
// silver_lib.js) agree on at each stage of the page pipeline. No person annotates anything.
// Usage: node scripts/silver.js --thread=22866284 [--budget=<usd>] [--concurrency=<calls>] [--key=sk-or-...]
// Steps, each on inputs shared by both models so that their outputs are comparable:
//   1. Each model extracts candidates. The pool is both models' candidates, batch by batch.
//   2. Each model consolidates the pool. A silver axis is a pair of axes, one per model, that are each
//      other's best match by shared candidates; it keeps the shared candidates.
//   3. Each model scores every comment against the silver axes. A silver stance is a stance both models
//      gave; a cell neither model gave any stance in any pass has no stance; every other cell is disputed.
//   4. The silver rows are the page's rows for the silver stances.
// Every model call is cached under outputs/silver/cache, so a rerun continues where the last run stopped.
// The result is written to data/silver.json.
const fs = require('node:fs');
const lib = require('./silver_lib');
const { runMain } = require('./load_core');

const { core, MODEL, SILVER_MODELS } = lib;
const DEFAULT_BUDGET_USD = 25;
const DEFAULT_CONCURRENCY = 16;

function sameStatements(left, right) {
    return left.statementA === right.statementA && left.statementB === right.statementB;
}

// Step 1. The pool: for each extraction batch in order, each model's candidates of that batch.
async function buildPool(thread, run) {
    const batches = core.makeExtractBatches(thread.comments, core.DEFAULT_CONFIG.extractBatchChars);
    const batchOfComment = new Map(batches.flatMap((batch, batchIndex) => batch.map(comment => [comment.id, batchIndex])));
    const perModel = await Promise.all(SILVER_MODELS.map(async silverModel => {
        const result = await run(silverModel, `extract ${silverModel.key}`, { extract: MODEL, consolidate: lib.oneAxisOfAllCandidates, score: lib.noStances });
        return result.candidates.map(candidate => {
            const batchIndexes = new Set([...candidate.commentsA, ...candidate.commentsB].map(commentId => batchOfComment.get(commentId)));
            if (batchIndexes.size > 1) throw new Error(`candidate "${candidate.statementA}" cites comments of ${batchIndexes.size} batches`);
            return { ...candidate, batchIndex: batchIndexes.size === 1 ? [...batchIndexes][0] : null, source: silverModel.key };
        });
    }));
    const withoutComments = perModel.flat().filter(candidate => candidate.batchIndex === null).length;
    const pool = batches.flatMap((batch, batchIndex) => perModel.flatMap(candidates => candidates.filter(candidate => candidate.batchIndex === batchIndex)));
    return { pool, withoutComments, extracted: Object.fromEntries(SILVER_MODELS.map((silverModel, index) => [silverModel.key, perModel[index].length])) };
}

// Step 2. Each model's axes over the pool, then the axes both models agree on.
async function buildAxes(thread, pool, run) {
    const commentsById = core.indexCommentsById(thread.comments);
    const partitions = await Promise.all(SILVER_MODELS.map(async silverModel => {
        const result = await run(silverModel, `consolidate ${silverModel.key}`, { extract: lib.fixedCandidates(pool), consolidate: MODEL, score: lib.noStances });
        if (result.candidates.length !== pool.length || !result.candidates.every((candidate, index) => sameStatements(candidate, pool[index]))) {
            throw new Error('the pipeline did not reproduce the pool in pool order');
        }
        return { axes: result.axes, axesBelowFloor: result.stats.axesBelowFloor };
    }));
    const [first, second] = partitions.map(partition => partition.axes);
    const shared = (left, right) => left.candidates.filter(number => right.candidates.includes(number));
    const bestMatch = (axis, others) => others.reduce((best, other) => (shared(axis, other).length > (best ? shared(axis, best).length : 0) ? other : best), null);
    const pairs = [];
    for (const axis of first) {
        const match = bestMatch(axis, second);
        if (match === null || bestMatch(match, first) !== axis) continue;
        const candidates = shared(axis, match);
        const people = core.axisPeople({ candidates }, pool, commentsById);
        if (people < core.MIN_AXIS_PEOPLE) continue;
        const union = new Set([...axis.candidates, ...match.candidates]).size;
        pairs.push({ candidates, people, jaccard: candidates.length / union, wordings: [axis, match] });
    }
    pairs.sort((left, right) => right.people - left.people || left.wordings[0].id - right.wordings[0].id);
    // The wording alternates between the two models, so neither model's phrasing dominates the reference.
    const axes = pairs.map((pair, index) => {
        const wording = pair.wordings[index % SILVER_MODELS.length];
        return { id: index + 1, statementA: wording.statementA, statementB: wording.statementB, candidates: pair.candidates,
            extractionPeople: pair.people, jaccard: pair.jaccard, wordingFrom: SILVER_MODELS[index % SILVER_MODELS.length].key };
    });
    const paired = new Set(pairs.flatMap(pair => pair.wordings));
    const disputedAxes = partitions.flatMap((partition, index) => partition.axes.filter(axis => !paired.has(axis))
        .map(axis => ({ model: SILVER_MODELS[index].key, statementA: axis.statementA, statementB: axis.statementB, candidates: axis.candidates,
            extractionPeople: core.axisPeople(axis, pool, commentsById) })));
    return { axes, disputedAxes, partitions };
}

// Step 3. Each model's stances on the silver axes, then the stances both models agree on.
async function buildStances(thread, pool, axes, run) {
    const perModel = await Promise.all(SILVER_MODELS.map(async silverModel => {
        const result = await run(silverModel, `score ${silverModel.key}`, { extract: lib.fixedCandidates(pool), consolidate: lib.fixedAxes(axes), score: MODEL });
        if (result.axes.length !== axes.length) throw new Error(`scoring saw ${result.axes.length} axes, not the ${axes.length} silver axes`);
        return lib.stancesOfResult(result);
    }));
    const [first, second] = perModel;
    const stances = [];
    const disputedCells = [];
    for (const key of new Set(perModel.flatMap(model => [...model.agreed.keys(), ...model.unsure]))) {
        const { commentId, axisId } = core.parseStanceKey(key);
        const stance = first.agreed.get(key);
        if (stance !== undefined && stance === second.agreed.get(key)) stances.push([commentId, axisId, stance]);
        else disputedCells.push([commentId, axisId]);
    }
    const byCell = (left, right) => left[1] - right[1] || left[0] - right[0];
    return { stances: stances.sort(byCell), disputedCells: disputedCells.sort(byCell),
        agreedPerModel: Object.fromEntries(SILVER_MODELS.map((silverModel, index) => [silverModel.key, perModel[index].agreed.size])) };
}

// Step 4. The rows of the silver stances. Every stage replays the reference, so no model is called.
async function buildRows(thread, pool, axes, silver, run) {
    const table = lib.silverStanceTable(silver).stances;
    const result = await run(SILVER_MODELS[0], 'rows', { extract: lib.fixedCandidates(pool), consolidate: lib.fixedAxes(axes), score: lib.fixedStances(table) });
    const rows = result.rows.map(row => ({ axisId: row.axisId, rank: row.rank, group: row.group, statementA: row.statementA, statementB: row.statementB,
        countA: row.countA, countB: row.countB, countM: row.countM, countC: row.countC, people: row.authors }));
    return { rows };
}

async function main() {
    const threadId = lib.readArgument('thread');
    if (!threadId || !core.isThreadId(threadId)) throw new Error('pass --thread=<numeric Hacker News item id>');
    const ledger = { spentUsd: 0, capUsd: lib.readNumberArgument('budget') ?? DEFAULT_BUDGET_USD };
    const concurrency = lib.readNumberArgument('concurrency') ?? DEFAULT_CONCURRENCY;
    const meter = lib.makeMeter();
    const modelCallChat = meter.wrap(lib.makeModelCallChat({ apiKey: lib.requireApiKey(), ledger, cacheDirectory: lib.CACHE_DIRECTORY }));
    const thread = await lib.loadThread(threadId);
    const run = (silverModel, label, handlers) => lib.runStages({ thread, config: { ...lib.silverConfig(silverModel), concurrency }, handlers, modelCallChat, label });

    const { pool, withoutComments, extracted } = await buildPool(thread, run);
    console.log(`pool: ${pool.length} candidates (${JSON.stringify(extracted)}; ${withoutComments} without comments left out); $${ledger.spentUsd.toFixed(2)} spent in this run`);
    const { axes, disputedAxes, partitions } = await buildAxes(thread, pool, run);
    console.log(`axes: ${axes.length} silver, ${disputedAxes.length} disputed; per model ${partitions.map(partition => partition.axes.length).join(' and ')}; $${ledger.spentUsd.toFixed(2)} spent in this run`);
    const { stances, disputedCells, agreedPerModel } = await buildStances(thread, pool, axes, run);
    console.log(`stances: ${stances.length} silver, ${disputedCells.length} disputed cells (${JSON.stringify(agreedPerModel)}); $${ledger.spentUsd.toFixed(2)} spent in this run`);
    const silver = {
        threadId: Number(threadId), title: thread.title, comments: thread.comments.length, chars: core.totalCommentChars(thread.comments),
        authors: new Set(thread.comments.map(comment => comment.author)).size,
        models: SILVER_MODELS.map(({ key, name, effort, model }) => ({ key, name, effort, model })),
        candidates: pool, partitions: Object.fromEntries(SILVER_MODELS.map((silverModel, index) => [silverModel.key, partitions[index].axes.map(axis => axis.candidates)])),
        axes, disputedAxes, stances, disputedCells,
    };
    Object.assign(silver, await buildRows(thread, pool, axes, silver, run));
    silver.cost = Object.fromEntries(core.STAGE_ORDER.map(stageKey => [stageKey, meter.stage(stageKey)]));
    silver.builtAt = new Date().toISOString();
    fs.writeFileSync(lib.SILVER_FILE, JSON.stringify(silver), 'utf8');
    const groups = {};
    for (const row of silver.rows) groups[row.group] = (groups[row.group] || 0) + 1;
    const totalUsd = core.STAGE_ORDER.reduce((sum, stageKey) => sum + silver.cost[stageKey].usd, 0);
    console.log(`rows: ${silver.rows.length} (${JSON.stringify(groups)})`);
    console.log(`wrote ${lib.SILVER_FILE}; the reference cost $${totalUsd.toFixed(2)} in all, $${ledger.spentUsd.toFixed(2)} of it in this run`);
}

runMain(main);
