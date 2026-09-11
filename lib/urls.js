/**
 * Adds a file's hash to its URL while preserving the query string and fragment.
 * @param {string} url
 * @param {string} hash
 */
function hashify(url, hash) {
    if (!url.includes('.')) {
        return url.replace(/([?#].*)?$/, `-${hash}$1`);
    }

    return url.replace(/\.([^.]*)([?#].*)?$/, `-${hash}.$1$2`);
}

/**
 * Separates an optional content hash from a URL path.
 * @param {string} urlPath
 */
function parse(urlPath) {
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

function build(urlPath, options, fetchFile) {
    let file;
    const request = parse(urlPath);
    let url = urlPath;

    try {
        file = fetchFile(request.path);
    } catch(err) {
        // Preserve URLs that do not resolve to a local file.
        return urlPath;
    }

    if (options.hashify) {
        url = hashify(request.path, file.hash);
    }

    if (options.hostname) {
        url = `https://${options.hostname}${url}`;
    }

    return url;
}

module.exports = { hashify, parse, build };
