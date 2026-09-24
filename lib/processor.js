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
 * Reads a CSS file, or compiles the SASS file matching it.
 * @param {string} filePath
 * @param {Object} options
 * @returns {Object} CSS content and the sources it was compiled from.
 */
function readCascadingStyleSheetsFile(filePath, options) {
    const dependencies = [];
    let content;

    // CSS
    try {
        content = fs.readFileSync(filePath).toString();
    } catch (err) {
        // Handle ENOENT (No such file or directory): https://nodejs.org/api/errors.html#common-system-errors
        if (err.code !== 'ENOENT') {
            throw err;
        }

        // SASS
        const basename = path.basename(filePath, path.extname(filePath));
        const sassFile = path.join(path.dirname(filePath), `${basename}.scss`);
        const result = sass.compile(sassFile, options.sass);

        content = result.css;

        result.loadedUrls.forEach(loadedUrl => {
            if (loadedUrl.protocol === 'file:') {
                dependencies.push(url.fileURLToPath(loadedUrl));
            }
        });
    }

    // Update URLs in CSS: https://regex101.com/r/FxrppP/4
    content = content.replace(/url\(['"]?(.*?)['"]?\)/g, (match, p1) => {
        try {
            const asset = exports.processFile(exports.parseUrlPath(p1).path, options);

            return `url(${exports.toUrl(p1, asset.hash, options)})`;
        } catch (err) {
            // If we don't have a file that matches the specified URL path simply return the original URL path
            return `url(${p1})`;
        }
    });

    // UglifyCSS
    if (options.uglifycss.enabled) {
        content = UglifyCss.processString(content, options.uglifycss);
    }

    return { content, dependencies };
}

/**
 * Concatenates a JavaScript file with its Snockets dependencies and transforms JSX.
 * @param {string} filePath
 * @param {Object} options
 * @returns {Object} JavaScript content and the sources it was concatenated from.
 */
function readJavaScriptFile(filePath, options) {
    const dependencies = [];
    const snockets = new Snockets();
    let content;

    // Snockets
    try {
        content = snockets.getConcatenation(filePath, options.snockets);
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
    if (!content) {
        content = fs.readFileSync(filePath).toString();
    }

    // Babel
    try {
        const result = babel.transformSync(content, {
            ...options.babel,
            presets: [[require('@babel/preset-react'), { runtime: 'classic' }]]
        });

        content = result.code;
    } catch(err) {
        // Babel can't transform, so just pass the file along
        //eslint-disable-next-line no-console
        console.warn(`Babel skipping ${filePath}:\n    ${err}`);
    }

    // UglifyJS
    if (options.uglifyjs.enabled) {
        const uglifyjsOptions = JSON.parse(JSON.stringify(options.uglifyjs));
        delete uglifyjsOptions.enabled;

        const result = UglifyJS.minify(content, uglifyjsOptions);

        if (result.error) {
            //eslint-disable-next-line no-console
            console.warn(`UglifyJS skipping ${filePath}:\n    ${JSON.stringify(result.error)}`);
        } else {
            content = result.code;
        }
    }

    return { content, dependencies };
}

/**
 * Converts a URL (/robots.txt) to a URL that includes the file's hash (/robots-3f54004ef6fc21b24a9e6069fc114fd9070b77a1.txt)
 * @param {string} urlPath
 * @param {string} hash
 */
exports.hashifyUrl = (urlPath, hash) => {
    if (!urlPath.includes('.')) {
        return urlPath.replace(/([?#].*)?$/, `-${hash}$1`);
    }

    return urlPath.replace(/\.([^.]*)([?#].*)?$/, `-${hash}.$1$2`);
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
 * @param {string} urlPath
 * @param {Object} options
 * @returns {Object} Content, response metadata, the sources it was built from, and optional gzip content.
 */
exports.processFile = (urlPath, options) => {
    const myURL = new URL(urlPath, 'https://example.org/');
    const filePath = path.resolve(options.directory, myURL.pathname.replace(/^\//, ''));
    const extension = path.extname(filePath);
    let result;

    if (extension === '.css') {
        result = readCascadingStyleSheetsFile(filePath, options);
    } else if (extension === '.js') {
        result = readJavaScriptFile(filePath, options);
    } else {
        result = { content: fs.readFileSync(filePath), dependencies: [] };
    }

    const file = {
        content: result.content,
        contentLength: result.content.length,
        contentType: mime.getType(urlPath),
        dependencies: [...new Set([filePath, ...result.dependencies])],
        hash: crypto.createHash('sha1').update(result.content).digest('hex')
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

/**
 * Converts a URL path to the URL an asset is served from, including its hash and the CDN hostname.
 * @param {string} urlPath
 * @param {string} hash
 * @param {Object} options
 */
exports.toUrl = (urlPath, hash, options) => {
    let assetUrl = urlPath;

    if (options.hashify) {
        assetUrl = exports.hashifyUrl(exports.parseUrlPath(urlPath).path, hash);
    }

    if (options.hostname) {
        assetUrl = `https://${options.hostname}${assetUrl}`;
    }

    return assetUrl;
};