import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pushDataWithinLimit } from './charging.js';
import { API_URL, InputError, isObject, matches, pageUrl, parsePage, readInput, sanitize } from './schemes.js';

const PAGE_SIZE = 2000;
const MAX_PAGES = 3;
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60000;
const STATE_STORE = 'uk-flood-defence-schemes-state';

function retryAfterMs(header, now) {
    if (!header) return 0;
    if (/^\d+$/.test(header)) return Number(header) * 1000;
    const date = Date.parse(header);
    return Number.isFinite(date) ? Math.max(0, date - now()) : 0;
}

function makeFetcher({ fetchImpl, sleep, log, now, intervalMs }) {
    let first = true;
    return async (offset, limit) => {
        let retryAfter = 0;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (!first) {
                const backoff = intervalMs * 2 ** Math.max(0, attempt - 1);
                await sleep(Math.max(backoff, retryAfter));
            }
            first = false;
            let response;
            let body;
            const context = `Environment Agency page at offset ${offset}`;
            try {
                response = await fetchImpl(pageUrl(offset, limit), {
                    headers: { Accept: 'application/json', 'User-Agent': 'uk-flood-defence-schemes-actor/1.0' },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(20000),
                });
                if (response.status === 200) body = await response.text();
                else await response.body?.cancel().catch(() => {});
            } catch {
                if (attempt === MAX_RETRIES) throw new Error(`Network error after retries for ${context}.`);
                retryAfter = 0;
                log.warning(`Network error for ${context}. Retrying.`);
                continue;
            }

            if (response.status === 200) {
                const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
                if (contentType !== 'application/json') throw new Error(`Expected JSON for ${context}.`);
                let payload;
                try {
                    payload = JSON.parse(body);
                } catch {
                    throw new Error(`Invalid JSON for ${context}.`);
                }
                return parsePage(payload, offset, limit);
            }

            const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
            if (!retryable || attempt === MAX_RETRIES) throw new Error(`HTTP ${response.status} for ${context}.`);
            retryAfter = retryAfterMs(response.headers.get('retry-after'), now);
            if (retryAfter > MAX_RETRY_AFTER_MS) {
                throw new Error(`HTTP ${response.status} for ${context}. Retry-After exceeds 60 seconds. Try again later.`);
            }
            log.warning(`HTTP ${response.status} for ${context}. Retrying.`);
        }
        throw new Error('Environment Agency retries exhausted.');
    };
}

async function readSchemes(getPage) {
    const byId = new Map();
    let appliedLimit;
    let sourcePages = 0;
    let lastPageWasShort = false;
    while (sourcePages < MAX_PAGES) {
        const { limit, rows } = await getPage(byId.size, PAGE_SIZE);
        if (appliedLimit !== undefined && limit !== appliedLimit) {
            throw new Error('The Environment Agency applied a different limit between pages.');
        }
        appliedLimit = limit;
        sourcePages++;
        for (const row of rows) {
            if (byId.has(row.projectId)) {
                throw new Error('Duplicate project ID in Environment Agency pages. The source may have changed during paging.');
            }
            byId.set(row.projectId, row);
        }
        lastPageWasShort = rows.length < limit;
        if (lastPageWasShort) break;
    }

    // The endpoint has no total field. An empty one-row probe confirms the end at the number of distinct schemes read.
    const tail = await getPage(byId.size, 1);
    if (tail.rows.length && lastPageWasShort) {
        throw new Error('Inconsistent Environment Agency item count. A short page was followed by more schemes.');
    }
    if (tail.rows.length) {
        throw new Error(`Environment Agency list exceeds the ${MAX_PAGES}-page safety limit. A complete snapshot is required.`);
    }
    return { rows: [...byId.values()], sourcePages };
}

async function loadSeen(store, key) {
    const saved = await store.getValue(key);
    if (saved == null) return new Map();
    if (!isObject(saved) || saved.version !== 1 || !isObject(saved.fingerprints)
        || Object.values(saved.fingerprints).some((value) => typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))) {
        throw new Error('Unrecognised monitoring state. Use a new stateKey to start a fresh baseline.');
    }
    return new Map(Object.entries(saved.fingerprints));
}

function fingerprint({ source, ...scheme }) {
    return createHash('sha256').update(JSON.stringify(scheme)).digest('hex');
}

function countStored(result, batchLength) {
    const count = result?.chargedCount;
    if (result?.eventChargeLimitReached || (count !== undefined && count !== 0)) {
        if (!Number.isSafeInteger(count) || count < 0 || count > batchLength) {
            throw new Error('Unexpected Apify charge result. The last batch could not be checkpointed.');
        }
        return count;
    }
    // In a non-PPE run the SDK may return no charge result, or zero charged without a limit.
    return batchLength;
}

export async function run({ actor, log, fetchImpl = fetch, sleep = delay, now = Date.now, intervalMs = 6100 }) {
    try {
        await actor.init();
        const input = readInput((await actor.getInput()) ?? {});
        const store = input.onlyNew ? await actor.openKeyValueStore(STATE_STORE) : null;
        const stateRecord = `schemes-${input.stateKey}`;
        const seen = store && await loadSeen(store, stateRecord);
        const getPage = makeFetcher({ fetchImpl, sleep, log, now, intervalMs });
        const { rows, sourcePages } = await readSchemes(getPage);
        const matching = rows.filter((row) => matches(row, input));
        const pending = [];
        for (const row of matching) {
            if (!seen) {
                pending.push({ row });
                continue;
            }
            const hash = fingerprint(row);
            const previous = seen.get(row.projectId);
            if (hash !== previous) {
                pending.push({ row: { ...row, changeType: previous ? 'changed' : 'new' }, hash });
            }
        }

        const selected = pending.slice(0, input.maxItems);
        let pushed = 0;
        let spendingLimitReached = false;
        for (let start = 0; start < selected.length; start += BATCH_SIZE) {
            const batch = selected.slice(start, start + BATCH_SIZE);
            const chargeResult = await pushDataWithinLimit(actor, batch.map(({ row }) => row));
            const stored = countStored(chargeResult, batch.length);
            if (store && stored > 0) {
                for (const { row, hash } of batch.slice(0, stored)) seen.set(row.projectId, hash);
                await store.setValue(stateRecord, { version: 1, fingerprints: Object.fromEntries(seen) });
            }
            pushed += stored;
            spendingLimitReached = chargeResult?.eventChargeLimitReached === true || stored < batch.length;
            if (spendingLimitReached) break;
        }

        const stopReason = pushed < selected.length ? 'spendingLimit' : pushed < pending.length ? 'maxItems' : null;
        await actor.setValue('RUN_SUMMARY', {
            sourceUrl: API_URL,
            sourcePages,
            sourceTotal: rows.length,
            matched: matching.length,
            eligible: pending.length,
            pushed,
            incomplete: stopReason !== null,
            stopReason,
            spendingLimitReached,
        });
        if (stopReason) log.warning(`Output limited by ${stopReason}. ${pending.length - pushed} eligible schemes were not saved.`);
        log.info(`Verified ${rows.length} source schemes. Matched ${matching.length} and saved ${pushed}.`);
        await actor.exit();
    } catch (error) {
        const message = sanitize(error?.message ?? error);
        const status = error instanceof InputError ? `Invalid input. ${message}` : message;
        log.error(status);
        await actor.fail(status);
    }
}
