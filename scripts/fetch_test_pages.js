'use strict';

// The pages that tests of page fetching use: a page that a site's bot protection, a paywall, a login wall, or
// a script-rendered body keeps from a plain fetch. Each entry names the page, what it tests, and the results
// recorded so far with their dates and sources; a page with no recorded result says so. The results come from
// the code comment above ARTICLE_FETCH_ENGINE in orange_skin.html and from earlier chats of this repository
// (transcripts under ~/.claude/projects/c--dfc-gh-orange-split, read 2026-11-10).

const FETCH_TEST_PAGES = Object.freeze([
    Object.freeze({
        name: 'Reuters, DeepSeek ban',
        kind: 'news article behind bot protection',
        url: 'https://www.reuters.com/technology/us-banning-chinese-ai-deepseek-government-agency-it-systems-2026-10-19/',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 200, 3346 characters, 0.5 s',
            exa: 'did not read the page, 772 prompt tokens, $0.0024, 9.1 s',
            openrouter: 'did not read the page, 774 prompt tokens, $0.0023, 2.0 s',
            firecrawl: 'read the page, 4162 prompt tokens, $0.0149, 5.4 s',
            parallel: 'did not read the page, 973 prompt tokens, $0.0040, 2.6 s',
            native: 'did not read the page, 774 prompt tokens, $0.0023, 3.2 s',
        }),
        tests: 'DataDome bot protection: curl from Windows 10 got HTTP 401 with "x-datadome: protected"',
        recorded: Object.freeze([
            '2026-10-21 OpenRouter engines, GPT-6 Sol low: exa reported no content; openrouter, parallel, and native reported HTTP 401; firecrawl returned the article ($0.0110 with its $0.0025 fetch fee)',
            '2026-10-21 Keenable keyless fetch: whole article, 396 words; live=true answered 403',
        ]),
    }),
    Object.freeze({
        name: 'Economist, what the Fuhrer means for Germans today',
        kind: 'paywalled article behind Cloudflare',
        url: 'https://www.economist.com/christmas-specials/2015/12/16/what-the-fuhrer-means-for-germans-today',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 200, 3418 characters, 10.4 s',
            exa: 'did not read the page, 2058 prompt tokens, $0.0075, 4.0 s',
            openrouter: 'did not read the page, 792 prompt tokens, $0.0024, 2.3 s',
            firecrawl: 'did not read the page, 2039 prompt tokens, $0.0088, 19.2 s',
            parallel: 'did not read the page, 951 prompt tokens, $0.0039, 5.6 s',
            native: 'did not read the page, 792 prompt tokens, $0.0024, 2.0 s',
        }),
        tests: 'Cloudflare challenge (curl got HTTP 403, "cf-mitigated: challenge") and a subscription wall',
        recorded: Object.freeze([
            '2026-10-21 OpenRouter engines: openrouter and native reported HTTP 403; exa, firecrawl, and parallel got past Cloudflare but read only the headline and opening paragraph, or no article text',
            '2026-10-21 Keenable keyless fetch: teaser only, 290 words of a 14-minute article; live=true answered 403',
        ]),
    }),
    Object.freeze({
        name: 'archive.vn snapshot of the Economist article',
        kind: 'web archive snapshot',
        url: 'https://archive.vn/20240501171714/https://www.economist.com/christmas-specials/2015/12/16/what-the-fuhrer-means-for-germans-today',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 403, 464 characters, 9.7 s',
            exa: 'did not read the page, 828 prompt tokens, $0.0025, 9.8 s',
            openrouter: 'did not read the page, 822 prompt tokens, $0.0027, 32.2 s',
            firecrawl: 'did not read the page, 975 prompt tokens, $0.0054, 3.8 s',
            parallel: 'did not read the page, 824 prompt tokens, $0.0025, 32.8 s',
            native: 'did not read the page, 822 prompt tokens, $0.0025, 32.0 s',
        }),
        tests: 'an archive snapshot as a way around a paywall; curl got HTTP 429 and a reCAPTCHA page',
        recorded: Object.freeze([
            '2026-10-21 OpenRouter engines: exa returned no content; firecrawl returned the captcha page; parallel HTTP 429; openrouter and native HTTP 522',
            'Keenable: not tested',
        ]),
    }),
    Object.freeze({
        name: 'Twitter, Craig Mod on Google results',
        kind: 'Twitter status',
        url: 'https://twitter.com/craigmod/status/1219644556003565568',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 200, 1581 characters, 4.3 s',
            exa: 'did not read the page, 720 prompt tokens, $0.0023, 2.4 s',
            openrouter: 'did not read the page, 722 prompt tokens, $0.0022, 1.9 s',
            firecrawl: 'read the page, 1243 prompt tokens, $0.0061, 7.6 s',
            parallel: 'read the page, 1216 prompt tokens, $0.0046, 13.0 s',
            native: 'did not read the page, 722 prompt tokens, $0.0023, 2.5 s',
        }),
        tests: 'a Twitter status as a thread link (Hacker News story 22107823)',
        recorded: Object.freeze([
            'Keenable keyless fetch (transcript of the 2026 Keenable test of 42 stories): 1366 characters',
            'OpenRouter engines: not tested',
        ]),
    }),
    Object.freeze({
        name: 'Twitter, Andrej Karpathy leaves Tesla',
        kind: 'Twitter status',
        url: 'https://twitter.com/karpathy/status/1547332300186066944',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 200, 1200 characters, 4.0 s',
            exa: 'did not read the page, 718 prompt tokens, $0.0021, 2.6 s',
            openrouter: 'did not read the page, 720 prompt tokens, $0.0021, 2.8 s',
            firecrawl: 'read the page, 1537 prompt tokens, $0.0080, 11.2 s',
            parallel: 'read the page, 1207 prompt tokens, $0.0049, 16.4 s',
            native: 'did not read the page, 720 prompt tokens, $0.0021, 2.0 s',
        }),
        tests: 'a Twitter status as a thread link (Hacker News story 32089013)',
        recorded: Object.freeze([
            'no result recorded',
        ]),
    }),
    Object.freeze({
        name: 'Reddit, Hacker reverse engineers his Samsung TV',
        kind: 'Reddit post',
        url: 'https://www.reddit.com/r/antiai/comments/1xdv3e5/hacker_reverse_engineers_his_samsung_tv_and_finds/',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 200, 4675 characters, 4.4 s',
            exa: 'did not read the page, 782 prompt tokens, $0.0024, 2.5 s',
            openrouter: 'did not read the page, 4249 prompt tokens, $0.0113, 2.4 s',
            firecrawl: 'did not read the page, 782 prompt tokens, $0.0024, 2.4 s',
            parallel: 'read the page, 11701 prompt tokens, $0.0317, 8.9 s',
            native: 'did not read the page, 4229 prompt tokens, $0.0112, 2.2 s',
        }),
        tests: 'a Reddit post as a thread link (Hacker News story 50218633)',
        recorded: Object.freeze([
            '2026-10-24 Keenable keyless fetch of this URL, saved as reddit.txt: 12264 bytes, used as pasted page text for a summary',
        ]),
    }),
    Object.freeze({
        name: 'Reddit, CrowdStrike update Windows bluescreen (old.reddit.com)',
        kind: 'Reddit post',
        url: 'https://old.reddit.com/r/crowdstrike/comments/1e6vmkf/bsod_error_in_latest_crowdstrike_update/',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 422, 392 characters, 29.6 s',
            exa: 'did not read the page, 784 prompt tokens, $0.0023, 1.9 s',
            openrouter: 'did not read the page, 820 prompt tokens, $0.0025, 2.6 s',
            firecrawl: 'did not read the page, 784 prompt tokens, $0.0024, 2.3 s',
            parallel: 'did not read the page, 963 prompt tokens, $0.0037, 16.2 s',
            native: 'did not read the page, 820 prompt tokens, $0.0025, 2.1 s',
        }),
        tests: 'old.reddit.com as a thread link (Hacker News story 41002195)',
        recorded: Object.freeze([
            'Keenable keyless fetch: HTTP 422',
        ]),
    }),
    Object.freeze({
        name: 'Reddit, Apollo will close down on June 30th (old.reddit.com)',
        kind: 'Reddit post',
        url: 'https://old.reddit.com/r/apolloapp/comments/144f6xm/apollo_will_close_down_on_june_30th_reddits/',
        // Engine results of 2026-11-10: the page's article summary call once per web fetch engine, GPT-6 Sol low, and one Keenable keyless fetch.
        engineResults: Object.freeze({
            keenable: 'HTTP 422, 392 characters, 24.9 s',
            exa: 'did not read the page, 798 prompt tokens, $0.0024, 2.2 s',
            openrouter: 'did not read the page, 834 prompt tokens, $0.0025, 2.3 s',
            firecrawl: 'did not read the page, 798 prompt tokens, $0.0024, 2.4 s',
            parallel: 'read the page, 35315 prompt tokens, $0.0915, 10.1 s',
            native: 'did not read the page, 834 prompt tokens, $0.0027, 2.3 s',
        }),
        tests: 'old.reddit.com as a thread link (Hacker News story 36245435)',
        recorded: Object.freeze([
            'Keenable keyless fetch: the request was aborted by its timeout',
        ]),
    }),
]);

module.exports = { FETCH_TEST_PAGES };
