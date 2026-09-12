const events = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const chokidar = require('chokidar').default;
const Negotiator = require('negotiator');

const processor = require('./processor');
const urls = require('./urls');
const warmup = require('./warmup');

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
    const aliases = new Map();

    let watcher;
    let watchedDirectories;
    let watchedFiles;

    if (options.watch.enabled) {
        // Setup the watcher
        watcher = chokidar.watch(directory, { ignoreInitial: true });

        watcher.on('ready', () => {
            watchedDirectories = new Set();
            watchedFiles = new Set();
            const root = realPath(directory);

            // Freeze the initial coverage; later add() calls are asynchronous.
            for (const [parent, names] of Object.entries(watcher.getWatched())) {
                // getWatched() also includes bookkeeping parents outside the root.
                const resolved = realPath(parent);
                const relativePaths = [path.relative(directory, parent), path.relative(root, resolved)];
                if (relativePaths.some(relative => relative !== '..' &&
                    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
                    watchedDirectories.add(resolved);
                }

                for (const name of names) {
                    watchedFiles.add(realPath(path.join(parent, name)));
                }
            }
            watchedDirectories.delete(undefined);
            watchedFiles.delete(undefined);
        });

        watcher.on('all', (eventName, filePath) => {
            removeFile(filePath);
        });
    }

    const processFile = processor(directory, options, urlBuilder);

    let warming;

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
        file = processFile(urlPath);

        if (watcher) {
            watcher.add(file.dependencies);
        }

        // Put the file in local cache
        files[urlPath] = file;

        return file;
    }

    /**
     * Resolves source paths, including symlinks and missing Sass .css entry points.
     * Retains symlink aliases so deleted sources can still invalidate their parents.
     * @param {string} filePath Source path.
     * @returns {string|undefined} Resolved path, or undefined if unavailable.
     */
    function realPath(filePath) {
        try {
            const resolved = fs.realpathSync(filePath);
            if (resolved !== filePath) {
                aliases.set(filePath, resolved);
            } else {
                aliases.delete(filePath);
            }
            return resolved;
        } catch {
            if (aliases.has(filePath)) {
                return aliases.get(filePath);
            }

            const parent = path.dirname(filePath);
            if (parent !== filePath) {
                const resolved = realPath(parent);
                if (resolved) {
                    return path.join(resolved, path.basename(filePath));
                }
            }
        }
    }

    /**
     * Removes cached files affected by a source change, including Sass and JS imports.
     * @param {string} filePath Changed source path.
     */
    function removeFile(filePath) {
        const absoluteFilePath = path.resolve(filePath);
        const previousPath = aliases.get(absoluteFilePath);
        const resolvedFilePath = realPath(absoluteFilePath);
        const changedPaths = [absoluteFilePath, previousPath, resolvedFilePath].filter(Boolean);

        // A retargeted directory invalidates the old mappings beneath it too.
        for (const alias of aliases.keys()) {
            if (alias.startsWith(`${absoluteFilePath}${path.sep}`)) {
                aliases.delete(alias);
            }
        }

        for (const [urlPath, file] of Object.entries(files)) {
            if (file.dependencies.some(dependency => changedPaths.some(changedPath =>
                dependency === changedPath || dependency.startsWith(`${changedPath}${path.sep}`)))) {
                delete files[urlPath];
            }
        }
    }

    function urlBuilder(urlPath) {
        return urls.build(urlPath, options, fetchFile);
    }

    /**
     * Warms once after watch setup, accepting results only while the sources stay unchanged.
     * @returns {Promise<void>} Completion of the initial warming pass.
     */
    async function warmFiles() {
        if (watcher && !watchedDirectories) {
            await events.once(watcher, 'ready');
        }

        let stopped = false;
        const stopWarming = () => { stopped = true; };
        watcher?.once('all', stopWarming);

        try {
            await warmup(directory, options, (urlPath, file) => {
                if (stopped) {
                    return;
                }

                if (watcher) {
                    // Imports outside the established watches remain lazy for this pass.
                    const unwatched = file.dependencies.filter(filePath => {
                        const resolved = realPath(filePath);
                        return resolved === undefined ||
                            (!watchedFiles.has(resolved) && !watchedDirectories.has(path.dirname(resolved)));
                    });
                    if (unwatched.length) {
                        watcher.add(unwatched);
                        stopWarming();
                        return;
                    }
                }

                // A request may have built a newer entry while the worker was running.
                if (!files[urlPath]) {
                    files[urlPath] = file;
                }
            });
        } catch (err) {
            // Edits can remove sources that the abandoned worker pass has yet to read.
            if (!stopped || !(err instanceof AggregateError)) {
                throw err;
            }
        } finally {
            watcher?.removeListener('all', stopWarming);
        }
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
        const request = urls.parse(req.path);

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

            const url = urls.hashify(request.path, file.hash);

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

    staticMiddleware.warmup = () => {
        warming ||= warmFiles();
        return warming;
    };

    if (options.warmup !== false) {
        staticMiddleware.warmup().catch(error => {
            // eslint-disable-next-line no-console
            console.warn('Electricity cache warming failed:', error);
        });
    }

    return staticMiddleware;
};
