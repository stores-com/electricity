const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const babel = require('@babel/core');
const mime = require('mime');
const sass = require('sass');
const UglifyJS = require('uglify-js');
const UglifyCss = require('uglifycss');

const gzipContentTypes = require('./gzipContentTypes.js');

module.exports = (directory, options, context) => {
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
     * Converts a URL path (/robots.txt) to a file path (/Users/username/site/public/robots.txt).
     * @param {string} urlPath
     */
    function toFilePath(urlPath) {
        const myURL = new URL(urlPath, 'https://example.org/');
        const pathname = myURL.pathname.replace(/^\//, '');
        return path.resolve(directory, pathname);
    }

    return processFile;
};
