const HOST = 'environment.data.gov.uk';
const SCHEME_PATH = '/asset-management/id/completed-capital-project';
const SCHEME_TYPE = '/asset-management/def/capital-programme/CompletedCapitalProject';
const PROGRAMME_PATH = '/asset-management/def/capital-programme/';
const AREA_PATH = '/registry/def/ea-organization/ea_areas/';
const RFCC_PATH = '/asset-management/id/regional-flood-committee/';
const LICENCE_URL = 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/';
const PUBLISHER = 'Environment Agency';
const GENERIC_AUTHORITY_TYPES = new Set([
    'Local Authority', 'Internal Drainage Board', 'Water Company', 'Lead Local Flood Authority',
]);
const EMAIL = /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi;
const UK_PHONE = /(?<![\w+])(?:\+44[ .-]*(?:\(0\)[ .-]*)?|\(?0)[123789](?:[ ().-]*\d){9}(?![\w]|[ .-]*\d)/g;

export const API_URL = `https://${HOST}${SCHEME_PATH}.json`;
export const SOURCE = `${PUBLISHER} — Flood and Coastal Erosion Risk Management Completed Schemes. Contains public sector information licensed under the Open Government Licence v3.0 (${LICENCE_URL}).`;
export const DEFAULT_MAX_ITEMS = 100;
export const MAX_ITEMS = 300;

export class InputError extends Error {}

export function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function searchValue(value) {
    return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function readInput(input) {
    if (!isObject(input)) throw new InputError('Expected a JSON object.');
    for (const field of ['completedFrom', 'completedTo', 'localAuthorities', 'constituencies']) {
        if (Object.hasOwn(input, field)) {
            throw new InputError(`${field} is unavailable in the Environment Agency completed schemes API.`);
        }
    }

    const list = (field) => {
        const value = input[field];
        if (value === undefined) return [];
        if (!Array.isArray(value) || !value.every(isText)) {
            throw new InputError(`${field} must be a list of non-empty strings.`);
        }
        return value.map(searchValue);
    };
    const { minHomesBetterProtected, maxItems = DEFAULT_MAX_ITEMS, onlyNew = false, stateKey = 'default' } = input;
    if (minHomesBetterProtected !== undefined
        && (!Number.isSafeInteger(minHomesBetterProtected) || minHomesBetterProtected < 0)) {
        throw new InputError('minHomesBetterProtected must be a non-negative integer.');
    }
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > MAX_ITEMS) {
        throw new InputError(`maxItems must be an integer from 1 to ${MAX_ITEMS}.`);
    }
    if (typeof onlyNew !== 'boolean') throw new InputError('onlyNew must be true or false.');
    if (typeof stateKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
        throw new InputError('stateKey must contain 1 to 50 letters, digits, underscores or hyphens.');
    }

    return {
        areas: list('areas'), keywords: list('keywords'), minHomesBetterProtected, maxItems, onlyNew, stateKey,
    };
}

export function pageUrl(offset, limit) {
    return `${API_URL}?_view=full&_limit=${limit}&_offset=${offset}`;
}

function invalid(field, context) {
    throw new Error(`Unrecognised Environment Agency response at ${context} (${field}).`);
}

function sourceUri(value, host, field, context) {
    if (!isText(value) || !URL.canParse(value)) invalid(field, context);
    const uri = new URL(value);
    if (!['http:', 'https:'].includes(uri.protocol) || uri.host !== host
        || uri.username || uri.password || uri.hash) {
        invalid(field, context);
    }
    uri.protocol = 'https:';
    return uri;
}

function uriCode(value, host, prefix, field, context) {
    const uri = sourceUri(value, host, field, context);
    if (uri.search || !uri.pathname.startsWith(prefix)) invalid(field, context);
    const code = uri.pathname.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(code)) invalid(field, context);
    return code;
}

function optionalText(value, field, context) {
    if (value == null) return null;
    if (!isText(value)) invalid(field, context);
    return value.replace(EMAIL, '[redacted]').replace(UK_PHONE, '[redacted]');
}

function optionalInteger(value, field, context) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) invalid(field, context);
    return value;
}

function reference(value, host, prefix, label, field, context) {
    if (value == null) return { code: null, name: null };
    if (!isObject(value)) invalid(field, context);
    return {
        code: uriCode(value['@id'], host, prefix, `${field}.@id`, context),
        name: optionalText(value[label], `${field}.${label}`, context),
    };
}

function regionsOf(value, context) {
    if (value == null) return null;
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some((entry) => !isObject(entry))) invalid('inRegion', context);
    const regions = values.map((entry) => reference(
        entry, 'statistics.data.gov.uk', '/id/statistical-geography/', 'officialname', 'inRegion', context,
    ));
    if (new Set(regions.map(({ code }) => code)).size !== regions.length) invalid('duplicate inRegion codes', context);
    return regions.sort((left, right) => left.code.localeCompare(right.code, 'en'));
}

function parseScheme(item, context) {
    if (!isObject(item)) invalid('scheme item', context);
    const sourceUrl = sourceUri(item['@id'], HOST, 'scheme @id', context);
    const { notation: projectId, label, type } = item;
    if (!isText(projectId) || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(projectId)
        || sourceUrl.pathname !== `${SCHEME_PATH}/${projectId}` || sourceUrl.search) {
        invalid('scheme notation and @id', context);
    }
    if (!Array.isArray(type) || !type.some((entry) => isObject(entry)
        && [`http://${HOST}${SCHEME_TYPE}`, `https://${HOST}${SCHEME_TYPE}`].includes(entry['@id']))) {
        invalid('scheme type', context);
    }
    if (!isText(label)) invalid('scheme label', context);
    if (!isObject(item.isPartOf)) invalid('isPartOf', context);

    const area = reference(item.area, HOST, AREA_PATH, 'label', 'area', context);
    const rfcc = reference(item.hasRfcc, HOST, RFCC_PATH, 'label', 'hasRfcc', context);
    const authority = optionalText(item.authorityType, 'authorityType', context);
    return {
        projectId,
        name: optionalText(label, 'label', context),
        capitalProgrammeId: uriCode(item.isPartOf['@id'], HOST, PROGRAMME_PATH, 'isPartOf.@id', context),
        eaArea: area.name,
        eaAreaCode: area.code,
        riskManagementAuthority: GENERIC_AUTHORITY_TYPES.has(authority) ? null : authority,
        riskManagementAuthorityType: authority,
        completionDate: null,
        completionFinancialYear: null,
        homesBetterProtected: optionalInteger(item.homesBetterProtected, 'homesBetterProtected', context),
        easting: optionalInteger(item.easting, 'easting', context),
        northing: optionalInteger(item.northing, 'northing', context),
        regions: regionsOf(item.inRegion, context),
        regionalFloodAndCoastalCommittee: rfcc.name,
        regionalFloodAndCoastalCommitteeCode: rfcc.code,
        sourceUrl: sourceUrl.href,
        source: SOURCE,
    };
}

export function parsePage(payload, offset, requestedLimit) {
    const context = `offset ${offset}`;
    if (!isObject(payload) || !isObject(payload.meta) || !Array.isArray(payload.items)) {
        invalid('expected meta and items', context);
    }
    const { meta, items } = payload;
    const uri = sourceUri(meta['@id'], HOST, 'meta.@id', context);
    const expectedUrl = new URL(pageUrl(offset, requestedLimit));
    uri.searchParams.sort();
    expectedUrl.searchParams.sort();
    if (uri.href !== expectedUrl.href) invalid('meta.@id page URL', context);
    const licence = sourceUri(meta.license, 'www.nationalarchives.gov.uk', 'meta.license', context);
    if (licence.href !== LICENCE_URL || meta.publisher !== PUBLISHER || meta.version !== '0.1') {
        invalid('publisher, licence or API version', context);
    }
    if ((meta.offset !== undefined || offset !== 0) && meta.offset !== offset) {
        invalid('meta.offset does not match the requested offset', context);
    }
    if (!Number.isSafeInteger(meta.limit) || meta.limit < 1 || meta.limit > requestedLimit
        || items.length > meta.limit) {
        invalid('meta.limit or item count', context);
    }
    return { limit: meta.limit, rows: items.map((item, index) => parseScheme(item, `row ${offset + index + 1}`)) };
}

export function matches(row, { areas, keywords, minHomesBetterProtected }) {
    return (!areas.length || areas.some((value) => value === row.eaAreaCode
            || (row.eaArea !== null && value === searchValue(row.eaArea))))
        && (!keywords.length || keywords.some((value) => searchValue(row.name).includes(value)))
        && (minHomesBetterProtected === undefined
            || (row.homesBetterProtected !== null && row.homesBetterProtected >= minHomesBetterProtected));
}

export function sanitize(message) {
    return String(message)
        .split(/\r?\n/, 1)[0]
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"`)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"`)]*/g, '<path>');
}
