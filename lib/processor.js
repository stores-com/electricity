const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const mime = require('mime');
const sass = require('sass');
const Snockets = require('snockets');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

/**
 * Applies the configured hash and CDN hostname to a URL path.
 * @param {string} urlPath
 * @param {Object} options
 * @param {string} hash
 */
exports.buildUrl = (urlPath, options, hash) => {
    let url = urlPath;

    if (options.hashify) {
        url = exports.hashifyUrl(exports.parseUrlPath(urlPath).path, hash);
    }

    if (options.hostname) {
        url = `https://${options.hostname}${url}`;
    }

    return url;
};

/**
 * Converts a URL (/robots.txt) to a URL that includes the file's hash (/robots-3f54004ef6fc21b24a9e6069fc114fd9070b77a1.txt)
 * @param {string} url
 * @param {string} hash
 */
exports.hashifyUrl = (url, hash) => {
    if (!url.includes('.')) {
        return url.replace(/([?#].*)?$/, `-${hash}$1`);
    }

    return url.replace(/\.([^.]*)([?#].*)?$/, `-${hash}.$1$2`);
};

/**
 * Parses a URL path potentially containing a hash (/robots-3f54004ef6fc21b24a9e6069fc114fd9070b77a1.txt)
 * into an object with a hash and path properties ({ hash: '3f54004ef6fc21b24a9e6069fc114fd9070b77a1', path: '/robots.txt' })
 * @param {string} urlPath
 */
exports.parseUrlPath = urlPath => {
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
};

/**
 * Reads a file and computes its response metadata and optional gzip content.
 * @param {string} directory
 * @param {Object} options
 * @param {string} urlPath
 * @returns {Object} Content, response metadata, source dependencies, and optional gzip content.
 */
exports.processFile = (directory, options, urlPath) => {
    const myURL = new URL(urlPath, 'https://example.org/');
    const filePath = path.resolve(directory, myURL.pathname.replace(/^\//, ''));
    const extension = path.extname(filePath);
    const dependencies = [filePath];
    let data;

    if (extension === '.css') {
        // CSS
        try {
            data = fs.readFileSync(filePath).toString();
        } catch (err) {
            // Handle ENOENT (No such file or directory): https://nodejs.org/api/errors.html#common-system-errors
            if (err.code !== 'ENOENT') {
                throw err;
            }

            // SASS
            const basename = path.basename(filePath, extension);
            const sassFile = path.join(path.dirname(filePath), `${basename}.scss`);
            const result = sass.compile(sassFile, options.sass);

            data = result.css;

            result.loadedUrls.forEach(loadedUrl => {
                if (loadedUrl.protocol === 'file:') {
                    dependencies.push(url.fileURLToPath(loadedUrl));
                }
            });
        }

        // Update URLs in CSS: https://regex101.com/r/FxrppP/4
        data = data.replace(/url\(['"]?(.*?)['"]?\)/g, (match, p1) => {
            try {
                const asset = exports.processFile(directory, options, exports.parseUrlPath(p1).path);

                return `url(${exports.buildUrl(p1, options, asset.hash)})`;
            } catch (err) {
                // If we don't have a file that matches the specified URL path simply return the original URL path
                return `url(${p1})`;
            }
        });

        // UglifyCSS
        if (options.uglifycss.enabled) {
            data = UglifyCss.processString(data, options.uglifycss);
        }
    } else if (extension === '.js') {
        const snockets = new Snockets();

        // Snockets
        try {
            data = snockets.getConcatenation(filePath, options.snockets);
        } catch(err) {
            // Snockets can't parse, so just pass the js file along
            //eslint-disable-next-line no-console
            console.warn(`Snockets skipping ${filePath}:\n    ${err}`);
        }

        // Snockets (dependencies)
        if (options.watch.enabled) {
            try {
                // Get all files in the snockets chain
                const compiledChain = snockets.getCompiledChain(filePath, options.snockets);

                compiledChain.forEach(c => {
                    dependencies.push(c.filename);
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
            const result = babel.transformSync(data, {
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
    } else {
        data = fs.readFileSync(filePath);
    }

    const file = {
        content: data,
        contentLength: data.length,
        contentType: mime.getType(urlPath),
        dependencies: [...new Set(dependencies)],
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
};
