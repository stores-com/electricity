const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const workerThreads = require('node:worker_threads');

const electricity = require('../lib/index');

/**
 * Creates an asset directory that is removed when the test finishes.
 * @param {Object} t Test context.
 * @param {Object} assets Asset contents keyed by path, relative to the directory.
 */
function directory(t, assets) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electricity-warmup-'));

    for (const [name, content] of Object.entries(assets)) {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, content);
    }

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    return root;
}

/**
 * Sends a request through the middleware and returns the response it produced.
 * @param {Function} middleware
 * @param {string} urlPath
 */
function request(middleware, urlPath) {
    const response = {};

    middleware({ get: () => {}, method: 'GET', path: urlPath }, {
        redirect: url => { response.redirect = url; },
        send: content => { response.content = content; },
        sendStatus: status => { response.status = status; },
        set: () => {}
    }, err => {
        if (err) {
            throw err;
        }

        response.notFound = true;
    });

    return response;
}

/**
 * Watches the warmup worker so a test can wait for it to finish.
 * @param {Object} t Test context.
 */
function warmup(t) {
    const Worker = workerThreads.Worker;
    let exited;

    t.mock.method(workerThreads, 'Worker', function(...args) {
        const worker = new Worker(...args);
        exited = new Promise(resolve => worker.once('exit', resolve));

        return worker;
    });

    return {
        started: () => exited !== undefined,
        // Messages the worker sent can still be waiting when it exits
        finished: async () => {
            await exited;
            await new Promise(resolve => setImmediate(resolve));
            await new Promise(resolve => setImmediate(resolve));
        }
    };
}

/**
 * Runs a callback with asset reads disabled, so only warmed files can be served.
 * @param {Object} t Test context.
 * @param {string} root Asset directory.
 * @param {Function} callback
 */
function withoutReads(t, root, callback) {
    const readFileSync = fs.readFileSync;
    const read = t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        if (typeof filename === 'string' && path.resolve(filename).startsWith(`${root}${path.sep}`)) {
            throw new Error(`Unexpected read of ${filename}`);
        }

        return readFileSync(filename, ...args);
    });

    try {
        return callback();
    } finally {
        read.mock.restore();
    }
}

// These tests mock Worker, console.warn, and fs.readFileSync, so they run one at a time
test('warmup', async (t) => {
    t.test('should serve compiled assets without reading them again', async (t) => {
        const root = directory(t, {
            'images/pixel.png': Buffer.from([0, 255, 1, 128]),
            'scripts/dep.js': 'globalThis.answer = 42;',
            'scripts/main.js': '//= require dep.js\nconst heading = <h1>Warm</h1>;',
            'styles/_palette.scss': '$accent: #123456;',
            'styles/main.scss': '@use "palette"; body { color: palette.$accent; background: url("/images/pixel.png"); }'
        });
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false });

        await worker.finished();

        withoutReads(t, root, () => {
            assert.match(request(middleware, '/styles/main.css').content, /color:#123456/);
            assert.match(request(middleware, '/scripts/main.js').content, /React\.createElement/);
            assert.deepStrictEqual(request(middleware, '/images/pixel.png').content, Buffer.from([0, 255, 1, 128]));
        });
    });

    t.test('should serve the same content a request would have compiled', async (t) => {
        const assets = {
            'main.js': '//= require dep.js\nconst heading = <h1>Parity</h1>;',
            'dep.js': 'globalThis.answer = 42;',
            'main.scss': 'body { color: green; }'
        };
        const lazyRoot = directory(t, assets);
        const warmRoot = directory(t, assets);
        const lazy = electricity.static(lazyRoot, { hostname: 'cdn.example.com', warmup: false });
        const worker = warmup(t);
        const warmed = electricity.static(warmRoot, { hostname: 'cdn.example.com' });

        await worker.finished();

        for (const urlPath of ['/main.css', '/main.js']) {
            const expected = request(lazy, urlPath);

            withoutReads(t, warmRoot, () => {
                assert.strictEqual(request(warmed, urlPath).redirect, expected.redirect);
            });
        }
    });

    t.test('should not start a worker when disabled', async (t) => {
        const root = directory(t, { 'robots.txt': 'lazy' });
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false, warmup: false });

        assert.strictEqual(worker.started(), false);
        assert.strictEqual(request(middleware, '/robots.txt').content.toString(), 'lazy');
    });

    t.test('should serve a symlinked directory when it is requested', async (t) => {
        const root = directory(t, { 'shared/logo.txt': 'shared asset' });
        fs.symlinkSync(path.join(root, 'shared'), path.join(root, 'linked'), 'dir');
        const warnings = t.mock.method(console, 'warn', () => {});
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false });

        await worker.finished();

        assert.strictEqual(warnings.mock.callCount(), 0);
        assert.strictEqual(request(middleware, '/linked/logo.txt').content.toString(), 'shared asset');
    });

    t.test('should compile SASS partials through the files that import them', async (t) => {
        const root = directory(t, {
            'styles/_partial.scss': 'not valid Sass on its own {{{',
            'styles/main.scss': 'body { color: green; }'
        });
        const warnings = t.mock.method(console, 'warn', () => {});
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false });

        await worker.finished();

        assert.strictEqual(warnings.mock.callCount(), 0);

        withoutReads(t, root, () => {
            assert.strictEqual(request(middleware, '/styles/main.css').content, 'body{color:green}');
        });
    });

    t.test('should report a file it cannot compile and warm the rest', async (t) => {
        const root = directory(t, {
            'a-broken.scss': 'body { color: $undefined; }',
            'z-healthy.txt': 'still warmed'
        });
        const warned = Promise.withResolvers();
        const warnings = t.mock.method(console, 'warn', (...args) => warned.resolve(args));
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false });

        await worker.finished();

        assert.match((await warned.promise)[0], /a-broken\.css/);
        assert.strictEqual(warnings.mock.callCount(), 1);

        withoutReads(t, root, () => {
            assert.strictEqual(request(middleware, '/z-healthy.txt').content.toString(), 'still warmed');
        });
    });

    t.test('should report options the worker cannot be started with', async (t) => {
        const root = directory(t, { 'main.js': 'globalThis.answer = 1;' });
        const warnings = t.mock.method(console, 'warn', () => {});
        const middleware = electricity.static(root, {
            babel: { plugins: [() => ({ visitor: {} })] },
            hashify: false
        });

        assert.strictEqual(warnings.mock.callCount(), 1);
        assert.match(warnings.mock.calls[0].arguments[0], /cache warming/);
        assert.match(request(middleware, '/main.js').content, /globalThis\.answer=1/);
    });

    t.test('should keep a file a request cached while the worker was running', async (t) => {
        const root = directory(t, { 'robots.txt': 'from the request' });
        const worker = warmup(t);
        const middleware = electricity.static(root, { hashify: false });

        assert.strictEqual(request(middleware, '/robots.txt').content.toString(), 'from the request');
        fs.writeFileSync(path.join(root, 'robots.txt'), 'from the worker');
        await worker.finished();

        withoutReads(t, root, () => {
            assert.strictEqual(request(middleware, '/robots.txt').content.toString(), 'from the request');
        });
    });
});
