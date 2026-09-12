const path = require('node:path');
const workerThreads = require('node:worker_threads');

const chokidar = require('chokidar').default;
const Negotiator = require('negotiator');

const processor = require('./processor');

exports.static = (directory = 'public', options = {}) => {
    directory = path.resolve(directory);

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
    if (!Object.hasOwn(options, 'hashify')) {
        options.hashify = true;
    }

    // Warm the cache by default
    if (!Object.hasOwn(options, 'warmup')) {
        options.warmup = true;
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

    // Create a local cache to hold the files
    const files = {};
    const processFile = processor.create(directory, options);

    let watcher;

    if (options.watch.enabled) {
        // Setup the watcher
        watcher = chokidar.watch(directory, { ignoreInitial: true });

        watcher.on('all', (eventName, filePath) => {
            removeFile(filePath);
        });
    }

    if (options.warmup) {
        try {
            const worker = new workerThreads.Worker(path.join(__dirname, 'worker.js'), {
                name: 'electricity-warmup',
                workerData: { directory, options }
            });

            worker.on('message', message => {
                if (message.error) {
                    return warn(message.error);
                }

                try {
                    // Structured cloning turns Buffers into Uint8Arrays; Express needs Buffers.
                    if (message.file.content instanceof Uint8Array) {
                        message.file.content = Buffer.from(message.file.content);
                    }

                    if (message.file.gzip) {
                        message.file.gzip.content = Buffer.from(message.file.gzip.content);
                    }

                    // A request may have built a newer entry while the worker was running.
                    if (!files[message.urlPath]) {
                        cacheFile(message.urlPath, message.file);
                    }
                } catch (err) {
                    warn(err);
                }
            });

            worker.on('error', warn);

            worker.on('exit', code => {
                if (code !== 0) {
                    warn(new Error(`Cache warming worker exited with code ${code}.`));
                }
            });
        } catch (err) {
            warn(err);
        }
    }

    /**
     * Stores a processed file and registers its sources with the watcher.
     * @param {string} urlPath Public URL path of the file.
     * @param {Object} file Processed file record.
     */
    function cacheFile(urlPath, file) {
        watcher?.add(file.dependencies);
        files[urlPath] = file;
    }

    /**
     * Returns a file from the cache, processing it when absent.
     * @param {string} urlPath Public URL path of the file.
     * @returns {Object} Processed file record.
     */
    function fetchFile(urlPath) {
        if (!files[urlPath]) {
            cacheFile(urlPath, processFile(urlPath));
        }

        return files[urlPath];
    }

    /**
     * Removes cached files affected by a source change, including Sass and JS imports.
     * @param {string} filePath Changed source path.
     */
    function removeFile(filePath) {
        const absoluteFilePath = path.resolve(filePath);

        for (const [urlPath, file] of Object.entries(files)) {
            if (file.dependencies.some(dependency => dependency === absoluteFilePath ||
                dependency.startsWith(`${absoluteFilePath}${path.sep}`))) {
                delete files[urlPath];
            }
        }
    }

    /**
     * Builds an asset URL with its content hash and CDN hostname when configured.
     * @param {string} urlPath Public URL path of the asset.
     * @returns {string} Asset URL, or the original path when the asset is unavailable.
     */
    function urlBuilder(urlPath) {
        try {
            return processor.url(urlPath, options, fetchFile(processor.parse(urlPath).path).hash);
        } catch (err) {
            // Preserve URLs that do not resolve to a local file.
            return urlPath;
        }
    }

    /**
     * Reports a cache warming failure.
     * @param {Error} error
     */
    function warn(error) {
        // eslint-disable-next-line no-console
        console.warn('Electricity cache warming failed:', error);
    }

    function staticMiddleware(req, res, next) {
        // Register function in app.locals to help views build URLs: https://expressjs.com/en/api.html#app.locals
        if (req.app && !req.app.locals.electricity) {
            req.app.locals.electricity = {
                url: urlBuilder
            };
        }

        // Ignore anything that's not a GET or HEAD request
        if (!['GET', 'HEAD'].includes(req.method)) {
            return next();
        }

        let file;
        const request = processor.parse(req.path);

        try {
            file = fetchFile(request.path);
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

            const url = processor.hashify(request.path, file.hash);

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
    }

    return staticMiddleware;
};
