# England Flood Defence Schemes

Get completed flood and coastal risk management schemes in England from the Environment Agency. Each row describes a published scheme or delivered phase. Use the data to track investment by EA area, identify relevant schemes for due diligence, or monitor new records and revisions to the reported number of homes better protected.

## Input

```json
{
    "areas": ["East Anglia", "53"],
    "keywords": ["bank", "flood"],
    "minHomesBetterProtected": 10,
    "maxItems": 100
}
```

| Field | Behaviour |
| --- | --- |
| `areas` | Match any published EA area name or code. Names are case-insensitive and codes are strings. An empty list includes all areas. |
| `keywords` | Match any substring in the scheme name, ignoring case. An empty list includes all names. |
| `minHomesBetterProtected` | Inclusive minimum. A scheme must have a published count if you set this filter. |
| `maxItems` | Save up to this many eligible rows, from 1 to 300. Defaults to 100. |
| `onlyNew` | Compare matching schemes with the last version saved under `stateKey`. Defaults to false. |
| `stateKey` | Monitoring baseline, default `default`. Use 1–50 letters, digits, underscores or hyphens. |

Different filters combine with AND. The completed schemes endpoint omits completion dates, completion financial years and named local authority or Westminster constituency geography. The Actor reports both completion fields as `null` and rejects `completedFrom`, `completedTo`, `localAuthorities` and `constituencies` in input. The capital programme ID identifies a multi-year programme. [Environment Agency API reference](https://environment.data.gov.uk/asset-management/doc/reference#completed-capital-schemes)

## Monitoring

```json
{
    "areas": ["52"],
    "keywords": ["Ten Mile Bank Emergency repairs"],
    "onlyNew": true,
    "stateKey": "east-anglia-ten-mile-bank"
}
```

Repeat the same input to report only newly matched projects (`changeType: "new"`) or revisions to previously saved rows (`"changed"`). The first run reports the matching schemes as new. Use a separate key for an independent baseline and schedule runs that share a key sequentially. Schemes that disappear from the list produce no event. If a filter excludes a revision, it remains eligible when the scheme matches again. The Actor checkpoints each successfully stored batch, including the stored portion of a batch cut short by a spending limit. Runs can repeat the last batch after an interruption between the dataset write and its checkpoint.

## Output

```json
{
    "projectId": "ACC451E/000A/633A",
    "name": "Ten Mile Bank Emergency repairs",
    "capitalProgrammeId": "CapitalProgramme2015To2023",
    "eaArea": "East Anglia",
    "eaAreaCode": "52",
    "riskManagementAuthority": "Environment Agency",
    "riskManagementAuthorityType": "Environment Agency",
    "completionDate": null,
    "completionFinancialYear": null,
    "homesBetterProtected": 39,
    "easting": 560040,
    "northing": 296020,
    "regions": [{ "code": "E12000006", "name": "East of England" }],
    "regionalFloodAndCoastalCommittee": "Anglian Great Ouse RFCC",
    "regionalFloodAndCoastalCommitteeCode": "anglian-great-ouse",
    "sourceUrl": "https://environment.data.gov.uk/asset-management/id/completed-capital-project/ACC451E/000A/633A",
    "source": "Environment Agency — Flood and Coastal Erosion Risk Management Completed Schemes. Contains public sector information licensed under the Open Government Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)."
}
```

`riskManagementAuthorityType` preserves the published authority value. When that value is a generic category such as “Local Authority,” `riskManagementAuthority` is `null`. Easting and northing are British National Grid coordinates for the locality indicated by the EA. `homesBetterProtected` is the only benefit figure exposed by this endpoint. A missing count is `null`, and a published zero stays zero. [Dataset description](https://environment.data.gov.uk/asset-management/downloads/completed-schemes.pdf)

The Actor checks page URLs, offsets, limits and unique project IDs before saving any rows. The API omits a total, so the Actor verifies the computed total with an empty end-of-list probe. It reads at most three data pages plus the probe. The `RUN_SUMMARY` record reports the verified source count, matches, rows eligible for output, rows stored and any output limit reached.

## Data source and terms

Contains public sector information from the Environment Agency’s Flood and Coastal Erosion Risk Management Completed Schemes, licensed under the Open Government Licence v3.0. This independent Actor selects and reformats the published data and has no affiliation with the Environment Agency. [Source API](https://environment.data.gov.uk/asset-management/doc/reference) · [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)

## 日本語概要

イングランドの治水・沿岸対策の完了事業を、Environment Agency の公開 API から取得します。EA 地域、事業名、保護改善戸数で絞り込み、監視モードで新規事業と公表内容の改訂を取得できます。戸数が未公表の場合は `null` です。
