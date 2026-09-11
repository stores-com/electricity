const path = require('node:path');
const { Worker } = require('node:worker_threads');

module.exports = (directory, options, files) => new Promise((resolve, reject) => {
    // A worker has its own dependency graphs, so leave development invalidation alone.
    if (options.watch.enabled) {
        throw new Error('Cache warming is not supported with watch enabled.');
    }

    // Only compilation options cross the worker boundary (not HTTP headers, etc.).
    const { babel, gzip, hashify, hostname, sass, snockets, uglifycss, uglifyjs } = options;
    let worker;

    try {
        worker = new Worker(path.join(__dirname, 'warmup-worker.js'), {
            name: 'electricity-warmup',
            workerData: {
                directory,
                options: { babel, gzip, hashify, hostname, sass, snockets, uglifycss, uglifyjs }
            }
        });
    } catch (cause) {
        throw new Error('Unable to start cache warming. Compiler options must be structured-cloneable; use module paths for Babel plugins instead of functions.', { cause });
    }

    const errors = [];
    let complete = false;

    worker.on('message', ({ type, urlPath, file, error }) => {
        if (type === 'file') {
            // A request may have populated this entry while the worker was building it.
            if (files[urlPath]) {
                return;
            }

            // Structured cloning turns Buffers into Uint8Arrays; Express needs Buffers.
            if (file.content instanceof Uint8Array) {
                file.content = Buffer.from(file.content);
            }

            if (file.gzip) {
                file.gzip.content = Buffer.from(file.gzip.content);
            }

            files[urlPath] = file;
        } else if (type === 'error') {
            errors.push(error);
        } else if (type === 'done') {
            complete = true;
        }
    });

    worker.once('error', reject);
    worker.once('messageerror', error => {
        reject(error);
        worker.terminate();
    });
    worker.once('exit', code => {
        if (code !== 0 || !complete) {
            reject(new Error(`Cache warming worker exited before completion (code ${code}).`));
        } else if (errors.length) {
            reject(new AggregateError(errors, `Unable to warm ${errors.length} asset(s).`));
        } else {
            resolve();
        }
    });
});
