const path = require('node:path');
const workerThreads = require('node:worker_threads');

module.exports = (directory, options, files) => new Promise((resolve, reject) => {
    // A worker has its own dependency graphs, so leave development invalidation alone.
    if (options.watch.enabled) {
        throw new Error('Cache warming is not supported with watch enabled.');
    }

    let worker;

    try {
        worker = new workerThreads.Worker(path.join(__dirname, 'warmup-worker.js'), {
            name: 'electricity-warmup',
            workerData: { directory, options }
        });
    } catch (err) {
        throw new Error('Unable to start cache warming.', { cause: err });
    }

    const errors = [];
    let complete = false;

    worker.on('message', ({ error, file, type, urlPath }) => {
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

    worker.once('exit', code => {
        if (code !== 0 || !complete) {
            reject(new Error(`Cache warming worker exited before completion (code ${code}).`));
        } else if (errors.length) {
            reject(new AggregateError(errors, `Unable to warm ${errors.length} asset(s).`));
        } else {
            resolve();
        }
    });

    worker.once('messageerror', err => {
        reject(err);
        worker.terminate();
    });
});
