import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { run } from '../src/run.js';
import { API_URL, matches, pageUrl, parsePage, readInput, sanitize } from '../src/schemes.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const recordedPage = fixture('schemes');
const recordedTail = fixture('end-of-list');
const sample = recordedPage.items;

function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
}

function sourcePage(items, offset, requestedLimit, appliedLimit = requestedLimit) {
    const meta = {
        ...recordedPage.meta,
        '@id': pageUrl(offset, requestedLimit).replace(/^https:/, 'http:'),
        limit: appliedLimit,
    };
    if (offset > 0) meta.offset = offset;
    return { meta, items };
}

function sourceOf(items, pageSize = 2000) {
    return (url) => {
        const { searchParams } = new URL(url);
        const offset = Number(searchParams.get('_offset'));
        const limit = Number(searchParams.get('_limit'));
        const applied = Math.min(limit, pageSize);
        return jsonResponse(sourcePage(items.slice(offset, offset + applied), offset, limit, applied));
    };
}

function fakeActor(input, state = new Map(), write = () => undefined) {
    const rows = [];
    const summaries = new Map();
    const checkpoints = [];
    const events = [];
    let status;
    const actor = {
        async init() {},
        async getInput() { return input; },
        async openKeyValueStore(name) {
            assert.equal(name, 'uk-flood-defence-schemes-state');
            return {
                async getValue(key) { return state.get(key); },
                async setValue(key, value) {
                    events.push('checkpoint');
                    state.set(key, structuredClone(value));
                    checkpoints.push(Object.keys(value.fingerprints));
                },
            };
        },
        async pushData(batch) {
            events.push('push');
            const result = write(batch);
            const stored = result?.eventChargeLimitReached || result?.chargedCount > 0
                ? result.chargedCount : batch.length;
            rows.push(...batch.slice(0, stored));
            return result;
        },
        async setValue(key, value) { summaries.set(key, value); },
        async exit() { status = 'success'; },
        async fail(message) { status = message; },
    };
    return { actor, rows, summaries, checkpoints, events, get status() { return status; } };
}

async function execute(fake, source, intervalMs = 6100) {
    const requests = [];
    const waits = [];
    const warnings = [];
    assert.equal(fake.status, undefined);
    await run({
        actor: fake.actor,
        log: { info() {}, warning(message) { warnings.push(message); }, error() {} },
        async fetchImpl(url, options) {
            assert.equal(new URL(url).pathname, new URL(API_URL).pathname);
            assert.equal(new URL(url).origin, new URL(API_URL).origin);
            assert.equal(options.redirect, 'manual');
            assert.equal(options.headers.Accept, 'application/json');
            requests.push(url);
            return source(url, requests.length);
        },
        async sleep(ms) { waits.push(ms); },
        now: () => Date.UTC(2026, 10, 22),
        intervalMs,
    });
    return { requests, waits, warnings, summary: fake.summaries.get('RUN_SUMMARY') };
}

function copies(count) {
    return Array.from({ length: count }, (_, index) => {
        const notation = `TEST-${index + 1}`;
        const id = new URL(sample[0]['@id']);
        id.pathname = `${new URL(API_URL).pathname.replace(/\.json$/, '')}/${notation}`;
        return { ...sample[0], notation, '@id': id.href };
    });
}

test('maps real completed schemes and validates a real empty end probe', () => {
    const { rows, limit } = parsePage(recordedPage, 0, 2000);
    assert.equal(limit, 2000);
    assert.equal(parsePage(recordedTail, 1211, 1).rows.length, 0);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].projectId, 'ACC451E/000A/633A');
    assert.equal(rows[0].capitalProgrammeId, 'CapitalProgramme2015To2023');
    assert.equal(rows[0].name, 'Ten Mile Bank Emergency repairs');
    assert.equal(rows[0].eaAreaCode, '52');
    assert.equal(rows[0].eaArea, 'East Anglia');
    assert.equal(rows[0].riskManagementAuthority, 'Environment Agency');
    assert.equal(rows[0].homesBetterProtected, 39);
    assert.equal(rows[0].completionDate, null);
    assert.equal(rows[0].completionFinancialYear, null);
    assert.deepEqual([rows[0].easting, rows[0].northing], [560040, 296020]);
    assert.match(rows[0].source, /Environment Agency.*Open Government Licence v3\.0/);
    assert.match(rows[0].sourceUrl, /\/completed-capital-project\/ACC451E\/000A\/633A$/);
    assert.match(rows[1].name, /2021-2022 - 2024-2025/);
    assert.deepEqual(rows[2].regions, [
        { code: 'E12000007', name: 'London' },
        { code: 'E12000008', name: 'South East' },
    ]);
    assert.ok(rows.every(({ name }) => name));
});

test('preserves missing fields and zero while redacting just contact details', () => {
    const missing = { ...sample[0], homesBetterProtected: undefined, area: null, authorityType: 'Local Authority' };
    const zero = {
        ...sample[1], homesBetterProtected: 0, label: 'River works (info@example.com, +44 (0)20 7946 0123)',
        contactName: 'Discarded field', lat: 52.1,
    };
    const { rows } = parsePage(sourcePage([missing, zero], 0, 2), 0, 2);
    assert.equal(rows[0].homesBetterProtected, null);
    assert.equal(rows[0].eaArea, null);
    assert.equal(rows[0].riskManagementAuthority, null);
    assert.equal(rows[0].riskManagementAuthorityType, 'Local Authority');
    assert.equal(rows[1].homesBetterProtected, 0);
    assert.equal(rows[1].name, 'River works ([redacted], [redacted])');
    assert.ok(!Object.hasOwn(rows[1], 'contactName'));
    assert.ok(!Object.hasOwn(rows[1], 'lat'));
    assert.equal(matches(rows[0], readInput({ minHomesBetterProtected: 0 })), false);
    assert.equal(matches(rows[1], readInput({ minHomesBetterProtected: 0 })), true);
});

test('matches area names or codes and case-insensitive substrings', () => {
    const { rows: [row] } = parsePage(recordedPage, 0, 2000);
    assert.ok(matches(row, readInput({ areas: [' east ANGLIA '], keywords: ['TEN MILE', 'other'], minHomesBetterProtected: 39 })));
    assert.ok(matches(row, readInput({ areas: ['52'] })));
    assert.ok(!matches(row, readInput({ areas: ['5'] })));
    assert.ok(!matches(row, readInput({ keywords: ['Ten Mile'], minHomesBetterProtected: 40 })));
});

test('rejects malformed inputs and unavailable fields with actionable messages', () => {
    for (const [key, value] of Object.entries({
        areas: [52], keywords: 'bank', minHomesBetterProtected: '39', maxItems: 0, onlyNew: 'false',
        stateKey: 'bad/key', completedFrom: 2024, completedTo: '2025-03-31',
        localAuthorities: ['Eastbourne Borough Council'], constituencies: ['Eastbourne'],
    })) {
        assert.throws(() => readInput({ [key]: value }), new RegExp(key));
    }
    assert.throws(() => readInput([]), /JSON object/);
});

test('fails on unrecognised pagination metadata or record field types', () => {
    for (const [key, value, message] of [
        ['@id', pageUrl(1, 2), /page URL/],
        ['offset', '2', /meta.offset/],
        ['offset', undefined, /meta.offset/],
        ['limit', '2', /meta.limit/],
        ['limit', 1, /item count/],
        ['publisher', 'Different publisher', /publisher/],
        ['license', 'https://example.com', /meta.license/],
        ['version', '9', /version/],
    ]) {
        const page = sourcePage(sample.slice(0, 2), 2, 2);
        page.meta[key] = value;
        assert.throws(() => parsePage(page, 2, 2), message);
    }
    for (const [key, value, message] of [
        ['@id', 'https://example.com/other', /scheme @id/],
        ['notation', 1234, /notation/],
        ['label', [], /scheme label/],
        ['type', [], /scheme type/],
        ['homesBetterProtected', '39', /homesBetterProtected/],
        ['homesBetterProtected', -1, /homesBetterProtected/],
        ['area', 'East Anglia', /area/],
        ['area', { ...sample[0].area, label: 52 }, /area.label/],
        ['area', { ...sample[0].area, '@id': 'https://example.com/52' }, /area.@id/],
        ['authorityType', {}, /authorityType/],
        ['isPartOf', [], /isPartOf/],
        ['easting', '560040', /easting/],
        ['inRegion', [null], /inRegion/],
        ['hasRfcc', { ...sample[0].hasRfcc, label: [] }, /hasRfcc.label/],
    ]) {
        const page = sourcePage([{ ...sample[0], [key]: value }], 0, 1);
        assert.throws(() => parsePage(page, 0, 1), message);
    }
    assert.throws(() => parsePage({ items: [] }, 0, 1), /expected meta and items/);
});

test('reads consecutive pages, validates the total, and saves one row per scheme', async () => {
    const fake = fakeActor({});
    const { requests, waits, summary } = await execute(fake, sourceOf(sample, 2));
    assert.equal(fake.status, 'success');
    assert.deepEqual(requests, [pageUrl(0, 2000), pageUrl(2, 2000), pageUrl(4, 2000), pageUrl(4, 1)]);
    assert.deepEqual(waits, [6100, 6100, 6100]);
    assert.equal(summary.sourcePages, 3);
    assert.equal(summary.sourceTotal, 4);
    assert.equal(summary.pushed, 4);
    assert.equal(summary.incomplete, false);
    assert.equal(fake.rows.length, 4);
    assert.equal(fake.checkpoints.length, 0);
});

test('rejects duplicate rows, inconsistent tails and capped scans before output or state writes', async () => {
    for (const [source, message] of [
        [sourceOf([sample[0], sample[1], sample[0]], 2), /Duplicate project ID/],
        [(url, call) => call === 1
            ? jsonResponse(sourcePage([sample[0]], 0, 2000))
            : jsonResponse(sourcePage([sample[1]], 1, 1)), /Inconsistent.*item count/],
        [(url, call) => call === 2
            ? jsonResponse(sourcePage([sample[1]], 1, 2000, 2))
            : sourceOf(sample, 1)(url), /different limit/],
        [sourceOf(sample, 1), /safety limit/],
    ]) {
        const fake = fakeActor({ onlyNew: true });
        const { summary } = await execute(fake, source);
        assert.match(fake.status, message);
        assert.deepEqual(fake.events, []);
        assert.equal(summary, undefined);
    }
});

test('validates rows even if a filter would exclude them', async () => {
    const fake = fakeActor({ areas: ['52'], onlyNew: true });
    await execute(fake, sourceOf([sample[0], { ...sample[1], homesBetterProtected: 'unknown' }]));
    assert.match(fake.status, /homesBetterProtected/);
    assert.deepEqual(fake.events, []);
});

test('accepts an empty verified list and distinguishes it from an output limit', async () => {
    const empty = fakeActor({});
    const { summary: emptySummary } = await execute(empty, sourceOf([]));
    assert.equal(empty.status, 'success');
    assert.equal(emptySummary.sourceTotal, 0);
    assert.equal(emptySummary.stopReason, null);

    const limited = fakeActor({ maxItems: 1 });
    const { summary } = await execute(limited, sourceOf(sample));
    assert.equal(limited.status, 'success');
    assert.equal(summary.sourceTotal, 4);
    assert.equal(summary.pushed, 1);
    assert.equal(summary.stopReason, 'maxItems');
});

test('honours numeric and HTTP-date Retry-After and backs off network failures', async () => {
    const fake = fakeActor({});
    const { waits } = await execute(fake, (url, call) => {
        if (call === 1) throw new Error('Connection reset');
        if (call === 2) return new Response(null, { status: 503, headers: { 'retry-after': '15' } });
        if (call === 3) return new Response(null, {
            status: 429, headers: { 'retry-after': 'Sun, 22 Nov 2026 00:00:30 GMT' },
        });
        return sourceOf(sample)(url);
    });
    assert.equal(fake.status, 'success');
    assert.deepEqual(waits, [6100, 15000, 30000, 6100]);
});

test('stops after three retries and immediately fails on forbidden, redirects or malformed JSON', async () => {
    for (const [reply, requests, message] of [
        [() => new Response(null, { status: 503 }), 4, /HTTP 503/],
        [() => new Response(null, { status: 403 }), 1, /HTTP 403/],
        [() => new Response(null, { status: 302 }), 1, /HTTP 302/],
        [() => new Response(null, { status: 429, headers: { 'retry-after': '120' } }), 1, /exceeds 60 seconds/],
        [() => new Response('<html>'), 1, /Expected JSON/],
        [() => new Response('{', { headers: { 'content-type': 'application/json' } }), 1, /Invalid JSON/],
    ]) {
        const fake = fakeActor({});
        const result = await execute(fake, reply);
        assert.equal(result.requests.length, requests);
        assert.match(fake.status, message);
        assert.deepEqual(fake.rows, []);
    }
});

test('reports new rows and revisions once, including when a response reorders region references', async () => {
    const state = new Map();
    const input = { onlyNew: true, stateKey: 'test' };
    const first = fakeActor(input, state);
    await execute(first, sourceOf([sample[0], sample[2]]));
    assert.deepEqual(first.rows.map(({ changeType }) => changeType), ['new', 'new']);

    const revised = { ...sample[0], homesBetterProtected: 40 };
    const reordered = { ...sample[2], inRegion: [...sample[2].inRegion].reverse() };
    const second = fakeActor(input, state);
    await execute(second, sourceOf([revised, reordered, sample[1]]));
    assert.deepEqual(second.rows.map(({ changeType }) => changeType), ['changed', 'new']);
    assert.equal(second.rows[0].homesBetterProtected, 40);

    const third = fakeActor(input, state);
    await execute(third, sourceOf([revised, reordered, sample[1]]));
    assert.deepEqual(third.events, []);
    assert.equal(third.status, 'success');
});

test('retains eligible rows beyond maxItems and leaves filtered-out rows unseen', async () => {
    const state = new Map();
    const first = fakeActor({ onlyNew: true, maxItems: 1, keywords: ['bank', 'beach'] }, state);
    await execute(first, sourceOf(sample));
    assert.deepEqual(first.rows.map((row) => row.projectId), [sample[0].notation]);
    const second = fakeActor({ onlyNew: true }, state);
    await execute(second, sourceOf(sample));
    assert.deepEqual(second.rows.map((row) => row.projectId), sample.slice(1).map((row) => row.notation));
});

test('checkpoints only confirmed batch prefixes when PPE cuts off a later batch', async () => {
    const items = copies(120);
    const state = new Map();
    const input = { onlyNew: true, maxItems: 120 };
    const first = fakeActor(input, state, (batch) => batch[0].projectId === 'TEST-1'
        ? { eventChargeLimitReached: false, chargedCount: 50 }
        : { eventChargeLimitReached: true, chargedCount: 7 });
    const { summary } = await execute(first, sourceOf(items));
    assert.equal(first.status, 'success');
    assert.equal(summary.pushed, 57);
    assert.equal(summary.stopReason, 'spendingLimit');
    assert.deepEqual(first.events, ['push', 'checkpoint', 'push', 'checkpoint']);
    assert.deepEqual(first.checkpoints.map((keys) => keys.length), [50, 57]);
    assert.equal(first.checkpoints[1].at(-1), 'TEST-57');

    const second = fakeActor(input, state);
    await execute(second, sourceOf(items));
    assert.deepEqual(second.rows.map((row) => row.projectId), items.slice(57).map((row) => row.notation));
});

test('a zero PPE allowance never checkpoints a row', async () => {
    const fake = fakeActor({ onlyNew: true }, new Map(), () => ({
        eventChargeLimitReached: true, chargedCount: 0,
    }));
    const { summary } = await execute(fake, sourceOf(sample));
    assert.equal(summary.pushed, 0);
    assert.equal(summary.stopReason, 'spendingLimit');
    assert.deepEqual(fake.events, ['push']);
});

test('preserves previous batch checkpoints when a later push fails', async () => {
    const fake = fakeActor({ onlyNew: true }, new Map(), (batch) => {
        if (batch[0].projectId === 'TEST-51') throw new Error('Write failed');
        return { eventChargeLimitReached: false, chargedCount: 0 };
    });
    await execute(fake, sourceOf(copies(60)));
    assert.equal(fake.status, 'Write failed');
    assert.deepEqual(fake.events, ['push', 'checkpoint', 'push']);
    assert.equal(fake.checkpoints[0].length, 50);
});

test('removes local paths and stack lines from failures', () => {
    const windowsPath = ['C:', 'Users', 'test', 'project'].join('/');
    assert.equal(sanitize(`Write failed at ${windowsPath}\n    at internal`), 'Write failed at <path>');
    assert.equal(sanitize('Write failed at /tmp/test/project'), 'Write failed at <path>');
    assert.equal(sanitize('https://environment.data.gov.uk/asset-management'), 'https://environment.data.gov.uk/asset-management');
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const state = new Map();
        const fake = fakeActor({ onlyNew: true }, state);
        configureActor(fake.actor, fake.rows);
        const expected = isPayPerEvent ? budget : 3;
        const source = sourceOf(copies(3));
        const { summary } = await execute(fake, source);
        assert.equal(fake.status, 'success');
        assert.equal(fake.rows.length, expected);
        assert.equal(summary.pushed, expected);
        assert.equal(summary.stopReason, isPayPerEvent ? 'spendingLimit' : null);
        const next = fakeActor({ onlyNew: true }, state);
        await execute(next, source);
        assert.equal(next.rows.length, 3 - expected);
    }
});
