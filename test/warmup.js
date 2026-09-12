const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const events = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');
const workerThreads = require('node:worker_threads');
const zlib = require('node:zlib');

const chokidar = require('chokidar').default;

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

function warming(t) {
    const Worker = workerThreads.Worker;
    const exits = [];
    t.mock.method(workerThreads, 'Worker', function(...args) {
        const worker = new Worker(...args);
        exits.push(events.once(worker, 'exit'));
        return worker;
    });

    return {
        count: () => exits.length,
        settled: () => Promise.all(exits)
    };
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
    const workers = warming(t);
    const middleware = electricity.static(directory, {
        headers: { 'x-custom': 'custom response header' }
    });
    assert.equal(typeof middleware, 'function');

    await workers.settled();
    assert.equal(workers.count(), 1);

    withoutAssetReads(t, directory, () => {
        const url = urlBuilder(middleware);
        const cssUrl = url('/styles/main.css');
        const css = request(middleware, cssUrl);
        const cssHash = crypto.createHash('sha1').update(css.body).digest('hex');
        assert.equal(cssUrl, `/styles/main-${cssHash}.css`);
        assert.equal(request(middleware, '/styles/main.css').redirect, cssUrl);
        assert.match(css.body, /color:#123456/);
        assert.ok(css.body.includes(url('/pixel.png')));
        assert.equal(css.headers['x-custom'], 'custom response header');

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

test('opting out serves lazily without starting a worker', async t => {
    const { directory } = fixture(t, {
        'lazy.txt': 'available on demand',
        'manual.scss': 'body { color: purple; }'
    });
    const workers = warming(t);
    const middleware = electricity.static(directory, { hashify: false, warmup: false });

    await delay(0);
    assert.equal(workers.count(), 0);
    assert.equal(request(middleware, '/lazy.txt').body.toString(), 'available on demand');
    assert.equal(request(middleware, '/manual.css').body, 'body{color:purple}');
});

test('automatic warming reports failures without an unhandled rejection', { timeout: 15000 }, async t => {
    const { directory } = fixture(t, {
        'broken.scss': 'body { color: $undefined; }',
        'healthy.txt': 'still cached'
    });
    const warned = Promise.withResolvers();
    const warnings = t.mock.method(console, 'warn', (...args) => warned.resolve(args));
    const middleware = electricity.static(directory, { hashify: false });

    // Observe the automatic failure before attaching any caller rejection handler.
    const [message, error] = await warned.promise;
    assert.match(message, /cache warming failed/i);
    assert.match(error.message, /broken\.css/);
    await delay(0);
    assert.equal(warnings.mock.callCount(), 1);
    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/healthy.txt').body.toString(), 'still cached');
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
    const lazy = electricity.static(directory, { ...structuredClone(options), warmup: false });
    const workers = warming(t);
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

    await workers.settled();
    withoutAssetReads(t, directory, () => {
        assetPaths.forEach((assetPath, index) => {
            assert.deepEqual(snapshot(warmed, assetPath, false), expected[index].plain);
            assert.deepEqual(snapshot(warmed, assetPath, true), expected[index].gzip);
        });
    });
});

test('JSX remains a standalone script with spread props in development and production', async t => {
    const { directory } = fixture(t, {
        'main.js': 'globalThis.element = <h1 id="before" {...props} title="after">Hello</h1>;'
    });
    const workers = warming(t);

    for (const enabled of [false, true]) {
        let expected;
        for (const envName of ['development', 'production']) {
            const options = { hashify: false, babel: { envName }, uglifyjs: { enabled } };
            const lazy = electricity.static(directory, { ...structuredClone(options), warmup: false });
            const warmed = electricity.static(directory, structuredClone(options));
            const response = request(lazy, '/main.js');
            assert.equal(response.headers['content-type'], 'text/javascript');

            const context = {
                props: { id: 'spread', title: 'before', hidden: true },
                React: { createElement: (tag, props, ...children) => ({ tag, props, children }) }
            };
            vm.runInNewContext(response.body, context);
            assert.equal(context.element.tag, 'h1');
            assert.deepEqual({ ...context.element.props }, { id: 'spread', title: 'after', hidden: true });
            assert.deepEqual(context.element.children, ['Hello']);

            expected ??= response.body;
            assert.equal(response.body, expected);
            await workers.settled();
            withoutAssetReads(t, directory, () => {
                assert.equal(request(warmed, '/main.js').body, response.body);
            });
        }
    }
});

test('Unicode JavaScript uses UTF-8 byte lengths for plain responses and gzip eligibility', async t => {
    const { directory } = fixture(t, {
        'main.js': `globalThis.message = "${'é'.repeat(800)}";`
    });
    const options = { hashify: false, uglifyjs: { enabled: false } };
    const lazy = electricity.static(directory, { ...structuredClone(options), warmup: false });
    const workers = warming(t);
    const warmed = electricity.static(directory, structuredClone(options));
    const plain = request(lazy, '/main.js');
    const compressed = request(lazy, '/main.js', { 'accept-encoding': 'gzip' });

    assert.ok(plain.body.includes('é'));
    assert.ok(plain.body.length < 1500);
    assert.ok(Buffer.byteLength(plain.body) > 1500);
    assert.equal(plain.headers['content-length'], String(Buffer.byteLength(plain.body)));
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers['content-length'], String(compressed.body.length));
    assert.equal(zlib.gunzipSync(compressed.body).toString(), plain.body);

    await workers.settled();
    withoutAssetReads(t, directory, () => {
        const warmedPlain = request(warmed, '/main.js');
        const warmedCompressed = request(warmed, '/main.js', { 'accept-encoding': 'gzip' });
        assert.equal(warmedPlain.body, plain.body);
        assert.equal(warmedPlain.headers['content-length'], plain.headers['content-length']);
        assert.deepEqual(warmedCompressed.body, compressed.body);
        assert.equal(warmedCompressed.headers['content-encoding'], 'gzip');
        assert.equal(warmedCompressed.headers['content-length'], compressed.headers['content-length']);
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

    const workers = warming(t);
    const middleware = electricity.static(directory, { hashify: false });
    await workers.settled();

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
    const workers = warming(t);
    const middleware = electricity.static(directory, { hashify: false });
    await workers.settled();

    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/styles/preferred.css').body, 'body{color:blue}');
    });
});

test('compilation failures are reported after other assets have been cached', { timeout: 15000 }, async t => {
    const { directory } = fixture(t, {
        'a-broken.scss': 'body { color: $undefined; }',
        'b-broken.scss': 'body { color: $missing; }',
        'z-healthy.scss': 'body { color: green; }',
        'z-healthy.txt': 'still available'
    });
    const reported = [];
    const warnings = t.mock.method(console, 'warn', (...args) => {
        if (/cache warming failed/i.test(args[0])) {
            reported.push(args[1].message);
        }
    });
    const workers = warming(t);
    const middleware = electricity.static(directory, { hashify: false });

    await workers.settled();
    reported.sort();
    assert.match(reported[0], /a-broken\.css/);
    assert.match(reported[1], /b-broken\.css/);
    assert.equal(warnings.mock.callCount(), 2);

    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/z-healthy.css').body, 'body{color:green}');
        assert.equal(request(middleware, '/z-healthy.txt').body.toString(), 'still available');
    });
});

test('a missing root directory is reported', async t => {
    const { directory } = fixture(t, {});
    const warned = Promise.withResolvers();
    t.mock.method(console, 'warn', (...args) => {
        if (/cache warming failed/i.test(args[0])) {
            warned.resolve(args);
        }
    });
    electricity.static(path.join(directory, 'missing'));

    const [, error] = await warned.promise;
    assert.match(error.message, /ENOENT|no such file/i);
});

test('function options serve lazily when opted out and are reported when warming', { timeout: 15000 }, async t => {
    const { directory } = fixture(t, { 'main.js': 'globalThis.answer = 1;' });
    const babel = {
        plugins: [() => ({
            visitor: {
                NumericLiteral(node) { node.node.value = 2; }
            }
        })]
    };
    const warnings = t.mock.method(console, 'warn', () => {});
    const optedOut = electricity.static(directory, { babel, hashify: false, warmup: false });

    await delay(0);
    assert.equal(warnings.mock.callCount(), 0);
    assert.match(request(optedOut, '/main.js').body, /globalThis\.answer=2/);

    electricity.static(directory, { babel, hashify: false });

    while (!warnings.mock.calls.length) {
        t.signal.throwIfAborted();
        await delay(1);
    }

    const [message, error] = warnings.mock.calls[0].arguments;
    assert.match(message, /cache warming failed/i);
    assert.equal(error.name, 'DataCloneError');
});

test('automatic warming rejects uncloneable headers while lazy serving remains usable', { timeout: 15000 }, async t => {
    const { directory } = fixture(t, { 'main.scss': 'body { color: green; }' });
    const warned = Promise.withResolvers();
    const warnings = t.mock.method(console, 'warn', (...args) => warned.resolve(args));
    const middleware = electricity.static(directory, {
        hashify: false,
        headers: { 'x-custom': { toString() { return 'lazy response header'; } } }
    });

    const [message, error] = await warned.promise;
    assert.match(message, /cache warming failed/i);
    assert.equal(error.name, 'DataCloneError');
    const response = request(middleware, '/main.css');
    assert.equal(response.body, 'body{color:green}');
    assert.equal(response.headers['x-custom'], 'lazy response header');
    assert.equal(warnings.mock.callCount(), 1);
});

test('watch mode warms the cache automatically', async t => {
    const { directory } = fixture(t, {
        'main.txt': 'watched asset',
        'manual.scss': 'body { color: green; }'
    });
    // Model existing files so delayed creation/access events are not mistaken for test edits.
    for (const name of ['main.txt', 'manual.scss']) {
        fs.utimesSync(path.join(directory, name), new Date(), new Date(Date.now() - 1000));
    }
    const warnings = t.mock.method(console, 'warn', () => {});
    const watch = chokidar.watch;
    let watcher;
    t.mock.method(chokidar, 'watch', (...args) => {
        watcher = watch(...args);
        return watcher;
    });
    t.after(() => watcher.close());
    const workers = warming(t);
    const middleware = electricity.static(directory, { hashify: false, watch: { enabled: true } });

    await events.once(watcher, 'ready');
    await workers.settled();
    assert.equal(warnings.mock.callCount(), 0);
    withoutAssetReads(t, directory, () => {
        assert.equal(request(middleware, '/main.txt').body.toString(), 'watched asset');
        assert.equal(request(middleware, '/manual.css').body, 'body{color:green}');
    });
});

test('uncaught worker errors and premature worker exits are reported', { timeout: 15000 }, async t => {
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
        }
    ];

    for (const failure of failures) {
        const plugin = path.join(root, `${failure.name}.cjs`);
        fs.writeFileSync(plugin, `
const workerThreads = require('node:worker_threads');
module.exports = () => {
    if (!workerThreads.isMainThread) { ${failure.code} }
    return {};
};
`);
        const warned = Promise.withResolvers();
        const warnings = t.mock.method(console, 'warn', (...args) => {
            // Workers from earlier cases report their own exits into this mock.
            const reported = args.map(String).join(' ');

            if (/cache warming/i.test(reported) && failure.expected.test(reported)) {
                warned.resolve(reported);
            }
        });
        electricity.static(directory, { babel: { plugins: [plugin] } });

        assert.match(await warned.promise, failure.expected);
        warnings.mock.restore();
    }
});

test('automatic compilation starts off the event loop and preserves an asset already built by a request', { timeout: 30000 }, async t => {
    const { root, directory } = fixture(t, {
        'main.js': 'globalThis.buildOrigin = "worker";',
        'health.txt': 'responsive'
    });
    const plugin = path.join(root, 'busy-plugin.cjs');
    fs.writeFileSync(plugin, `
const workerThreads = require('node:worker_threads');
module.exports = (api, options) => ({
    visitor: {
        Program() {
            if (workerThreads.isMainThread) return;
            const state = new Int32Array(options.signal);
            Atomics.store(state, 3, workerThreads.threadId);
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
    const workers = warming(t);
    const middleware = electricity.static(directory, {
        hashify: false,
        babel: { plugins: [[plugin, { signal }]] }
    });

    try {
        await Atomics.waitAsync(state, 0, 0, 15000).value;
        assert.equal(Atomics.load(state, 0), 1, 'the worker is still compiling');
        assert.ok(Atomics.load(state, 3) > 0, 'the compiler ran in a worker thread');
        fs.writeFileSync(path.join(directory, 'main.js'), 'globalThis.buildOrigin = "request";');

        await delay(0);
        assert.equal(Atomics.load(state, 0), 1, 'timers execute during compilation');
        assert.equal(request(middleware, '/health.txt').body.toString(), 'responsive');
        assert.match(request(middleware, '/main.js').body, /buildOrigin="request"/);
        assert.ok(Atomics.load(state, 2) > 0, 'the compiler performed CPU work concurrently');
    } finally {
        Atomics.store(state, 1, 1);
        await workers.settled();
    }

    withoutAssetReads(t, directory, () => {
        assert.match(request(middleware, '/main.js').body, /buildOrigin="request"/);
    });
});
