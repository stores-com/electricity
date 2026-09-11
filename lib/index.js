const fs = require('node:fs');
const path = require('node:path');

const chokidar = require('chokidar').default;
const Negotiator = require('negotiator');
const sassGraph = require('sass-graph');
const Snockets = require('snockets');

const createProcessor = require('./processor');
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

    // Create a local cache to hold the files
    const files = {};

    const snockets = new Snockets();

    let watcher;

    if (options.watch.enabled) {
        // Setup the watcher
        watcher = chokidar.watch(directory, { ignoreInitial: true });

        watcher.on('all', (eventName, filePath) => {
            removeFile(filePath);
        });
    }

    const processFile = createProcessor(directory, options, {
        snockets,
        urlBuilder,
        onDependency: watcher && (filePath => watcher.add(filePath))
    });
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

        // Put the file in local cache
        files[urlPath] = file;

        return file;
    }

    /**
     * Removes a file from the local cache.
     * @param {*} filePath
     */
    function removeFile(filePath) {
        let extension = path.extname(filePath);

        if (extension === '.js') {
            return removeJavaScriptFile(filePath);
        } else if (extension === '.scss') {
            return removeSassFile(filePath);
        }

        // Remove the changed file from the local cache
        delete files[toUrlPath(filePath)];
    }

    /**
     * Removes a JavaScript file from the local cache.
     * @param {string} filePath
     */
     function removeJavaScriptFile(filePath) {
        // Remove the changed file from the local cache
        delete files[toUrlPath(filePath)];

        // Resolve the absolute file path for the changed file
        const absoluteFilePath = path.resolve(filePath);

        // Find any parents that have a dependency on this file and remove them too
        snockets.depGraph.parentsOf(absoluteFilePath).forEach(removeJavaScriptFile);
    }

    /**
     * Removes a SASS file from the local cache.
     * @param {string} filePath
     */
     function removeSassFile(filePath) {
        const basename = path.basename(filePath, path.extname(filePath));
        const cssFilePath = path.join(path.dirname(filePath), `${basename}.css`);
        const urlPath = toUrlPath(cssFilePath);

        // Remove the changed file from the local cache
        delete files[urlPath];

        // Resolve the absolute file path for the changed file
        let absoluteFilePath = path.resolve(filePath);

        // Try to resolve symlinks
        try {
            absoluteFilePath = fs.realpathSync(filePath);
        } catch (e) {
            // ignore error
        }

        const graph = sassGraph.parseDir(directory);
        const sassFile = graph.index[absoluteFilePath];

        if (sassFile) {
            sassFile.importedBy.forEach(removeSassFile);
        }
    }

    function urlBuilder(urlPath) {
        return urls.build(urlPath, options, fetchFile);
    }

    /**
     * Converts a file path (/Users/username/site/public/robots.txt) to a URL path (/robots.txt).
     * @param {string} urlPath
     */
    function toUrlPath(filePath) {
        const urlPath = path.posix.relative(directory, path.resolve(filePath));

        return `/${urlPath}`;
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
        warming ||= warmup(directory, options, files);
        return warming;
    };

    return staticMiddleware;
};
