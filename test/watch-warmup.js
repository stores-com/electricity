const test = require('node:test');
const assert = require('node:assert/strict');
const events = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const workerThreads = require('node:worker_threads');

const chokidar = require('chokidar').default;

const electricity = require('../lib');

function fixture(t, assets, watch = chokidar.watch) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'electricity-watch-warmup-')));
    const directory = path.join(root, 'public');
    fs.mkdirSync(directory);

    for (const [name, source] of Object.entries(assets)) {
        const filename = path.join(root, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, source);
        // Model existing files so delayed creation/access events are not mistaken for test edits.
        fs.utimesSync(filename, new Date(), new Date(Date.now() - 1000));
    }

    let watcher;
    let ready;
    t.mock.method(chokidar, 'watch', (...args) => {
        watcher = watch(...args);
        ready = events.once(watcher, 'ready');
        return watcher;
    });
    t.after(async () => {
        await watcher?.close();
        fs.rmSync(root, { recursive: true, force: true });
    });

    return {
        root,
        directory,
        start(options = {}) {
            const middleware = electricity.static(directory, {
                hashify: false,
                watch: { enabled: true },
                ...options
            });
            return { middleware, watcher, ready };
        }
    };
}

function responseBody(middleware, url) {
    let body;
    middleware({ get: () => {}, headers: {}, method: 'GET', path: url }, {
        send: content => { body = content; },
        set: () => {}
    }, error => assert.ifError(error));
    return body?.toString();
}

async function change(watcher, filename, source) {
    const changed = events.once(watcher, 'change');
    fs.writeFileSync(filename, source);
    const [changedPath] = await changed;
    assert.equal(changedPath, filename);
}

function pauseCompilation(assets) {
    const plugin = path.join(assets.root, 'pause-plugin.cjs');
    fs.writeFileSync(plugin, `
const workerThreads = require('node:worker_threads');
module.exports = (api, options) => ({
    visitor: {
        StringLiteral(node) {
            if (workerThreads.isMainThread || node.node.value !== 'pause startup') return;
            const state = new Int32Array(options.signal);
            Atomics.store(state, 0, 1);
            Atomics.notify(state, 0);
            Atomics.wait(state, 1, 0, 10000);
        }
    }
});
`);
    const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const state = new Int32Array(signal);
    return {
        options: { babel: { plugins: [[plugin, { signal }]] } },
        async entered() {
            await Atomics.waitAsync(state, 0, 0, 10000).value;
            assert.equal(Atomics.load(state, 0), 1, 'the worker reached the paused compilation');
        },
        release() {
            Atomics.store(state, 1, 1);
            Atomics.notify(state, 1);
        }
    };
}

test('watch startup waits for ready and then automatically starts one memoized warmup', { timeout: 15000 }, async t => {
    const watcher = new events.EventEmitter();
    watcher.add = () => watcher;
    watcher.close = async () => {};
    const assets = fixture(t, { 'public/main.txt': 'warmed after ready' }, () => watcher);
    watcher.getWatched = () => ({ [assets.directory]: ['main.txt'] });
    const Worker = workerThreads.Worker;
    const started = Promise.withResolvers();
    const workers = t.mock.method(workerThreads, 'Worker', function(...args) {
        const worker = new Worker(...args);
        started.resolve();
        return worker;
    });
    const { middleware } = assets.start();

    await timers.setImmediate();
    assert.equal(workers.mock.callCount(), 0);
    watcher.emit('ready');
    await started.promise;
    const pending = middleware.warmup();
    assert.equal(middleware.warmup(), pending);
    await pending;
    assert.equal(workers.mock.callCount(), 1);
    assert.equal(middleware.warmup(), pending);
    assert.equal(responseBody(middleware, '/main.txt'), 'warmed after ready');
});

test('a cache callback failure rejects warming and prevents later worker results from entering the cache', { timeout: 15000 }, async t => {
    const watcher = new events.EventEmitter();
    watcher.close = async () => {};
    const assets = fixture(t, {
        'public/first.scss': '@use "../shared/palette"; body { color: palette.$accent; }',
        'public/later.txt': 'later worker result',
        'shared/_palette.scss': '$accent: #123456;'
    }, () => watcher);
    watcher.getWatched = () => ({ [assets.directory]: ['first.scss', 'later.txt'] });
    const failure = new Error('Watch registration failed');
    let shouldThrow = true;
    let registrations = 0;
    watcher.add = () => {
        registrations++;
        if (shouldThrow) throw failure;
        return watcher;
    };
    const stopped = Promise.withResolvers();
    const Worker = workerThreads.Worker;
    t.mock.method(workerThreads, 'Worker', function(...args) {
        const worker = new Worker(...args);
        worker.once('exit', () => stopped.resolve());
        return worker;
    });
    const { middleware } = assets.start({ warmup: false });
    watcher.emit('ready');

    await assert.rejects(middleware.warmup(), error => error === failure);
    shouldThrow = false;
    await stopped.promise;
    assert.equal(registrations, 1, 'later worker messages do not invoke the cache callback');
    fs.writeFileSync(path.join(assets.directory, 'later.txt'), 'built lazily after failure');
    assert.equal(responseBody(middleware, '/later.txt'), 'built lazily after failure');
});

test('worker-warmed JavaScript parents and Sass @use parents invalidate on watched changes', { timeout: 15000 }, async t => {
    const assets = fixture(t, {
        'public/shared/leaf.js': 'globalThis.shared = "before";',
        'public/shared/middle.js': '//= require leaf.js\nglobalThis.middle = true;',
        'public/first.js': '//= require shared/middle.js\nglobalThis.first = true;',
        'public/second.js': '//= require shared/middle.js\nglobalThis.second = true;',
        'public/styles/_palette.scss': '$accent: #123456;',
        'public/styles/main.scss': '@use "palette"; .example { color: palette.$accent; }'
    });
    const { middleware, watcher, ready } = assets.start({ uglifyjs: { enabled: false } });
    await ready;
    await middleware.warmup();

    const readFileSync = fs.readFileSync;
    const read = t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        assert.ok(!String(filename).startsWith(assets.directory), `Unexpected asset read: ${filename}`);
        return readFileSync(filename, ...args);
    });
    try {
        assert.match(responseBody(middleware, '/first.js'), /shared = "before"/);
        assert.match(responseBody(middleware, '/second.js'), /shared = "before"/);
        assert.equal(responseBody(middleware, '/styles/main.css'), '.example{color:#123456}');
    } finally {
        read.mock.restore();
    }

    await change(watcher, path.join(assets.directory, 'shared/leaf.js'), 'globalThis.shared = "after";');
    assert.match(responseBody(middleware, '/first.js'), /shared = "after"/);
    assert.match(responseBody(middleware, '/second.js'), /shared = "after"/);
    await change(watcher, path.join(assets.directory, 'styles/_palette.scss'), '$accent: #abcdef;');
    assert.equal(responseBody(middleware, '/styles/main.css'), '.example{color:#abcdef}');
});

test('an edit during startup discards stale remaining results without resurrecting deleted assets', { timeout: 15000 }, async t => {
    const assets = fixture(t, {
        'public/dep.js': 'globalThis.version = "before";',
        'public/main.js': '//= require dep.js\nglobalThis.main = "pause startup";',
        'public/z-later.txt': 'not read until the paused compilation finishes'
    });
    const pause = pauseCompilation(assets);
    const warnings = t.mock.method(console, 'warn', () => {});
    const { middleware, watcher, ready } = assets.start(pause.options);
    await ready;
    const pending = middleware.warmup();

    try {
        await pause.entered();
        await change(watcher, path.join(assets.directory, 'dep.js'), 'globalThis.version = "after";');
        for (const name of ['main.js', 'z-later.txt']) {
            const removed = events.once(watcher, 'unlink');
            const deleted = path.join(assets.directory, name);
            fs.unlinkSync(deleted);
            assert.equal((await removed)[0], deleted);
        }
    } finally {
        pause.release();
        await pending;
    }

    assert.equal(warnings.mock.callCount(), 0);
    assert.match(responseBody(middleware, '/dep.js'), /version="after"/);
    assert.equal(responseBody(middleware, '/main.js'), undefined);
    assert.equal(responseBody(middleware, '/z-later.txt'), undefined);
});

test('new external imports remain lazy for startup and are watched for subsequent changes', { timeout: 15000 }, async t => {
    const assets = fixture(t, {
        'public/main.js': '//= require ../shared/dep.js\nglobalThis.main = "pause startup";',
        'shared/dep.js': 'globalThis.version = "before";'
    });
    const external = path.join(assets.root, 'shared/dep.js');
    const pause = pauseCompilation(assets);
    const { middleware, watcher, ready } = assets.start(pause.options);
    await ready;
    const pending = middleware.warmup();

    try {
        await pause.entered();
        assert.ok(!watcher.getWatched()[path.dirname(external)]?.includes(path.basename(external)));
        fs.writeFileSync(external, 'globalThis.version = "during startup";');
    } finally {
        pause.release();
        await pending;
    }

    while (!watcher.getWatched()[path.dirname(external)]?.includes(path.basename(external))) {
        t.signal.throwIfAborted();
        await timers.setImmediate();
    }
    assert.match(responseBody(middleware, '/main.js'), /version="during startup"/);
    await change(watcher, external, 'globalThis.version = "after startup";');
    assert.match(responseBody(middleware, '/main.js'), /version="after startup"/);
});

test('deleting a directory symlink invalidates its worker-warmed Sass parent', { timeout: 15000 }, async t => {
    const watcher = new events.EventEmitter();
    watcher.add = () => watcher;
    watcher.close = async () => {};
    const assets = fixture(t, {
        'public/main.scss': '@use "linked/palette"; body { color: palette.$accent; }',
        'shared/_palette.scss': '$accent: #123456;'
    }, () => watcher);
    const link = path.join(assets.directory, 'linked');
    fs.symlinkSync(path.join(assets.root, 'shared'), link, 'dir');
    watcher.getWatched = () => ({ [assets.directory]: ['linked', 'main.scss'], [link]: ['_palette.scss'] });
    const { middleware, ready } = assets.start();
    watcher.emit('ready');
    await ready;
    await middleware.warmup();
    const readFileSync = fs.readFileSync;
    const read = t.mock.method(fs, 'readFileSync', (filename, ...args) => {
        assert.ok(!String(filename).startsWith(assets.directory), `Unexpected asset read: ${filename}`);
        return readFileSync(filename, ...args);
    });
    try {
        assert.equal(responseBody(middleware, '/main.css'), 'body{color:#123456}');
    } finally {
        read.mock.restore();
    }

    fs.unlinkSync(link);
    watcher.emit('all', 'unlinkDir', link);
    assert.throws(() => responseBody(middleware, '/main.css'), /find stylesheet to import/i);
});

test('lazy watch mode supports custom Sass importer schemes without watching their virtual URLs', { timeout: 15000 }, async t => {
    const assets = fixture(t, {
        'public/main.scss': '@use "virtual:palette" as palette; body { color: palette.$accent; }'
    });
    const { middleware, watcher, ready } = assets.start({
        warmup: false,
        sass: {
            importers: [{
                canonicalize(url) {
                    return url === 'virtual:palette' ? new URL(url) : null;
                },
                load() {
                    return { contents: '$accent: #abcdef;', syntax: 'scss' };
                }
            }]
        }
    });
    await ready;
    const add = t.mock.method(watcher, 'add');
    assert.equal(responseBody(middleware, '/main.css'), 'body{color:#abcdef}');
    const dependencies = add.mock.calls.flatMap(call => call.arguments[0]);
    assert.ok(dependencies.includes(path.join(assets.directory, 'main.scss')));
    assert.ok(dependencies.every(filename => path.isAbsolute(filename)));
    assert.ok(dependencies.every(filename => !filename.includes('virtual:')));
});
