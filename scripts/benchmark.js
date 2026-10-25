// Grades the page's model choices against the silver reference (data/silver.json, built by scripts/silver.js), and
// measures the summary choices' cost and time.
// One choice is one model setting in one role. In a staged role, only the role under test calls the choice's model;
// every other stage of the pipeline gets the silver reference as a fixed response, so no choice is measured in
// combination with another, and adding a model takes one run of this script. A summary choice summarizes the saved
// text of each page in SUMMARY_THREAD_IDS's links, as the page summarizes a linked page whose text it has, and is
// measured by the mean cost and time of one summary, with no grade.
// Usage: node scripts/benchmark.js --role=<summary|extraction|consolidation|scoring> --choice=<key>   one choice
//        node scripts/benchmark.js --choice=<key>     that key in every role that lists it
//        node scripts/benchmark.js --all              every listed choice without a result yet
//        node scripts/benchmark.js --embed            only copy data/silver-benchmark.json and data/summary-benchmark.json into the page
//        [--force] measure again a choice that has a result  [--budget=<usd>] [--concurrency=<calls>] [--key=sk-or-...]
//        [--repeats=<n>] also send each selected graded choice's identical request n more times; a choice that has
//                        a result keeps its first run unless --force is given. Summary choices are not repeated.
// Agreement is the harmonic mean of precision and recall against the reference:
//   extraction     precision: of the candidates both silver models place, the share they match to one silver
//                  axis. recall: the share of the people on silver axes whose axis got a matched candidate.
//   consolidation  B-cubed precision and recall of the choice's grouping of the silver candidate pool against
//                  the pairs of candidates both silver models group together or both keep apart.
//   scoring        precision: of the stances given on cells the silver models agree on, the share equal to the
//                  silver stance. recall: the share of the silver stances given.
// Each graded result also holds what the role's calls cost and how long they took. Two runs of one choice can differ
// by several points, so a choice can be run several times: its result then holds every run's grade in runs,
// its agreement, precision, and recall are the means, and its cost and latency stay those of the first run.
// Results go to data/silver-benchmark.json and data/summary-benchmark.json, and into the SILVER_BENCHMARK and
// SUMMARY_BENCHMARK constants of the page.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const lib = require('./silver_lib');
const { HTML_PATH, readPage, loadCore, runMain } = require('./load_core');

const { core, MODEL } = lib;
const DEFAULT_BUDGET_USD = 5;
// The roles graded against silver, and every role this script measures.
const GRADED_ROLES = core.STAGED_ROLES;
const ROLES = core.SELECTION_ROLES;
// The roles with a README table: the four roles of a run selection and the single call that replaces them.
const TABLE_ROLES = Object.freeze(Object.keys(core.ROLE_CHOICES));
const SINGLE_CALL_FILE = path.join(lib.REPO_ROOT, 'data', 'single-call-benchmark.json');
const SILVER_EMBED_PATTERN = /^const SILVER_BENCHMARK = .*$/m;
const SUMMARY_EMBED_PATTERN = /^const SUMMARY_BENCHMARK = .*$/m;
const README_PATH = path.join(__dirname, '..', 'README.md');
const README_START = '<!-- silver-benchmark:start -->';
const README_END = '<!-- silver-benchmark:end -->';
const README_TABLES_PATTERN = new RegExp(`${README_START}[\\s\\S]*${README_END}`);

// The summary benchmark: the threads whose linked pages each summary choice summarizes, chosen on 2026-10-25 from
// pages whose text Keenable's keyless endpoint returned, from about 4,000 to 50,000 characters. The page texts are
// kept out of git, because the pages belong to their publishers; the results record each page's length, and a
// measurement refuses page texts of other lengths.
const SUMMARY_FILE = path.join(lib.REPO_ROOT, 'data', 'summary-benchmark.json');
const SUMMARY_WORK_DIRECTORY = path.join(lib.REPO_ROOT, 'outputs', 'summary-benchmark');
const SUMMARY_THREAD_IDS = Object.freeze([22866284, 44163063, 29845208, 16582136, 47939579]);

function graded({ precision, recall }) {
    return { agreement: lib.rounded(lib.agreementOf(precision, recall)), precision: lib.rounded(precision), recall: lib.rounded(recall) };
}

// The measured cost and latency of the role's own calls.
function measured(meter, role) {
    const stage = meter.stage(core.STAGE_OF_ROLE[role]);
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
};

// The stage handlers of one role's run: the role's stage calls the model, the stages before it replay the
// silver reference, and the stages after it get the least that lets the pipeline finish.
function handlersFor(role, silver) {
    return {
        extraction: { extract: MODEL, consolidate: lib.oneAxisOfAllCandidates, score: lib.noStances },
        consolidation: { extract: lib.fixedCandidates(silver.candidates), consolidate: MODEL, score: lib.noStances },
        scoring: { extract: lib.fixedCandidates(silver.candidates), consolidate: lib.fixedAxes(silver.axes), score: MODEL },
    }[role];
}

// One run of a choice in a graded role, graded.
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
        axes: silver.axes.length, candidates: silver.candidates.length, stances: silver.stances.length };
    // Results of a role that is no longer graded, such as the summary's before it was measured on pages, are dropped.
    const stored = lib.readStoredResults(lib.BENCHMARK_FILE, silver) ?? {};
    const results = Object.fromEntries(GRADED_ROLES.map(role => [role, stored[role] ?? {}]));
    return { ...header, results };
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

// The summary benchmark's stored pages and results, or none yet.
function readSummaryBenchmark() {
    return fs.existsSync(SUMMARY_FILE) ? JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8')) : { pages: [], results: {} };
}

// The summary benchmark's pages: each thread of SUMMARY_THREAD_IDS with its linked page's text, which the first
// measurement fetches from Keenable's keyless endpoint and keeps under SUMMARY_WORK_DIRECTORY. A page whose kept
// text differs in length from the stored results' page is refused, so every result covers the same texts.
async function loadSummaryPages(storedPages) {
    const pagesDirectory = path.join(SUMMARY_WORK_DIRECTORY, 'pages');
    fs.mkdirSync(pagesDirectory, { recursive: true });
    const pages = [];
    for (const threadId of SUMMARY_THREAD_IDS) {
        const thread = await lib.loadThread(threadId);
        if (!thread.url) throw new Error(`thread ${threadId} links to no page`);
        const textFile = path.join(pagesDirectory, `${threadId}.txt`);
        if (!fs.existsSync(textFile)) {
            process.stderr.write(`Fetching the page of thread ${threadId} from Keenable\n`);
            fs.writeFileSync(textFile, await core.fetchKeenablePage(thread.url, null, globalThis.fetch), 'utf8');
        }
        const text = fs.readFileSync(textFile, 'utf8');
        const stored = storedPages.find(page => page.threadId === threadId);
        if (stored !== undefined && stored.chars !== text.length) {
            throw new Error(`${textFile} has ${text.length} characters, but the stored results summarized ${stored.chars}; restore that text or measure every summary choice again with --force`);
        }
        pages.push({ threadId, title: thread.title, url: thread.url, chars: text.length, thread, text });
    }
    return pages;
}

// One summary choice's summaries of every page: the mean cost and time of a valid summary, and how many summaries
// failed validation. A choice with no valid summary is a failed result.
async function measureSummaryChoice({ choiceKey, pages, modelCallChat }) {
    const config = { ...core.DEFAULT_CONFIG, ...core.roleConfig('summary', choiceKey) };
    const summaries = [];
    const failures = [];
    for (const page of pages) {
        const call = core.buildPageTextSummaryCall(config, page.thread, page.text);
        try {
            const response = await modelCallChat(call);
            const summary = core.parseArticleSummaryResponse(response.json);
            summaries.push({ usd: response.usage.originalCost ?? response.usage.cost, seconds: response.usage.seconds, fetched: summary.fetched });
        } catch (error) {
            failures.push(`thread ${page.threadId}: ${error.message}`);
        }
    }
    const mean = field => summaries.reduce((sum, summary) => sum + summary[field], 0) / summaries.length;
    const outcome = summaries.length === 0
        ? { failed: failures[0].slice(0, lib.FAILURE_MESSAGE_CHARS), failedSummaries: failures.length, measuredAt: new Date().toISOString() }
        : { usd: mean('usd'), seconds: lib.rounded(mean('seconds')), summaries: summaries.length, failedSummaries: failures.length,
            notFetched: summaries.filter(summary => !summary.fetched).length, measuredAt: new Date().toISOString() };
    const figuresPart = outcome.failed ? `FAILED: ${outcome.failed}` : `$${outcome.usd.toFixed(4)} and ${outcome.seconds} s per summary`;
    console.log(`summary ${choiceKey}: ${figuresPart}; ${summaries.length} of ${pages.length} summaries valid`);
    for (const failure of failures) console.log(`  failed ${failure}`);
    return outcome;
}

// Copies the results, with the single-call results, into the page's SILVER_BENCHMARK constant and the summary
// results into its SUMMARY_BENCHMARK constant, and regenerates the Content-Security-Policy hashes, which cover the
// inline script.
function embed(benchmark, summaryBenchmark, silver) {
    const html = readPage();
    if (!SILVER_EMBED_PATTERN.test(html)) throw new Error(`${HTML_PATH} has no SILVER_BENCHMARK constant to replace`);
    if (!SUMMARY_EMBED_PATTERN.test(html)) throw new Error(`${HTML_PATH} has no SUMMARY_BENCHMARK constant to replace`);
    const embedded = { ...benchmark, results: { ...benchmark.results, singleCall: singleCallResults(silver) } };
    fs.writeFileSync(HTML_PATH, html
        .replace(SILVER_EMBED_PATTERN, () => `const SILVER_BENCHMARK = Object.freeze(${JSON.stringify(embedded)});`)
        .replace(SUMMARY_EMBED_PATTERN, () => `const SUMMARY_BENCHMARK = Object.freeze(${JSON.stringify(summaryBenchmark)});`), 'utf8');
    execFileSync(process.execPath, [path.join(__dirname, 'csp.js'), '--write'], { stdio: 'inherit' });
    const count = [...Object.values(embedded.results), summaryBenchmark.results].reduce((sum, choices) => sum + Object.keys(choices).length, 0);
    console.log(`embedded ${count} results in ${HTML_PATH}`);
    writeReadmeTables();
}

// Rewrites the benchmark tables of the README, between its two marker comments, from the page that now
// holds the results, so the README shows what the pickers show.
function writeReadmeTables() {
    const page = loadCore();
    const tables = TABLE_ROLES.map(role => {
        const summary = role === 'summary';
        const rows = page.choicesByName(page.ROLE_CHOICES[role])
            .map(([key]) => {
                const cells = page.pickerCells(role, key);
                if (summary) return `| ${cells.model} | ${cells.effort} | ${cells.cost} | ${cells.latency} |`;
                const result = page.benchmarkResult(role, key);
                const gradedResult = result !== undefined && !result.failed;
                const runCount = gradedResult ? (result.runs ? result.runs.length : 1) : '';
                return `| ${cells.model} | ${cells.effort} | ${cells.cost} | ${cells.latency} | ${cells.agreement} | ${gradedResult ? page.percentText(result.precision) : ''} | ${gradedResult ? page.percentText(result.recall) : ''} | ${runCount} |`;
            });
        const header = summary
            ? ['| Model | Reasoning effort | Cost / summary | Latency / summary |', '| --- | --- | ---: | ---: |']
            : [`| Model | Reasoning effort | Cost / ${page.PICKER_COMMENTS} comments | Latency / ${page.PICKER_COMMENTS} comments | Agreement with silver | Precision | Recall | Runs |`,
                '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
        return [`### ${page.ROLE_TITLES[role]}`, '', ...header, ...rows].join('\n');
    });
    const readme = fs.readFileSync(README_PATH, 'utf8');
    if (!README_TABLES_PATTERN.test(readme)) throw new Error(`${README_PATH} has no ${README_START} and ${README_END} markers`);
    fs.writeFileSync(README_PATH, readme.replace(README_TABLES_PATTERN, () => `${README_START}\n${tables.join('\n\n')}\n${README_END}`), 'utf8');
    console.log(`rewrote the benchmark tables in ${README_PATH}`);
}

async function main() {
    const silver = lib.readSilver();
    const benchmark = readBenchmark(silver);
    const summaryBenchmark = readSummaryBenchmark();
    if (process.argv.includes('--embed')) {
        embed(benchmark, summaryBenchmark, silver);
        return;
    }
    const role = lib.readArgument('role');
    const choiceKey = lib.readArgument('choice');
    const force = process.argv.includes('--force');
    if (role !== null && !ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);
    if (!process.argv.includes('--all') && choiceKey === null) throw new Error('pass --choice=<key>, optionally with --role=<role>, or --all, or --embed');
    const resultsOf = taskRole => (taskRole === 'summary' ? summaryBenchmark.results : benchmark.results[taskRole]);
    const tasks = (role === null ? ROLES : [role]).flatMap(taskRole => Object.entries(core.ROLE_CHOICES[taskRole])
        // A router has no fixed model, so it has nothing to measure.
        .filter(([key, choice]) => !choice.unmeasured && (choiceKey === null || key === choiceKey))
        .filter(([key]) => force || choiceKey !== null || resultsOf(taskRole)[key] === undefined)
        .map(([key]) => ({ role: taskRole, choiceKey: key })));
    if (tasks.length === 0) throw new Error(choiceKey === null ? 'every listed choice already has a result; pass --force to measure again' : `no role lists the choice ${choiceKey}`);
    const repeats = lib.readRepeats();
    const ledger = { spentUsd: 0, capUsd: lib.readNumberArgument('budget') ?? DEFAULT_BUDGET_USD };
    const apiKey = lib.requireApiKey();
    const modelCallChat = lib.makeModelCallChat({ apiKey, ledger, cacheDirectory: lib.CACHE_DIRECTORY });
    const concurrency = lib.readNumberArgument('concurrency') ?? core.DEFAULT_CONFIG.concurrency;
    const gradedTasks = tasks.filter(task => task.role !== 'summary');
    const summaryTasks = tasks.filter(task => task.role === 'summary');
    const thread = gradedTasks.length > 0 ? await lib.loadThread(silver.threadId) : null;
    if (thread !== null) lib.checkSilverSnapshot(thread, silver);
    if (summaryTasks.length > 0) {
        const pages = await loadSummaryPages(summaryBenchmark.pages);
        summaryBenchmark.pages = pages.map(({ threadId, title, url, chars }) => ({ threadId, title, url, chars }));
        const summaryCallChat = lib.makeModelCallChat({ apiKey, ledger, cacheDirectory: path.join(SUMMARY_WORK_DIRECTORY, 'cache') });
        // Summary choices run one after another; each result is saved as it arrives.
        for (const task of summaryTasks) {
            summaryBenchmark.results[task.choiceKey] = await measureSummaryChoice({ choiceKey: task.choiceKey, pages, modelCallChat: summaryCallChat });
            lib.writeStoredResults(SUMMARY_FILE, summaryBenchmark);
        }
    }
    // Choices run one after another per role and the roles run side by side; each result is saved as it arrives.
    await Promise.all(GRADED_ROLES.map(async taskRole => {
        for (const task of gradedTasks.filter(item => item.role === taskRole)) {
            const existing = benchmark.results[task.role][task.choiceKey];
            const first = repeats > 0 && existing !== undefined && !force ? existing : await benchmarkChoice({ ...task, silver, thread, modelCallChat, concurrency });
            benchmark.results[task.role][task.choiceKey] = repeats > 0 ? await withRepeats({ ...task, first, repeats, silver, thread, apiKey, ledger, concurrency }) : first;
            lib.writeStoredResults(lib.BENCHMARK_FILE, benchmark);
        }
    }));
    // Written even when no graded choice ran, so the file drops the results of a role that is no longer graded.
    lib.writeStoredResults(lib.BENCHMARK_FILE, benchmark);
    console.log(`wrote the results; $${ledger.spentUsd.toFixed(2)} spent in this run`);
    embed(benchmark, summaryBenchmark, silver);
}

runMain(main);
