// Grades the page's model choices against the silver reference (data/silver.json, built by scripts/silver.js).
// One choice is one model setting in one role. Only the role under test calls the choice's model; every other
// stage of the pipeline gets the silver reference as a fixed response, so no choice is measured in combination
// with another, and adding a model takes one run of this script.
// Usage: node scripts/benchmark.js --role=<extraction|consolidation|scoring|summary> --choice=<key>   one choice
//        node scripts/benchmark.js --choice=<key>     that key in every role that lists it
//        node scripts/benchmark.js --all              every listed choice without a result yet
//        node scripts/benchmark.js --embed            only copy data/silver-benchmark.json into the page
//        [--force] measure again a choice that has a result  [--budget=<usd>] [--concurrency=<calls>] [--key=sk-or-...]
//        [--repeats=<n>] also send each selected choice's identical request n more times; a choice that has a
//                        result keeps its first run unless --force is given
// Agreement is the harmonic mean of precision and recall against the reference:
//   extraction     precision: of the candidates both silver models place, the share they match to one silver
//                  axis. recall: the share of the people on silver axes whose axis got a matched candidate.
//   consolidation  B-cubed precision and recall of the choice's grouping of the silver candidate pool against
//                  the pairs of candidates both silver models group together or both keep apart.
//   scoring        precision: of the stances given on cells the silver models agree on, the share equal to the
//                  silver stance. recall: the share of the silver stances given.
//   summary        precision: of the cited sides both silver models judge alike, the share judged faithful
//                  to the evidence. recall: the share of the featured axes (cited by both silver summaries)
//                  the summary cites.
// Each result also holds what the role's calls cost and how long they took. Two runs of one choice can differ
// by several points, so a choice can be run several times: its result then holds every run's grade in runs,
// its agreement, precision, and recall are the means, and its cost and latency stay those of the first run.
// Results go to
// data/silver-benchmark.json and into the SILVER_BENCHMARK constant of the page.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const lib = require('./silver_lib');
const { HTML_PATH, loadCore } = require('./load_core');

const { core, MODEL } = lib;
const DEFAULT_BUDGET_USD = 5;
const ROLES = Object.freeze(['extraction', 'consolidation', 'scoring', 'summary']);
// The roles with a README table: the four stage roles and the single call that replaces the first three.
const TABLE_ROLES = Object.freeze([...ROLES, 'singleCall']);
const TABLE_TITLES = Object.freeze({ extraction: 'Extraction', consolidation: 'Consolidation', scoring: 'Scoring', summary: 'Summary', singleCall: 'One-pass analysis' });
const SINGLE_CALL_FILE = path.join(lib.REPO_ROOT, 'data', 'single-call-benchmark.json');
const ROLE_STAGE = Object.freeze({ extraction: 'extract', consolidation: 'consolidate', scoring: 'score', summary: 'synthesize' });
const EMBED_PATTERN = /^const SILVER_BENCHMARK = .*$/m;
const README_PATH = path.join(__dirname, '..', 'README.md');
const README_START = '<!-- silver-benchmark:start -->';
const README_END = '<!-- silver-benchmark:end -->';
const README_TABLES_PATTERN = new RegExp(`${README_START}[\\s\\S]*${README_END}`);

function roleChoices(role) {
    return { extraction: core.VOLUME_MODELS, consolidation: core.CONSOLIDATION_MODELS, scoring: core.VOLUME_MODELS, summary: core.SUMMARY_MODELS }[role];
}

function graded({ precision, recall }) {
    return { agreement: lib.rounded(lib.agreementOf(precision, recall)), precision: lib.rounded(precision), recall: lib.rounded(recall) };
}

// The measured cost and latency of the role's own calls.
function measured(meter, role) {
    const stage = meter.stage(ROLE_STAGE[role]);
    return { usd: stage.usd, calls: stage.calls, failedCalls: stage.failedCalls, meanCallSeconds: lib.rounded(stage.meanCallSeconds),
        maxCallSeconds: lib.rounded(stage.maxCallSeconds), promptTokens: stage.promptTokens, completionTokens: stage.completionTokens };
}

const GRADERS = {
    async extraction({ result, silver, thread, judgeCallChat }) {
        const candidates = result.candidates;
        const matches = await lib.matchCandidates({ modelCallChat: judgeCallChat, title: thread.title, axes: silver.axes, candidates });
        const matched = matches.filter(axisId => axisId !== null && axisId !== 0);
        const unmatched = matches.filter(axisId => axisId === 0).length;
        const found = new Set(matched);
        const people = silver.rows.reduce((sum, row) => sum + row.people, 0);
        const foundPeople = silver.rows.filter(row => found.has(row.axisId)).reduce((sum, row) => sum + row.people, 0);
        return { ...graded({ precision: matched.length + unmatched === 0 ? 0 : matched.length / (matched.length + unmatched), recall: people === 0 ? 0 : foundPeople / people }),
            candidates: candidates.length, matched: matched.length, unmatched, disputed: matches.filter(axisId => axisId === null).length, axesFound: found.size };
    },
    async consolidation({ result, silver }) {
        const partitions = Object.values(silver.partitions).map(partition => partition.map(candidates => ({ candidates })));
        return { ...graded(lib.consolidationAgreement(result.axes, partitions, silver.candidates.length)),
            candidates: silver.candidates.length, axes: result.axes.length, axesBelowFloor: result.stats.axesBelowFloor };
    },
    async scoring({ result, silver }) {
        const { agreed } = lib.stancesOfResult(result);
        const { precision, recall, given, correct } = lib.scoringAgreement(agreed, lib.silverStanceTable(silver));
        return { ...graded({ precision, recall }), given, correct, silverStances: silver.stances.length, axes: silver.axes.length };
    },
    async summary({ result, silver, thread, judgeCallChat }) {
        // The pipeline keeps the comparisons when the summary fails. A summary whose output stayed invalid is a
        // result; a call that got no output (refused request, network error) is not.
        if (!result.synthesis && !result.synthesisFailure) throw new Error(`summary call failed: ${result.synthesisError}`);
        if (!result.synthesis) return { agreement: 0, precision: 0, recall: 0, failed: result.synthesisError.slice(0, lib.FAILURE_MESSAGE_CHARS) };
        const commentsById = core.indexCommentsById(thread.comments);
        const evidenceContent = core.buildSynthesisMessages(thread.title, result.rows, commentsById)[1].content;
        const verdicts = [...(await lib.checkSummary({ modelCallChat: judgeCallChat, title: thread.title, evidenceContent, synthesis: result.synthesis })).values()];
        const faithful = verdicts.filter(verdict => verdict === true).length;
        const unfaithful = verdicts.filter(verdict => verdict === false).length;
        const cited = new Set(lib.summaryMarkers(result.synthesis).map(marker => marker.axisId));
        const featuredCited = silver.featuredAxes.filter(axisId => cited.has(axisId)).length;
        return { ...graded({ precision: faithful + unfaithful === 0 ? 0 : faithful / (faithful + unfaithful), recall: silver.featuredAxes.length === 0 ? 0 : featuredCited / silver.featuredAxes.length }),
            markers: verdicts.length, faithful, unfaithful, disputed: verdicts.filter(verdict => verdict === null).length, featuredCited, featured: silver.featuredAxes.length };
    },
};

// The stage handlers of one role's run: the role's stage calls the model, the stages before it replay the
// silver reference, and the stages after it get the least that lets the pipeline finish.
function handlersFor(role, silver) {
    const table = lib.silverStanceTable(silver).stances;
    return {
        extraction: { extract: MODEL, consolidate: lib.oneAxisOfAllCandidates, score: lib.noStances, synthesize: lib.noSummary },
        consolidation: { extract: lib.fixedCandidates(silver.candidates), consolidate: MODEL, score: lib.noStances, synthesize: lib.noSummary },
        scoring: { extract: lib.fixedCandidates(silver.candidates), consolidate: lib.fixedAxes(silver.axes), score: MODEL, synthesize: lib.noSummary },
        summary: { extract: lib.fixedCandidates(silver.candidates), consolidate: lib.fixedAxes(silver.axes), score: lib.fixedStances(table), synthesize: MODEL },
    }[role];
}

// One run of a choice in a role, graded.
async function gradeChoice({ role, choiceKey, silver, thread, modelCallChat, judgeCallChat, concurrency, label }) {
    try {
        const result = await lib.runStages({ thread, config: { ...core.roleConfig(role, choiceKey), concurrency }, handlers: handlersFor(role, silver), modelCallChat, label });
        return await GRADERS[role]({ result, silver, thread, judgeCallChat });
    } catch (error) {
        return lib.failedGrade(error);
    }
}

async function benchmarkChoice({ role, choiceKey, silver, thread, modelCallChat, concurrency }) {
    const label = `${role} ${choiceKey}`;
    const meter = lib.makeMeter();
    const judgeMeter = lib.makeMeter();
    const grade = await gradeChoice({ role, choiceKey, silver, thread, modelCallChat: meter.wrap(modelCallChat), judgeCallChat: judgeMeter.wrap(modelCallChat), concurrency, label });
    const judgeUsd = judgeMeter.calls.reduce((sum, call) => sum + call.usd, 0);
    const outcome = { ...grade, ...measured(meter, role), judgeUsd, measuredAt: new Date().toISOString() };
    console.log(`${label}: agreement ${lib.percent(outcome.agreement)} (precision ${lib.percent(outcome.precision)}, recall ${lib.percent(outcome.recall)}), $${outcome.usd.toFixed(4)}, ${outcome.calls} calls, mean ${outcome.meanCallSeconds} s${outcome.failed ? `, FAILED: ${outcome.failed}` : ''}`);
    return outcome;
}

// Sends the choice's identical request `repeats` more times and returns the result with every run's grade
// in runs, the first run first, and the means as its agreement, precision, and recall. Each repeat keeps
// its model calls in its own directory, so the request is answered anew and a rerun of the repeat is free.
// A repeat whose output stays invalid counts as a run with no agreement.
async function withRepeats({ first, role, choiceKey, repeats, silver, thread, apiKey, ledger, concurrency }) {
    if (first.failed) return first;
    const gradeOf = ({ agreement, precision, recall }) => ({ agreement, precision, recall });
    const runs = [first.runs ? first.runs[0] : gradeOf(first)];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const label = `${role} ${choiceKey} repeat ${repeat}`;
        const modelCallChat = lib.runCallChat({ apiKey, ledger, name: `${role}-${choiceKey}`, runNumber: repeat + 1, firstCacheDirectory: lib.CACHE_DIRECTORY });
        const grade = await gradeChoice({ role, choiceKey, silver, thread, modelCallChat, judgeCallChat: modelCallChat, concurrency, label });
        runs.push(gradeOf(grade));
        console.log(`${label}: agreement ${lib.percent(grade.agreement)}`);
    }
    const mean = field => lib.runSpread(runs, field).mean;
    return { ...first, agreement: mean('agreement'), precision: mean('precision'), recall: mean('recall'), runs };
}

function readBenchmark(silver) {
    const header = { threadId: silver.threadId, title: silver.title, comments: silver.comments, chars: silver.chars, authors: silver.authors,
        silverModels: silver.models.map(model => `${model.name} (${model.effort})`), silverBuiltAt: silver.builtAt,
        axes: silver.axes.length, candidates: silver.candidates.length, stances: silver.stances.length, featuredAxes: silver.featuredAxes.length };
    const results = lib.readStoredResults(lib.BENCHMARK_FILE, silver) ?? Object.fromEntries(ROLES.map(role => [role, {}]));
    return { ...header, results };
}

function writeBenchmark(benchmark) {
    fs.writeFileSync(lib.BENCHMARK_FILE, JSON.stringify(benchmark, null, 1) + '\n', 'utf8');
}

// The single-call results of scripts/single_call.js for the page's single-call choices, in the shape of a role's
// results: the one-request variant's mean F1 against silver, its runs, and its mean cost and latency on the
// benchmark thread.
function singleCallResults(silver) {
    const results = lib.readStoredResults(SINGLE_CALL_FILE, silver);
    if (results === null) throw new Error(`${SINGLE_CALL_FILE} is missing or was graded against another build of silver`);
    return Object.fromEntries(Object.keys(core.SINGLE_CALL_MODELS).filter(key => results[key] !== undefined).map(key => {
        const variant = results[key].oneCall;
        return [key, { agreement: variant.agreement.mean, precision: variant.precision.mean, recall: variant.recall.mean,
            runs: variant.runs.map(({ agreement, precision, recall }) => ({ agreement, precision, recall })),
            usd: variant.usd.mean, seconds: variant.seconds.mean, calls: 1 }];
    }));
}

// Copies the results, with the single-call results, into the page's SILVER_BENCHMARK constant and regenerates
// the Content-Security-Policy hashes, which cover the inline script.
function embed(benchmark, silver) {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    if (!EMBED_PATTERN.test(html)) throw new Error(`${HTML_PATH} has no SILVER_BENCHMARK constant to replace`);
    const embedded = { ...benchmark, results: { ...benchmark.results, singleCall: singleCallResults(silver) } };
    fs.writeFileSync(HTML_PATH, html.replace(EMBED_PATTERN, () => `const SILVER_BENCHMARK = Object.freeze(${JSON.stringify(embedded)});`), 'utf8');
    execFileSync(process.execPath, [path.join(__dirname, 'csp.js'), '--write'], { stdio: 'inherit' });
    console.log(`embedded ${Object.values(embedded.results).reduce((sum, choices) => sum + Object.keys(choices).length, 0)} results in ${HTML_PATH}`);
    writeReadmeTables();
}

// Rewrites the benchmark tables of the README, between its two marker comments, from the page that now
// holds the results, so the README shows what the pickers show.
function writeReadmeTables() {
    const page = loadCore();
    const percent = share => `${Math.round(share * 100)}%`;
    const tables = TABLE_ROLES.map(role => {
        const rows = Object.keys(page.ROLE_CHOICES[role])
            .sort((left, right) => page.modelDisplayName(page.roleChoice(role, left)).localeCompare(page.modelDisplayName(page.roleChoice(role, right)), 'en', { numeric: true, sensitivity: 'base' }))
            .map(key => {
                const cells = page.pickerCells(role, key);
                const result = page.benchmarkResult(role, key);
                const graded = result !== undefined && !result.failed;
                const runCount = graded ? (result.runs ? result.runs.length : 1) : '';
                return `| ${cells.model} | ${cells.effort} | ${cells.cost} | ${cells.latency} | ${cells.agreement} | ${graded ? percent(result.precision) : ''} | ${graded ? percent(result.recall) : ''} | ${runCount} |`;
            });
        return [`### ${TABLE_TITLES[role]}`, '', `| Model | Reasoning effort | Cost / ${page.PICKER_COMMENTS} comments | Latency / ${page.PICKER_COMMENTS} comments | Agreement with silver | Precision | Recall | Runs |`,
            '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
    });
    const readme = fs.readFileSync(README_PATH, 'utf8');
    if (!README_TABLES_PATTERN.test(readme)) throw new Error(`${README_PATH} has no ${README_START} and ${README_END} markers`);
    fs.writeFileSync(README_PATH, readme.replace(README_TABLES_PATTERN, () => `${README_START}\n${tables.join('\n\n')}\n${README_END}`), 'utf8');
    console.log(`rewrote the benchmark tables in ${README_PATH}`);
}

async function main() {
    const silver = lib.readSilver();
    const benchmark = readBenchmark(silver);
    if (process.argv.includes('--embed')) {
        embed(benchmark, silver);
        return;
    }
    const role = lib.readArgument('role');
    const choiceKey = lib.readArgument('choice');
    const force = process.argv.includes('--force');
    if (role !== null && !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
    if (!process.argv.includes('--all') && choiceKey === null) throw new Error('pass --choice=<key>, optionally with --role=<role>, or --all, or --embed');
    const tasks = (role === null ? ROLES : [role]).flatMap(taskRole => Object.entries(roleChoices(taskRole))
        // A router has no fixed model, so it has nothing to measure.
        .filter(([key, choice]) => !choice.unmeasured && (choiceKey === null || key === choiceKey))
        .filter(([key]) => force || choiceKey !== null || benchmark.results[taskRole][key] === undefined)
        .map(([key]) => ({ role: taskRole, choiceKey: key })));
    if (tasks.length === 0) throw new Error(choiceKey === null ? 'every listed choice already has a result; pass --force to measure again' : `no role lists the choice ${choiceKey}`);
    const repeats = lib.readRepeats();
    const ledger = { spentUsd: 0, capUsd: Number(lib.readArgument('budget') ?? DEFAULT_BUDGET_USD) };
    const apiKey = lib.requireApiKey();
    const modelCallChat = lib.makeModelCallChat({ apiKey, ledger, cacheDirectory: lib.CACHE_DIRECTORY });
    const thread = await lib.loadThread(silver.threadId);
    lib.checkSilverSnapshot(thread, silver);
    const concurrency = Number(lib.readArgument('concurrency') ?? core.DEFAULT_CONFIG.concurrency);
    // Choices run one after another per role and the roles run side by side; each result is saved as it arrives.
    await Promise.all(ROLES.map(async taskRole => {
        for (const task of tasks.filter(item => item.role === taskRole)) {
            const existing = benchmark.results[task.role][task.choiceKey];
            const first = repeats > 0 && existing !== undefined && !force ? existing : await benchmarkChoice({ ...task, silver, thread, modelCallChat, concurrency });
            benchmark.results[task.role][task.choiceKey] = repeats > 0 ? await withRepeats({ ...task, first, repeats, silver, thread, apiKey, ledger, concurrency }) : first;
            writeBenchmark(benchmark);
        }
    }));
    console.log(`wrote ${lib.BENCHMARK_FILE}; $${ledger.spentUsd.toFixed(2)} spent in this run`);
    embed(benchmark, silver);
}

main().catch(error => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
});
