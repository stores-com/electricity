const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const chokidar = require('chokidar');

const electricity = require('../lib');

function fixture(t, files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electricity-warmup-'));
    const directory = path.join(root, 'public');
    fs.mkdirSync(directory);

    for (const [name, contents] of Object.entries(files)) {
        const filename = path.join(directory, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, contents);
    }

    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, directory };
}

function request(middleware, url, headers = {}) {
    const result = { headers: {} };

    middleware({
        get: name => headers[name],
        headers,
        method: 'GET',
        path: url
    }, {
        redirect: url => { result.redirect = url; },
        send: body => { result.body = body; },
        sendStatus: status => { result.status = status; },
        set: (name, value) => {
            const values = typeof name === 'string' ? { [name]: value } : name;
            for (const [field, contents] of Object.entries(values)) {
                result.headers[field.toLowerCase()] = String(contents);
            }
        }
    }, error => {
        if (error) {
            throw error;
        }
        result.notFound = true;
    });

    return result;
}

function urlBuilder(middleware) {
    const app = { locals: {} };
    middleware({ app, method: 'POST' }, null, () => {});
    return app.locals.electricity.url;
}

function withoutAssetReads(t, directory, callback) {
    const readFileSync = fs.readFileSync;
    const read = t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        if (typeof filename === 'string' && path.resolve(filename).startsWith(`${directory}${path.sep}`)) {
            throw new Error(`Unexpected main-thread asset read: ${filename}`);
        }
        return readFileSync(filename, ...args);
    });

    try {
        return callback();
    } finally {
        read.mock.restore();
    }
}

test('warmup populates the serving cache with compiled assets, hashes, binary data, and gzip', async t => {
    const binary = Buffer.from([0, 255, 1, 128, 33, 0, 200]);
    const text = 'A sufficiently long text file to exercise gzip caching.\n'.repeat(100);
    const { directory } = fixture(t, {
        'styles/_palette.scss': '$accent: #123456;',
        'styles/main.scss': '@use "palette"; body { color: palette.$accent; background-image: url("/pixel.png"); }',
        'scripts/dep.js': 'globalThis.answer = 42;',
        'scripts/main.js': '//= require dep.js\nconst heading = <h1>Hello from warmup</h1>;',
        'pixel.png': binary,
        'nested/no-extension': 'extensionless content',
        'large.txt': text
    });
    const middleware = electricity.static(directory, {
        headers: { 'x-custom': { toString() { return 'kept in the parent'; } } }
    });
    assert.equal(typeof middleware, 'function');

    const pending = middleware.warmup();
    assert.ok(pending instanceof Promise);
    assert.equal(middleware.warmup(), pending);
    await pending;
    assert.equal(middleware.warmup(), pending);

    withoutAssetReads(t, directory, () => {
        const url = urlBuilder(middleware);
        const cssUrl = url('/styles/main.css');
        const css = request(middleware, cssUrl);
        const cssHash = crypto.createHash('sha1').update(css.body).digest('hex');
        assert.equal(cssUrl, `/styles/main-${cssHash}.css`);
        assert.equal(request(middleware, '/styles/main.css').redirect, cssUrl);
        assert.match(css.body, /color:#123456/);
        assert.ok(css.body.includes(url('/pixel.png')));
        assert.equal(css.headers['x-custom'], 'kept in the parent');

        const js = request(middleware, url('/scripts/main.js'));
        assert.match(js.body, /React\.createElement/);
        assert.match(js.body, /globalThis\.answer=42/);
        assert.ok(!js.body.includes('<h1>'));

        const image = request(middleware, url('/pixel.png'));
        assert.ok(Buffer.isBuffer(image.body));
        assert.deepEqual(image.body, binary);
        assert.equal(image.headers['content-length'], String(binary.length));

        const extensionless = request(middleware, url('/nested/no-extension'));
        assert.equal(extensionless.body.toString(), 'extensionless content');

        const compressed = request(middleware, url('/large.txt'), { 'accept-encoding': 'gzip' });
        assert.equal(compressed.headers['content-encoding'], 'gzip');
        assert.ok(Buffer.isBuffer(compressed.body));
        assert.equal(zlib.gunzipSync(compressed.body).toString(), text);
        assert.equal(compressed.headers['content-length'], String(compressed.body.length));
        assert.equal(request(middleware, url('/large.txt')).body.toString(), text);
    });
});

test('warmed responses exactly match lazy compilation with custom options and a CDN', async t => {
    const { root, directory } = fixture(t, {
        'main.scss': '@use "palette"; body { background: url("/pixel.png"); } @for $i from 1 through 100 { .item-#{$i} { color: palette.$accent; } }',
        'dep.js': 'globalThis.values = [];',
        'main.js': '//= require dep.js\nconst heading = <h1>Parity</h1>;\n' + 'globalThis.values.push("a long compiled value");\n'.repeat(100),
        'pixel.png': Buffer.from([0, 255, 128, 42]),
        'large.txt': 'Response parity includes the compressed bytes.\n'.repeat(100)
    });
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, '_palette.scss'), '$accent: #abcdef;');
    const options = {
        hostname: 'cdn.example.com',
        babel: { comments: false, compact: false },
        sass: { loadPaths: [shared], style: 'expanded' },
        uglifycss: { enabled: true, maxLineLen: 120 },
        uglifyjs: { enabled: true, compress: false, mangle: false, output: { beautify: true } }
    };
    const lazy = electricity.static(directory, structuredClone(options));
    const warmed = electricity.static(directory, structuredClone(options));
    const assetPaths = ['/main.css', '/main.js', '/large.txt'];

    function snapshot(middleware, assetPath, gzip) {
        const url = urlBuilder(middleware)(assetPath);
        const result = request(middleware, new URL(url).pathname, gzip ? { 'accept-encoding': 'gzip' } : {});
        const { expires, ...headers } = result.headers;
        assert.ok(expires, 'responses retain a far-future expiration');
        return { url, body: result.body, headers };
    }

    const expected = assetPaths.map(assetPath => ({
        plain: snapshot(lazy, assetPath, false),
        gzip: snapshot(lazy, assetPath, true)
    }));
    assert.match(expected[0].plain.url, /^https:\/\/cdn\.example\.com\/main-/);
    assert.match(expected[0].plain.body, /https:\/\/cdn\.example\.com\/pixel-/);
    assert.match(expected[0].plain.body, /#abcdef/);
    assert.match(expected[1].plain.body, /React\.createElement/);
    for (const response of expected) {
        assert.equal(response.gzip.headers['content-encoding'], 'gzip');
    }

    await warmed.warmup();
    withoutAssetReads(t, directory, () => {
        assetPaths.forEach((assetPath, index) => {
            assert.deepEqual(snapshot(warmed, assetPath, false), expected[index].plain);
            assert.deepEqual(snapshot(warmed, assetPath, true), expected[index].gzip);
        });
    });
});

test('warmup follows directory symlinks, stops ancestor cycles, and warms each URL alias', async t => {
    const { root, directory } = fixture(t, { 'root.txt': 'root asset' });
    const shared = path.join(root, 'shared');
    fs.mkdirSync(path.join(shared, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'nested', 'asset.txt'), 'shared asset');
    fs.symlinkSync(shared, path.join(directory, 'first'), 'dir');
    fs.symlinkSync(shared, path.join(directory, 'second'), 'dir');
    fs.symlinkSync(directory, path.join(shared, 'back'), 'dir');

    const middleware = electricity.static(directory, { hashify: false });
    await middleware.warmup();

    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/root.txt').body.toString(), 'root asset');
        assert.equal(request(middleware, '/first/nested/asset.txt').body.toString(), 'shared asset');
        assert.equal(request(middleware, '/second/nested/asset.txt').body.toString(), 'shared asset');
    });
});

test('warmup skips Sass partials and preserves CSS precedence over matching Sass', async t => {
    const { directory } = fixture(t, {
        'styles/_partial.scss': 'deliberately invalid Sass {{{',
        'styles/preferred.scss': 'deliberately invalid Sass {{{',
        'styles/preferred.css': 'body { color: blue; }'
    });
    const middleware = electricity.static(directory, { hashify: false });
    await middleware.warmup();

    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/styles/preferred.css').body, 'body{color:blue}');
    });
});

test('an individual compilation failure rejects warmup after other assets have been cached', async t => {
    const { directory } = fixture(t, {
        'a-broken.scss': 'body { color: $undefined; }',
        'z-healthy.scss': 'body { color: green; }',
        'z-healthy.txt': 'still available'
    });
    const middleware = electricity.static(directory, { hashify: false });
    const pending = middleware.warmup();

    await assert.rejects(pending, error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(error.errors[0].message, /a-broken\.css/);
        return true;
    });
    assert.equal(middleware.warmup(), pending);

    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/z-healthy.css').body, 'body{color:green}');
        assert.equal(request(middleware, '/z-healthy.txt').body.toString(), 'still available');
    });
});

test('warmup rejects when its root directory does not exist', async t => {
    const { directory } = fixture(t, {});
    const middleware = electricity.static(path.join(directory, 'missing'));
    const pending = middleware.warmup();

    await assert.rejects(pending, error => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(error.errors[0].message, /ENOENT|no such file/i);
        return true;
    });
    assert.equal(middleware.warmup(), pending);
});

test('warmup rejects noncloneable asset processing options while lazy compilation remains usable', async t => {
    const { directory } = fixture(t, { 'main.js': 'globalThis.answer = 1;' });
    const middleware = electricity.static(directory, {
        hashify: false,
        babel: {
            plugins: [() => ({
                visitor: {
                    NumericLiteral(node) { node.node.value = 2; }
                }
            })]
        }
    });

    await assert.rejects(middleware.warmup(), /clone|serializ/i);
    assert.match(request(middleware, '/main.js').body, /globalThis\.answer=2/);
});

test('warmup rejects watch mode', async t => {
    const { directory } = fixture(t, { 'main.txt': 'watched asset' });
    t.mock.method(chokidar, 'watch', () => ({ on() { return this; } }));
    const middleware = electricity.static(directory, { watch: { enabled: true } });

    await assert.rejects(middleware.warmup(), /watch/i);
});

test('warmup rejects uncaught worker errors and premature worker exits', async t => {
    const { root, directory } = fixture(t, { 'main.js': 'globalThis.answer = 42;' });
    const failures = [
        {
            name: 'uncaught-error',
            code: 'process.nextTick(() => { throw new Error("deliberate worker failure"); });',
            expected: /deliberate worker failure/
        },
        {
            name: 'early-exit',
            code: 'process.exit(7);',
            expected: /worker exited.*7/i
        },
        {
            name: 'early-success-exit',
            code: 'process.exit(0);',
            expected: /worker exited.*0/i
        }
    ];

    for (const failure of failures) {
        const plugin = path.join(root, `${failure.name}.cjs`);
        fs.writeFileSync(plugin, `
const { isMainThread } = require('node:worker_threads');
module.exports = () => {
    if (!isMainThread) { ${failure.code} }
    return {};
};
`);
        const middleware = electricity.static(directory, { babel: { plugins: [plugin] } });
        await assert.rejects(middleware.warmup(), failure.expected);
    }
});

test('compilation runs off the event loop and cannot replace an asset already built by a request', { timeout: 30000 }, async t => {
    const { root, directory } = fixture(t, {
        'main.js': 'globalThis.buildOrigin = "worker";',
        'health.txt': 'responsive'
    });
    const plugin = path.join(root, 'busy-plugin.cjs');
    fs.writeFileSync(plugin, `
const { isMainThread, threadId } = require('node:worker_threads');
module.exports = (api, options) => ({
    visitor: {
        Program() {
            if (isMainThread) return;
            const state = new Int32Array(options.signal);
            Atomics.store(state, 3, threadId);
            Atomics.store(state, 0, 1);
            Atomics.notify(state, 0);
            const deadline = Date.now() + 20000;
            while (Atomics.load(state, 1) === 0 && Date.now() < deadline) {
                Atomics.add(state, 2, 1);
            }
            Atomics.store(state, 0, 2);
            if (Atomics.load(state, 1) === 0) throw new Error('Main thread never released compilation');
        }
    }
});
`);
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    const state = new Int32Array(signal);
    const middleware = electricity.static(directory, {
        hashify: false,
        babel: { plugins: [[plugin, { signal }]] }
    });
    const pending = middleware.warmup();

    try {
        await Promise.race([
            Atomics.waitAsync(state, 0, 0, 15000).value,
            pending.then(() => assert.fail('Warmup completed before entering the worker plugin'))
        ]);
        assert.equal(Atomics.load(state, 0), 1, 'the worker is still compiling');
        assert.ok(Atomics.load(state, 3) > 0, 'the compiler ran in a worker thread');
        fs.writeFileSync(path.join(directory, 'main.js'), 'globalThis.buildOrigin = "request";');

        await new Promise((resolve, reject) => {
            setTimeout(() => {
                try {
                    assert.equal(Atomics.load(state, 0), 1, 'timers execute during compilation');
                    assert.equal(request(middleware, '/health.txt').body.toString(), 'responsive');
                    assert.match(request(middleware, '/main.js').body, /buildOrigin="request"/);
                    assert.ok(Atomics.load(state, 2) > 0, 'the compiler performed CPU work concurrently');
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }, 0);
        });
    } finally {
        Atomics.store(state, 1, 1);
        await pending;
    }

    withoutAssetReads(t, directory, () => {
        assert.match(request(middleware, '/main.js').body, /buildOrigin="request"/);
    });
});
