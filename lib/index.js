const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const chokidar = require('chokidar');
const mime = require('mime');
const Negotiator = require('negotiator');
const sass = require('sass');
const sassGraph = require('sass-graph');
const Snockets = require('snockets');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

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
        file = readFile(urlPath);

        // Put the file in local cache
        files[urlPath] = file;

        return file;
    }

    /**
     * Converts a URL (/robots.txt) to a URL that includes the file's hash (/robots-3f54004ef6fc21b24a9e6069fc114fd9070b77a1.txt)
     * @param {string} url
     * @param {string} hash
     */
    function hashifyUrl(url, hash) {
        if (!url.includes('.')) {
            return url.replace(/([?#].*)?$/, `-${hash}$1`);
        }

        return url.replace(/\.([^.]*)([?#].*)?$/, `-${hash}.$1$2`);
    }

    /**
     * Parses a URL path potentially containing a hash (/robots-3f54004ef6fc21b24a9e6069fc114fd9070b77a1.txt)
     * into an object with a hash and path properties ({ hash: '3f54004ef6fc21b24a9e6069fc114fd9070b77a1', path: '/robots.txt' })
     * @param {object} req
     */
    function parseUrlPath(urlPath) {
        // https://regex101.com/r/j5hvRj/2
        const regex = /\/.+(-([0-9a-f]{32,40}))/;
        const matches = urlPath.match(regex);

        if (!matches) {
            return {
                path: urlPath
            };
        }

        return {
            hash: matches[2],
            path: urlPath.replace(matches[1], '')
        };
    }

    function readCascadingStyleSheetsFile(filePath) {
        let data;

        // CSS
        try {
            data = fs.readFileSync(filePath).toString();
        } catch (err) {
            // Handle ENOENT (No such file or directory): https://nodejs.org/api/errors.html#common-system-errors
            if (err.code !== 'ENOENT') {
                throw err;
            }

            // SASS
            const basename = path.basename(filePath, path.extname(filePath));
            const sassFile = path.join(path.dirname(filePath), `${basename}.scss`);
            const result = sass.compile(sassFile, options.sass);

            data = result.css;

            // SASS (watcher)
            if (watcher) {
                result.loadedUrls.forEach(file => {
                    watcher.add(file.pathname);
                });
            }
        }

        // Update URLs in CSS: https://regex101.com/r/FxrppP/4
        data = data.replace(/url\(['"]?(.*?)['"]?\)/g, (match, p1) => {
            return `url(${urlBuilder(p1)})`;
        });

        // UglifyCSS
        if (options.uglifycss.enabled) {
            data = UglifyCss.processString(data, options.uglifycss);
        }

        return data;
    }

    function readFile(urlPath) {
        let filePath = toFilePath(urlPath);
        let extension = path.extname(filePath);
        let data;

        if (extension === '.css') {
            data = readCascadingStyleSheetsFile(filePath);
        } else if (extension === '.js') {
            data = readJavaScriptFile(filePath);
        } else {
            data = fs.readFileSync(filePath);
        }

        const file = {
            content: data,
            contentLength: data.length,
            contentType: mime.getType(urlPath),
            hash: crypto.createHash('sha1').update(data).digest('hex')
        };

        // Don't gzip any content less that 1500 bytes (the size of a TCP packet). Only gzip specific content types.
        if (options.gzip.enabled && file.contentLength > 1500 && gzipContentTypes.includes(file.contentType)) {
            const gzipContent = zlib.gzipSync(file.content);

            file.gzip = {
                content: gzipContent,
                contentLength: gzipContent.length
            };
        }

        return file;
    }

    function readJavaScriptFile(filePath) {
        let data;

        // Snockets
        try {
            data = snockets.getConcatenation(filePath, options.snockets);
        } catch(err) {
            // Snockets can't parse, so just pass the js file along
            //eslint-disable-next-line no-console
            console.warn(`Snockets skipping ${filePath}:\n    ${err}`);
        }

        // Snockets (watcher)
        if (watcher) {
            try {
                // Get all files in the snockets chain
                const compiledChain = snockets.getCompiledChain(filePath, options.snockets);

                // Add each file of the snockets chain to the watcher
                compiledChain.forEach(c => {
                    watcher.add(c.filename);
                });
            } catch(err) {
                // Snockets can't parse, so skip watch
                //eslint-disable-next-line no-console
                console.warn(`Snockets skipping watch for ${filePath}:\n    ${err}`);
            }
        }

        // If Snockets didn't parse the file, read it from disk
        if (!data) {
            data = fs.readFileSync(filePath).toString();
        }

        // Babel
        try {
            let result = babel.transformSync(data, {
                ...options.babel,
                presets: [require('@babel/preset-react')]
            });

            data = result.code;
        } catch(err) {
            // Babel can't transform, so just pass the file along
            //eslint-disable-next-line no-console
            console.warn(`Babel skipping ${filePath}:\n    ${err}`);
        }

        // UglifyJS
        if (options.uglifyjs.enabled) {
            const uglifyjsOptions = JSON.parse(JSON.stringify(options.uglifyjs));
            delete uglifyjsOptions.enabled;

            const result = UglifyJS.minify(data, uglifyjsOptions);

            if (result.error) {
                //eslint-disable-next-line no-console
                console.warn(`UglifyJS skipping ${filePath}:\n    ${JSON.stringify(result.error)}`);
            } else {
                data = result.code;
            }
        }

        return data;
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
        let file;
        const request = parseUrlPath(urlPath);
        let url = urlPath;

        try {
            file = fetchFile(request.path);
        } catch(err) {
            // If we don't have a file that matches the specified URL path simply return the original URL path
            return urlPath;
        }

        if (options.hashify) {
            url = hashifyUrl(request.path, file.hash);
        }

        if (options.hostname) {
            url = `https://${options.hostname}${url}`;
        }

        return url;
    }

    /**
     * Converts a URL path (/robots.txt) to a file path (/Users/username/site/public/robots.txt).
     * @param {string} urlPath
     */
    function toFilePath(urlPath) {
        const myURL = new URL(urlPath, 'https://example.org/');
        const pathname = myURL.pathname.replace(/^\//, '');
        return path.resolve(directory, pathname);
    }

    /**
     * Converts a file path (/Users/username/site/public/robots.txt) to a URL path (/robots.txt).
     * @param {string} urlPath
     */
    function toUrlPath(filePath) {
        const urlPath = path.posix.relative(directory, path.resolve(filePath));

        return `/${urlPath}`;
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
        const request = parseUrlPath(req.path);

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