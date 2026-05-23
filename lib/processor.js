const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const mime = require('mime');
const sass = require('sass');
const sassGraph = require('sass-graph');
const Snockets = require('snockets');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

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
 * @param {string} urlPath
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

/**
 * Creates a file processor bound to a directory and a set of options.
 * The processor owns its own in-memory cache, so the same logic can run on
 * the main thread (serving requests) or inside a worker thread (warming the
 * cache). When no watcher is supplied (the production / worker case) the
 * watch-only side effects are skipped, so both contexts produce identical
 * cache entries for the same file.
 * @param {string} directory
 * @param {object} options
 * @param {object} [watcher]
 */
function createProcessor(directory, options, watcher) {
    // Create a local cache to hold the files
    const files = {};

    const snockets = new Snockets();

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
     * @param {string} filePath
     */
    function toUrlPath(filePath) {
        const urlPath = path.posix.relative(directory, path.resolve(filePath));

        return `/${urlPath}`;
    }

    return {
        files,
        fetchFile,
        removeFile,
        toUrlPath,
        urlBuilder
    };
}

module.exports = {
    createProcessor,
    hashifyUrl,
    parseUrlPath
};
