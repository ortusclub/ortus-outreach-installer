# For Antonio — speed up `handleBatchUpdate` in the centralized Apps Script

## Problem
A connection-check sweep sends one `batchUpdate` POST with ~150 row updates per
account. `handleBatchUpdate` → `writeFields` writes **cell-by-cell**
(`sheet.getRange(row, col).setValue(...)`), ~5–8 `setValue` calls per row. At
~150 rows that's ~900 individual cell writes per account = **2–3 minutes per
account**. With 50–70 accounts the sweep takes hours.

The bot side already ships an interim fix (it no longer re-stamps rows already
marked "Still Pending", so repeat sweeps are small). This note is the permanent
fix so even the first/full sweep is fast.

## Fix (≈100× faster): read once, mutate in memory, write once
Rewrite `handleBatchUpdate` so it:
1. Reads the **entire data range once** (`getRange(2,1,lastRow-1,headers.length).getValues()`).
2. Applies every update to that in-memory 2D array (compute the same target
   column/value pairs `writeFields` would, but assign into the array instead of
   calling `setValue`). Reuse the existing field mapping: `FIELD_MAP`, the
   `dateLastAction` → Date/Time split, the v2 `status`→`Last Action` fallback,
   and the action-column dash-fill — but write into `grid[rowIdx][colIdx]`.
3. Writes the whole range back **once**: `range.setValues(grid)`.
4. Handles a missing target column by appending it to `headers` + widening the
   grid **before** the single `setValues` (or skip-and-report, as today).

### Skeleton
```js
function handleBatchUpdate(sheet, data) {
  if (!data.updates || !data.updates.length) return jsonResponse({ error: 'updates array is required' });
  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers, sheet);
  if (urlColIndex === -1) return jsonResponse({ error: 'No LinkedIn URL column found' });
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ error: 'Sheet has no data rows' });

  var range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  var grid = range.getValues();                 // ONE read

  // url -> grid row index
  var urlMap = {};
  for (var i = 0; i < grid.length; i++) {
    var n = normalizeUrl(grid[i][urlColIndex]);
    if (n) urlMap[n] = i;
  }

  var results = [];
  data.updates.forEach(function (update) {
    var ri = urlMap[normalizeUrl(update.linkedinUrl)];
    if (ri === undefined) { results.push({ linkedinUrl: update.linkedinUrl, error: 'not found' }); return; }
    applyFieldsToGrid(grid, headers, ri, update, data);   // in-memory writeFields
    results.push({ linkedinUrl: update.linkedinUrl, row: ri + 2, updated: true });
  });

  range.setValues(grid);                         // ONE write
  return jsonResponse({ success: true, sheetId: data.sheetId, processed: results.length, results: results });
}
```
`applyFieldsToGrid` = the body of `writeFields`, but every
`sheet.getRange(row, idx+1).setValue(v)` becomes `grid[ri][idx] = v;`
(and header-append logic widens `headers` + every grid row before the final
`setValues`). Keep `handleUpdateRow`/`writeFields` as-is for the single-row path.

## Test before deploying team-wide
This is the shared deployment, so a bug breaks everyone's sheet writes. Before
redeploying the live web app: copy the script to a throwaway project pointed at
a **test sheet**, run a batchUpdate with ~150 rows mixing `cc`,
`connectionStatus`, `dateLastAction`, and a still-pending stamp, and confirm the
cells land exactly as the current version does — then publish.

## Also pending on this deployment (from earlier)
The `writeRecentMessages` action (Recent Messages tab) still needs this same
centralized script redeployed to work in production — see
`src/sheets-webapp-url.js`.
