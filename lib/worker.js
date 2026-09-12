const fs = require('node:fs');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const assets = require('./assets');

const directory = workerThreads.workerData.directory;
const options = workerThreads.workerData.options;
const cache = assets.create(directory, options, (urlPath, file) => {
    workerThreads.parentPort.postMessage({ file, type: 'file', urlPath });
});

function reportError(urlPath, cause) {
    const error = new Error(`Unable to warm ${urlPath}: ${cause.message}`, { cause });
    workerThreads.parentPort.postMessage({ error, type: 'error' });
}

function walk(relativeDirectory, ancestors = new Set()) {
    const filePath = path.join(directory, relativeDirectory);

    try {
        // Follow shared asset directories, but stop symlink cycles on this branch.
        const realPath = fs.realpathSync(filePath);

        if (ancestors.has(realPath)) {
            return;
        }

        const parents = new Set([...ancestors, realPath]);

        for (const entry of fs.readdirSync(filePath, { withFileTypes: true })) {
            const relativePath = path.join(relativeDirectory, entry.name);
            let urlPath = `/${relativePath.split(path.sep).join('/')}`;

            try {
                const stat = entry.isSymbolicLink() ? fs.statSync(path.join(directory, relativePath)) : entry;

                if (stat.isDirectory()) {
                    walk(relativePath, parents);
                } else if (stat.isFile()) {
                    if (path.extname(entry.name) === '.scss') {
                        // Sass partials are compiled through their entry points.
                        if (entry.name.startsWith('_')) {
                            continue;
                        }

                        urlPath = urlPath.replace(/\.scss$/, '.css');
                    }

                    // The cache preserves CSS-over-SCSS precedence and reports each new file.
                    cache.fetch(urlPath);
                }
            } catch (error) {
                reportError(urlPath, error);
            }
        }
    } catch (error) {
        reportError(`/${relativeDirectory}`, error);
    }
}

walk('');
workerThreads.parentPort.postMessage({ type: 'done' });
