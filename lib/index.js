const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const chokidar = require('chokidar');
const Negotiator = require('negotiator');

const { createProcessor, hashifyUrl, parseUrlPath } = require('./processor.js');

/**
 * Deeply checks whether a value contains any functions, which can't be
 * structured-cloned to a worker thread. When options carry functions (e.g. a
 * Babel plugin or Sass importer), the worker can't reproduce the main thread's
 * output, so background warming is disabled to avoid caching divergent results.
 * @param {*} value
 * @param {Set} [seen]
 */
function hasFunction(value, seen = new Set()) {
    if (typeof value === 'function') {
        return true;
    }

    if (value && typeof value === 'object') {
        if (seen.has(value)) {
            return false;
        }

        seen.add(value);

        for (const key of Object.keys(value)) {
            if (hasFunction(value[key], seen)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Restores Buffers lost to structured cloning. Binary content posted from the
 * worker arrives as a Uint8Array; wrap it back into a Buffer so it behaves like
 * a synchronously-read file.
 * @param {object} file
 */
function reviveFile(file) {
    if (typeof file.content !== 'string') {
        file.content = Buffer.from(file.content.buffer, file.content.byteOffset, file.content.byteLength);
    }

    if (file.gzip && typeof file.gzip.content !== 'string') {
        file.gzip.content = Buffer.from(file.gzip.content.buffer, file.gzip.content.byteOffset, file.gzip.content.byteLength);
    }

    return file;
}

// A shared pool of worker threads warms every electricity.static() instance in
// the process. The pool is created lazily on the first warm job and reused from
// then on, so the heavy transform libraries (Babel/Sass/UglifyJS) load once per
// worker rather than once per instance. It's sized to leave a core free for the
// event loop that serves live traffic.
const WARM_POOL_SIZE = Math.max(1, os.availableParallelism() - 1);

let warmPool = null;
let warmPoolFailed = false;
let nextWarmJobId = 0;

// Maps a job id to the processor receiving that job's entries and the number of
// shards still working on it.
const warmJobs = new Map();

function handleWarmMessage({ done, file, jobId, urlPath }) {
    const job = warmJobs.get(jobId);

    if (!job) {
        return;
    }

    if (done) {
        job.pending--;

        if (job.pending === 0) {
            warmJobs.delete(jobId);
        }

        return;
    }

    // Don't clobber an entry a request already populated via the synchronous
    // fallback, or one another shard already posted; all produce identical
    // content.
    if (!job.processor.files[urlPath]) {
        job.processor.files[urlPath] = reviveFile(file);
    }
}

/**
 * Returns the shared warm worker pool, creating it on first use. Returns null
 * if the pool can't be created, in which case warming is skipped and the
 * synchronous read remains the only path.
 */
function getWarmPool() {
    if (warmPool || warmPoolFailed) {
        return warmPool;
    }

    const pool = [];

    try {
        for (let i = 0; i < WARM_POOL_SIZE; i++) {
            const worker = new Worker(path.join(__dirname, 'warmer.js'));

            worker.on('message', handleWarmMessage);
            worker.on('error', (err) => {
                //eslint-disable-next-line no-console
                console.warn(`Electricity cache warming error:\n    ${err}`);
            });

            // Never let warming hold the process open.
            worker.unref();

            pool.push(worker);
        }
    } catch (err) {
        warmPoolFailed = true;
        pool.forEach(worker => worker.terminate());
        //eslint-disable-next-line no-console
        console.warn(`Electricity skipping cache warming:\n    ${err}`);
        return null;
    }

    warmPool = pool;

    return warmPool;
}

/**
 * Queues a warm job across the worker pool. Each worker reads and processes a
 * disjoint shard of the directory's files, posting finished cache entries back
 * so the expensive first read (Sass/Babel/UglifyJS/gzip) stays off the event
 * loop.
 * @param {string} directory
 * @param {object} options
 * @param {object} processor
 */
function startWarmer(directory, options, processor) {
    const pool = getWarmPool();

    if (!pool) {
        return;
    }

    const jobId = nextWarmJobId++;

    warmJobs.set(jobId, { pending: pool.length, processor });

    pool.forEach((worker, shardIndex) => {
        worker.postMessage({ directory, jobId, options, shardCount: pool.length, shardIndex });
    });
}

exports.static = (directory, options) => {
    // Default to 'public' if the directory is not specified
    directory = directory || 'public';

    // Options are optional
    if (!options) {
        options = {};
    }

    if (!options.babel) {
        options.babel = {};
    }

    // Enable gzip by default
    if (!options.gzip) {
        options.gzip = {
            enabled: true
        };
    }

    // Hashify by default
    if (!Object.prototype.hasOwnProperty.call(options, 'hashify')) {
        options.hashify = true;
    }

    if (!options.sass) {
        options.sass = {};
    }

    if (!options.snockets) {
        options.snockets = {};
    }

    // Snockets must be processed syncronously to produce consistent output
    options.snockets.async = false;

    // UglifyCSS by default
    if (!options.uglifycss) {
        options.uglifycss = {
            enabled: true
        };
    }

    // UglifyJS by default
    if (!options.uglifyjs) {
        options.uglifyjs = {
            enabled: true,
            module: false
        };
    }

    // Don't watch for changes by default
    if (!options.watch) {
        options.watch = {
            enabled: false
        };
    }

    let watcher;

    if (options.watch.enabled) {
        // Setup the watcher
        watcher = chokidar.watch(directory, { ignoreInitial: true });
    }

    const processor = createProcessor(directory, options, watcher);

    if (watcher) {
        watcher.on('all', (eventName, filePath) => {
            processor.removeFile(filePath);
        });
    }

    // Warm the cache on a background thread so the first request for a file
    // doesn't read and process it synchronously on the event loop. Watching
    // keeps processing on the main thread (it registers discovered
    // dependencies with the watcher), and options carrying functions can't be
    // cloned into the worker, so warming is skipped in those cases.
    if (!options.watch.enabled && !hasFunction(options)) {
        startWarmer(directory, options, processor);
    }

    return function staticMiddleware(req, res, next) {
        // Register function in app.locals to help views build URLs: https://expressjs.com/en/api.html#app.locals
        if (req.app && !req.app.locals.electricity) {
            req.app.locals.electricity = {
                url: processor.urlBuilder
            };
        }

        // Ignore anything that's not a GET or HEAD request
        if (!['GET', 'HEAD'].includes(req.method)) {
            return next();
        }

        let file;
        const request = parseUrlPath(req.path);

        try {
            file = processor.fetchFile(request.path);
        } catch (err) {
            // Handle EISDIR (Is a directory): https://nodejs.org/api/errors.html#common-system-errors
            if (err.code === 'EISDIR') {
                return next();
            }

            // Handle ENOENT (No such file or directory): https://nodejs.org/api/errors.html#common-system-errors
            if (err.code === 'ENOENT') {
                return next();
            }

            // Handle "no such file or directory"
            if (err.message.includes('no such file or directory')) {
                return next();
            }

            return next(err);
        }

        // Verify file matches the requested hash, otherwise 302
        if (options.hashify && request.hash !== file.hash) {
            res.set({
                'cache-control': 'no-cache',
                'expires': '0',
                'pragma': 'no-cache'
            });

            const url = hashifyUrl(request.path, file.hash);

            return res.redirect(url);
        }

        // Set a far-future expiration date
        const expires = new Date();
        expires.setFullYear(expires.getFullYear() + 1);

        res.set({
            'cache-control': 'public, max-age=31536000',
            'content-Type': file.contentType,
            etag: file.hash,
            expires: expires.toUTCString()
        });

        // Set any other headers specified in options
        if (options.headers) {
            res.set(options.headers);
        }

        const ifNoneMatch = req.get('if-none-match');

        // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/If-None-Match
        if (ifNoneMatch?.includes(file.hash)) {
            return res.sendStatus(304);
        }

        // By default, send the file's content (without gzip)
        let content = file.content;
        let contentLength = file.contentLength;

        // Check to see if the file could be gzipped
        if (file.gzip?.content) {
            const negotiator = new Negotiator(req);

            // Ensure the request supports gzip
            if (negotiator.encodings().includes('gzip')) {
                content = file.gzip.content;
                contentLength = file.gzip.contentLength;

                res.set('content-encoding', 'gzip');
            }
        }

        // Set the content-length header
        res.set('content-length', contentLength);

        // Return early without sending content for HEAD requests
        if (req.method === 'HEAD') {
            return res.sendStatus(200);
        }

        res.send(content);
    };
};
