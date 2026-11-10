'use strict';
// A stand-in external capture backend for tests/capture_test.js: reports the
// WOW_AI_CAPTURE_* settings it was given, then prints one strip record and exits.
const e = process.env;
console.log(JSON.stringify({ info: `cell=${e.WOW_AI_CAPTURE_CELL_PX} cells=${e.WOW_AI_CAPTURE_CELLS_PER_ROW} rows=${e.WOW_AI_CAPTURE_MAX_ROWS} interval=${e.WOW_AI_CAPTURE_INTERVAL_MS} process=${e.WOW_AI_CAPTURE_PROCESS_NAME} window=${e.WOW_AI_CAPTURE_WINDOW_NAME} client=${e.WOW_AI_CAPTURE_CLIENT_FOLDER}` }));
console.log('not json');
console.log(JSON.stringify({ id: 3, text: 'hello' }));
