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

    const Worker = workerThreads.Worker;
    const exits = [];
    t.mock.method(workerThreads, 'Worker', function(...args) {
        const worker = new Worker(...args);
        exits.push(events.once(worker, 'exit'));
        return worker;
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
            return { middleware, ready, warmed: Promise.all(exits), watcher, workerCount: () => exits.length };
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

test('watch startup automatically starts one warmup worker', { timeout: 15000 }, async t => {
    const watcher = new events.EventEmitter();
    watcher.add = () => watcher;
    watcher.close = async () => {};
    const assets = fixture(t, { 'public/main.txt': 'warmed at startup' }, () => watcher);
    const { middleware, warmed, workerCount } = assets.start();

    await warmed;
    assert.equal(workerCount(), 1);
    assert.equal(responseBody(middleware, '/main.txt'), 'warmed at startup');
});

test('a cache callback failure is reported without stopping warming', { timeout: 15000 }, async t => {
    const watcher = new events.EventEmitter();
    watcher.close = async () => {};
    const assets = fixture(t, {
        'public/first.scss': '@use "../shared/palette"; body { color: palette.$accent; }',
        'public/later.txt': 'later worker result',
        'shared/_palette.scss': '$accent: #123456;'
    }, () => watcher);
    const failure = new Error('Watch registration failed');
    let shouldThrow = true;
    watcher.add = () => {
        if (shouldThrow) throw failure;
        return watcher;
    };
    const warned = Promise.withResolvers();
    t.mock.method(console, 'warn', (...args) => {
        if (/cache warming failed/i.test(args[0])) {
            warned.resolve(args);
        }
    });
    const { middleware, warmed } = assets.start();

    const [, error] = await warned.promise;
    assert.equal(error, failure);
    shouldThrow = false;
    await warmed;
    assert.equal(responseBody(middleware, '/later.txt'), 'later worker result');
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
    const { middleware, warmed, watcher, ready } = assets.start({ uglifyjs: { enabled: false } });
    await ready;
    await warmed;

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

test('external imports are warmed and watched for subsequent changes', { timeout: 15000 }, async t => {
    const assets = fixture(t, {
        'public/main.js': '//= require ../shared/dep.js\nglobalThis.main = "warm startup";',
        'shared/dep.js': 'globalThis.version = "before";'
    });
    const external = path.join(assets.root, 'shared/dep.js');
    const { middleware, warmed, watcher, ready } = assets.start();
    await ready;
    await warmed;

    while (!watcher.getWatched()[path.dirname(external)]?.includes(path.basename(external))) {
        t.signal.throwIfAborted();
        await timers.setImmediate();
    }

    assert.match(responseBody(middleware, '/main.js'), /version="before"/);
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
    const { middleware, warmed, ready } = assets.start();
    watcher.emit('ready');
    await ready;
    await warmed;
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
