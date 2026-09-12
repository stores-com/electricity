const fs = require('node:fs');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const processor = require('./processor');

const options = workerThreads.workerData.options;

/**
 * Processes every file below a directory and sends each result to the middleware.
 * @param {string} relativeDirectory Directory to process, relative to the asset directory.
 * @param {Set<string>} ancestors Resolved directories already being processed.
 */
function walk(relativeDirectory, ancestors) {
    const directoryPath = path.join(options.directory, relativeDirectory);
    const realPath = fs.realpathSync(directoryPath);

    // Follow shared asset directories, but stop symlink cycles on this branch
    if (ancestors.has(realPath)) {
        return;
    }

    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const relativePath = path.join(relativeDirectory, entry.name);
        let urlPath = `/${relativePath.split(path.sep).join('/')}`;

        try {
            if (fs.statSync(path.join(options.directory, relativePath)).isDirectory()) {
                walk(relativePath, new Set([...ancestors, realPath]));
                continue;
            }

            if (path.extname(entry.name) === '.scss') {
                // SASS partials are compiled through the files that import them
                if (entry.name.startsWith('_')) {
                    continue;
                }

                urlPath = urlPath.replace(/\.scss$/, '.css');
            }

            workerThreads.parentPort.postMessage({ file: processor.processFile(urlPath, options), urlPath });
        } catch (err) {
            workerThreads.parentPort.postMessage({ error: `${urlPath}:\n    ${err}` });
        }
    }
}

walk('', new Set());
