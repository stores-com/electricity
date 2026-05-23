const fs = require('node:fs');
const path = require('node:path');
const { parentPort } = require('node:worker_threads');

const { createProcessor } = require('./processor.js');

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
 * @param {object} processor
 * @param {string} filePath
 */
function urlPathsToWarm(processor, filePath) {
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

// A shared pool of workers warms every electricity.static() instance in the
// process. Each warm job is fanned out to the whole pool, with each worker
// handling a disjoint shard of the directory's files (every shardCount-th file
// starting at shardIndex). Files are sorted so the shards are deterministic and
// cover the tree exactly once. Each worker creates its own processor, so a CSS
// file's url() dependencies resolve within that worker even when the referenced
// asset belongs to another shard; the entries stay byte-identical to a
// synchronous read because hashing is deterministic.
parentPort.on('message', ({ directory, jobId, options, shardCount, shardIndex }) => {
    const processor = createProcessor(directory, options);
    const filePaths = [...walk(directory)].sort();
    const warmed = new Set();

    for (let i = 0; i < filePaths.length; i++) {
        if (i % shardCount !== shardIndex) {
            continue;
        }

        for (const urlPath of urlPathsToWarm(processor, filePaths[i])) {
            if (warmed.has(urlPath)) {
                continue;
            }

            warmed.add(urlPath);

            let file;

            try {
                file = processor.fetchFile(urlPath);
            } catch (err) {
                // Couldn't process this file (e.g. it's a directory or
                // unreadable). The main thread's synchronous fallback will
                // surface any real error when the file is actually requested.
                continue;
            }

            parentPort.postMessage({ file, jobId, urlPath });
        }
    }

    parentPort.postMessage({ done: true, jobId });
});
