const path = require('node:path');
const workerThreads = require('node:worker_threads');

const chokidar = require('chokidar');
const Negotiator = require('negotiator');

const processor = require('./processor');

exports.static = (directory = 'public', options = {}) => {
    if (!options.babel) {
        options.babel = {};
    }

    // Serve files from the specified directory
    options.directory = directory;

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

    // Warm the cache by default
    if (!Object.hasOwn(options, 'warmup')) {
        options.warmup = true;
    }

    // Don't watch for changes by default
    if (!options.watch) {
        options.watch = {
            enabled: false
        };
    }

    // Create a local cache to hold the files
    const files = {};

    let watcher;

    if (options.watch.enabled) {
        // Setup the watcher
        watcher = chokidar.watch(options.directory, { ignoreInitial: true });

        watcher.on('all', (eventName, filePath) => {
            removeFile(filePath);
        });
    }

    if (options.warmup) {
        // Process the files on a worker thread and cache the results as they arrive
        try {
            const worker = new workerThreads.Worker(path.join(__dirname, 'worker.js'), { workerData: { options } });

            worker.on('message', message => {
                if (message.error) {
                    //eslint-disable-next-line no-console
                    return console.warn(`Electricity skipping ${message.error}`);
                }

                // A request may have already cached a newer version of the file
                if (files[message.urlPath]) {
                    return;
                }

                // Structured cloning turns Buffers into Uint8Arrays, but Express needs Buffers
                if (message.file.content instanceof Uint8Array) {
                    message.file.content = Buffer.from(message.file.content);
                }

                if (message.file.gzip) {
                    message.file.gzip.content = Buffer.from(message.file.gzip.content);
                }

                cacheFile(message.urlPath, message.file);
            });

            worker.on('error', err => {
                //eslint-disable-next-line no-console
                console.warn(`Electricity skipping cache warming:\n    ${err}`);
            });
        } catch (err) {
            //eslint-disable-next-line no-console
            console.warn(`Electricity skipping cache warming:\n    ${err}`);
        }
    }

    /**
     * Puts a file in the local cache and watches the files it was built from.
     * @param {string} urlPath
     * @param {Object} file
     */
    function cacheFile(urlPath, file) {
        if (watcher) {
            watcher.add(file.dependencies);
        }

        files[urlPath] = file;
    }

    /**
     * Tries to read a file from local cache.
     * Reads the file from disk if it's not present in the local cache.
     * @param {string} urlPath
     */
    function fetchFile(urlPath) {
        // Try to get the file from local cache
        let file = files[urlPath];

        // Return the file from cache if found
        if (file) {
            return file;
        }

        // Read the file from disk
        file = processor.processFile(urlPath, options);

        cacheFile(urlPath, file);

        return file;
    }

    /**
     * Removes every cached file that was built from a changed source.
     * @param {string} filePath
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

    function urlBuilder(urlPath) {
        let file;
        const request = processor.parseUrlPath(urlPath);

        try {
            file = fetchFile(request.path);
        } catch(err) {
            // If we don't have a file that matches the specified URL path simply return the original URL path
            return urlPath;
        }

        return processor.toUrl(urlPath, file.hash, options);
    }

    return function staticMiddleware(req, res, next) {
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
        const request = processor.parseUrlPath(req.path);

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

            const url = processor.hashifyUrl(request.path, file.hash);

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