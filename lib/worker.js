const fs = require('node:fs');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const processor = require('./processor');

const options = workerThreads.workerData.options;

/**
 * Processes every file below a directory and sends each result to the middleware.
 * @param {string} relativeDirectory Directory to process, relative to the asset directory.
 */
function walk(relativeDirectory) {
    for (const entry of fs.readdirSync(path.join(options.directory, relativeDirectory), { withFileTypes: true })) {
        const relativePath = path.join(relativeDirectory, entry.name);
        let urlPath = `/${relativePath.split(path.sep).join('/')}`;

        if (entry.isDirectory()) {
            walk(relativePath);
        } else if (entry.isFile()) {
            try {
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
}

walk('');
