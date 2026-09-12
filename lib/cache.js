const path = require('node:path');

const processor = require('./processor');
const urls = require('./urls');

/**
 * Creates the processed asset cache shared by the middleware and the warmup worker.
 * @param {string} directory Absolute path to the asset directory.
 * @param {Object} options Processing options initialized by the static middleware.
 * @param {function(string, Object)} [onFile] Called with each newly cached file.
 * @returns {Object} Cache with add, fetch, remove, and url functions.
 */
module.exports = (directory, options, onFile) => {
    const files = {};
    const processFile = processor(directory, options, fetch);

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
     * Builds an asset URL with its content hash and CDN hostname when configured.
     * @param {string} urlPath Public URL path of the asset.
     * @returns {string} Asset URL, or the original path when the asset is unavailable.
     */
    function url(urlPath) {
        return urls.build(urlPath, options, fetch);
    }

    return { add, fetch, remove, url };
};
