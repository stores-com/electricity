const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const mime = require('mime').default;
const sass = require('sass');
const Snockets = require('snockets');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

/**
 * Creates the asset cache shared by the static middleware and the warmup worker.
 * @param {string} directory Absolute path to the asset directory.
 * @param {Object} options Processing options initialized by the static middleware.
 * @param {function(string, Object)} [onFile] Called with each newly cached file.
 * @returns {Object} Cache with add, fetch, remove, and url functions.
 */
exports.create = (directory, options, onFile) => {
    const files = {};
    const snockets = new Snockets();

    /**
     * Caches a file processed elsewhere, keeping any entry already built here.
     * @param {string} urlPath Public URL path of the file.
     * @param {Object} file Processed file record.
     */
    function add(urlPath, file) {
        if (!files[urlPath]) {
            store(urlPath, file);
        }
    }

    /**
     * Returns a file from the cache, processing it when absent.
     * @param {string} urlPath Public URL path of the file.
     * @returns {Object} Processed file record.
     */
    function fetch(urlPath) {
        if (!files[urlPath]) {
            store(urlPath, processFile(urlPath));
        }

        return files[urlPath];
    }

    /**
     * Processes a file and computes its response metadata and optional gzip content.
     * @param {string} urlPath Public URL path of the file to process.
     * @returns {Object} Content, response metadata, optional gzip data, and dependency paths in watch mode.
     */
    function processFile(urlPath) {
        let filePath = toFilePath(urlPath);
        let extension = path.extname(filePath);
        let result;

        if (extension === '.css') {
            result = readCascadingStyleSheetsFile(filePath);
        } else if (extension === '.js') {
            result = readJavaScriptFile(filePath);
        } else {
            result = { content: fs.readFileSync(filePath), dependencies: [] };
        }

        const file = {
            content: result.content,
            contentLength: Buffer.byteLength(result.content),
            contentType: mime.getType(urlPath),
            hash: crypto.createHash('sha1').update(result.content).digest('hex')
        };

        if (options.watch?.enabled) {
            file.dependencies = [...new Set([filePath, ...result.dependencies])];
        }

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

    /**
     * Reads CSS or compiles matching SCSS, rewrites asset URLs, and optionally minifies it.
     * @param {string} filePath Absolute path to the requested CSS file.
     * @returns {Object} Processed CSS content and the source paths it was compiled from.
     */
    function readCascadingStyleSheetsFile(filePath) {
        const dependencies = [];
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

            // Collect Sass dependencies for file watching.
            result.loadedUrls.forEach(file => {
                if (file.protocol === 'file:') {
                    dependencies.push(url.fileURLToPath(file));
                }
            });
        }

        // Update URLs in CSS: https://regex101.com/r/FxrppP/4
        data = data.replace(/url\(['"]?(.*?)['"]?\)/g, (match, p1) => {
            return `url(${buildUrl(p1)})`;
        });

        // UglifyCSS
        if (options.uglifycss.enabled) {
            data = UglifyCss.processString(data, options.uglifycss);
        }

        return { content: data, dependencies };
    }

    /**
     * Concatenates JavaScript dependencies, transforms JSX, and optionally minifies it.
     * @param {string} filePath Absolute path to the JavaScript file.
     * @returns {Object} Processed JavaScript content and the source paths it was concatenated from.
     */
    function readJavaScriptFile(filePath) {
        const dependencies = [];
        let data;

        // Snockets
        try {
            // The serving cache decides when to rebuild; discard stale Snockets output.
            delete snockets.concatCache[filePath];
            data = snockets.getConcatenation(filePath, options.snockets);
        } catch(err) {
            // Snockets can't parse, so just pass the js file along
            //eslint-disable-next-line no-console
            console.warn(`Snockets skipping ${filePath}:\n    ${err}`);
        }

        // Collect Snockets dependencies for file watching.
        if (options.watch?.enabled) {
            try {
                // Keep known dependencies even when recompiling the chain fails.
                dependencies.push(...snockets.depGraph.getChain(filePath));

                // Get all files in the snockets chain
                const compiledChain = snockets.getCompiledChain(filePath, options.snockets);

                // Report each file in the Snockets chain
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
            let result = babel.transformSync(data, {
                ...options.babel,
                // Assets run as standalone browser scripts using the global React object.
                presets: [[require.resolve('@babel/preset-react'), { runtime: 'classic', development: false }]]
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

        return { content: data, dependencies };
    }

    /**
     * Removes cached files affected by a source change, including Sass and JS imports.
     * @param {string} filePath Changed source path.
     */
    function remove(filePath) {
        const absoluteFilePath = path.resolve(filePath);

        for (const [urlPath, file] of Object.entries(files)) {
            if (file.dependencies.some(dependency => dependency === absoluteFilePath ||
                dependency.startsWith(`${absoluteFilePath}${path.sep}`))) {
                delete files[urlPath];
            }
        }
    }

    /**
     * Stores a file and reports it to the cache owner.
     * @param {string} urlPath Public URL path of the file.
     * @param {Object} file Processed file record.
     */
    function store(urlPath, file) {
        files[urlPath] = file;
        onFile?.(urlPath, file);
    }

    /**
     * Resolves a public URL path relative to the asset directory.
     * @param {string} urlPath Public URL path, optionally including a query string or fragment.
     * @returns {string} Absolute path to the source file.
     */
    function toFilePath(urlPath) {
        const myURL = new URL(urlPath, 'https://example.org/');
        const pathname = myURL.pathname.replace(/^\//, '');
        return path.resolve(directory, pathname);
    }

    /**
     * Builds an asset URL with its content hash and CDN hostname when configured.
     * @param {string} urlPath Public URL path of the asset.
     * @returns {string} Asset URL, or the original path when the asset is unavailable.
     */
    function buildUrl(urlPath) {
        let file;
        const request = exports.parse(urlPath);
        let built = urlPath;

        try {
            file = fetch(request.path);
        } catch(err) {
            // Preserve URLs that do not resolve to a local file.
            return urlPath;
        }

        if (options.hashify) {
            built = exports.hashify(request.path, file.hash);
        }

        if (options.hostname) {
            built = `https://${options.hostname}${built}`;
        }

        return built;
    }

    return { add, fetch, remove, url: buildUrl };
};

/**
 * Adds a file's hash to its URL while preserving the query string and fragment.
 * @param {string} urlPath
 * @param {string} hash
 */
exports.hashify = (urlPath, hash) => {
    if (!urlPath.includes('.')) {
        return urlPath.replace(/([?#].*)?$/, `-${hash}$1`);
    }

    return urlPath.replace(/\.([^.]*)([?#].*)?$/, `-${hash}.$1$2`);
};

/**
 * Separates an optional content hash from a URL path.
 * @param {string} urlPath
 */
exports.parse = urlPath => {
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
