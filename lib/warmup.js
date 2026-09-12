const path = require('node:path');
const workerThreads = require('node:worker_threads');

module.exports = (directory, options, cacheFile) => new Promise((resolve, reject) => {
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
    let failed = false;

    function fail(err) {
        failed = true;
        reject(err);
        worker.terminate();
    }

    worker.on('message', ({ error, file, type, urlPath }) => {
        if (failed) {
            return;
        }

        if (type === 'file') {
            try {
                // Structured cloning turns Buffers into Uint8Arrays; Express needs Buffers.
                if (file.content instanceof Uint8Array) {
                    file.content = Buffer.from(file.content);
                }

                if (file.gzip) {
                    file.gzip.content = Buffer.from(file.gzip.content);
                }

                cacheFile(urlPath, file);
            } catch (err) {
                fail(err);
            }
        } else if (type === 'error') {
            errors.push(error);
        } else if (type === 'done') {
            complete = true;
        }
    });

    worker.once('error', fail);

    worker.once('exit', code => {
        if (code !== 0 || !complete) {
            reject(new Error(`Cache warming worker exited before completion (code ${code}).`));
        } else if (errors.length) {
            reject(new AggregateError(errors, `Unable to warm ${errors.length} asset(s).`));
        } else {
            resolve();
        }
    });

    worker.once('messageerror', fail);
});
