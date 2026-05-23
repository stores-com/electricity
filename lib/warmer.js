const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { createProcessor } = require('./processor.js');

const { directory, options } = workerData;

// No watcher in the worker: the watch-only side effects (registering
// discovered Sass imports / Snockets dependencies with chokidar) must stay on
// the main thread, so warming is only ever enabled when watching is off.
const processor = createProcessor(directory, options);

/**
 * Recursively yields every regular file beneath a directory. Reads are
 * synchronous on purpose: this runs on a worker thread, so blocking here never
 * touches the main event loop.
 * @param {string} dir
 */
function* walk(dir) {
    let entries;

    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        // Missing or unreadable directory: nothing to warm.
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            yield* walk(fullPath);
        } else if (entry.isFile()) {
            yield fullPath;
        }
    }
}

/**
 * Maps a file on disk to the URL path(s) that should be warmed for it.
 * Sass sources are served as their compiled `.css` URL, and partials
 * (`_foo.scss`) are never served on their own, so they're skipped.
 * @param {string} filePath
 */
function urlPathsToWarm(filePath) {
    const extension = path.extname(filePath);

    if (extension === '.scss') {
        if (path.basename(filePath).startsWith('_')) {
            return [];
        }

        const cssFilePath = `${filePath.slice(0, -extension.length)}.css`;

        return [processor.toUrlPath(cssFilePath)];
    }

    return [processor.toUrlPath(filePath)];
}

const warmed = new Set();

for (const filePath of walk(directory)) {
    for (const urlPath of urlPathsToWarm(filePath)) {
        if (warmed.has(urlPath)) {
            continue;
        }

        warmed.add(urlPath);

        let file;

        try {
            file = processor.fetchFile(urlPath);
        } catch (err) {
            // Couldn't process this file (e.g. it's a directory or unreadable).
            // The main thread's synchronous fallback will surface any real
            // error when the file is actually requested.
            continue;
        }

        parentPort.postMessage({ file, urlPath });
    }
}

parentPort.close();
