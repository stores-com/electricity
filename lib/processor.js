const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const mime = require('mime').default;
const sass = require('sass');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

/**
 * Creates the synchronous file-processing function shared by the middleware and warmup worker.
 * @param {string} directory Absolute path to the asset directory.
 * @param {Object} options Processing options initialized by the static middleware.
 * @param {Object} context Helpers supplied by the caller.
 * @param {Object} context.snockets Snockets instance for concatenation and dependency tracking.
 * @param {function(string): string} context.urlBuilder Builds asset URLs with configured hashes and CDN hostname.
 * @param {function(string): void} [context.onDependency] Receives dependency file paths, for example to watch them.
 * @returns {function(string): Object} Function that processes a public URL path into a file record.
 */
module.exports = (directory, options, context) => {
    /**
     * Processes a file and computes its response metadata and optional gzip content.
     * @param {string} urlPath Public URL path of the file to process.
     * @returns {Object} Content, byte length, MIME type, SHA-1 hash, and optional gzip data.
     */
    function processFile(urlPath) {
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
            contentLength: Buffer.byteLength(data),
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

    /**
     * Reads CSS or compiles matching SCSS, rewrites asset URLs, and optionally minifies it.
     * Reports Sass dependencies through context.onDependency when supplied.
     * @param {string} filePath Absolute path to the requested CSS file.
     * @returns {string} Processed CSS content.
     */
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

            // Report Sass dependencies when requested
            if (context.onDependency) {
                result.loadedUrls.forEach(file => {
                    context.onDependency(file.pathname);
                });
            }
        }

        // Update URLs in CSS: https://regex101.com/r/FxrppP/4
        data = data.replace(/url\(['"]?(.*?)['"]?\)/g, (match, p1) => {
            return `url(${context.urlBuilder(p1)})`;
        });

        // UglifyCSS
        if (options.uglifycss.enabled) {
            data = UglifyCss.processString(data, options.uglifycss);
        }

        return data;
    }

    /**
     * Concatenates JavaScript dependencies, transforms JSX, and optionally minifies it.
     * Reports dependencies when requested and logs processing failures while retaining available source.
     * @param {string} filePath Absolute path to the JavaScript file.
     * @returns {string} Processed JavaScript content.
     */
    function readJavaScriptFile(filePath) {
        let data;

        // Snockets
        try {
            data = context.snockets.getConcatenation(filePath, options.snockets);
        } catch(err) {
            // Snockets can't parse, so just pass the js file along
            //eslint-disable-next-line no-console
            console.warn(`Snockets skipping ${filePath}:\n    ${err}`);
        }

        // Report Snockets dependencies when requested
        if (context.onDependency) {
            try {
                // Get all files in the snockets chain
                const compiledChain = context.snockets.getCompiledChain(filePath, options.snockets);

                // Report each file in the Snockets chain
                compiledChain.forEach(c => {
                    context.onDependency(c.filename);
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

        return data;
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

    return processFile;
};
