const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const chokidar = require('chokidar').default;

const electricity = require('../lib');

function watchedFixture(t, assets, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electricity-dependencies-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    for (const [name, source] of Object.entries(assets)) {
        const filename = path.join(directory, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, source);
    }

    const handlers = new Map();
    const registrations = [];
    const watcher = {
        on(event, handler) {
            handlers.set(event, handler);
            return this;
        },
        add(dependencies) {
            registrations.push([...dependencies]);
            return this;
        }
    };
    t.mock.method(chokidar, 'watch', () => watcher);

    const middleware = electricity.static(directory, {
        ...options,
        babel: { comments: false },
        hashify: false,
        uglifyjs: { enabled: false },
        warmup: false,
        watch: { enabled: true }
    });

    return {
        directory,
        middleware,
        registrations,
        notify(event, filename) {
            handlers.get('all')(event, filename);
        },
        ready(watched) {
            watcher.getWatched = () => watched;
            handlers.get('ready')();
        }
    };
}

function responseBody(middleware, url) {
    let body;
    middleware({ get: () => {}, headers: {}, method: 'GET', path: url }, {
        send: content => { body = content; },
        set: () => {}
    }, error => {
        assert.ifError(error);
        assert.fail(`Expected an asset response for ${url}`);
    });
    assert.notEqual(body, undefined);
    return body.toString();
}

function updateSource(filename, source, previousTime = fs.statSync(filename).mtimeMs) {
    fs.writeFileSync(filename, source);
    const changed = new Date(previousTime + 1000);
    fs.utimesSync(filename, changed, changed);
}

test('a transitive JavaScript dependency invalidates every cached parent and preserves unrelated assets', t => {
    const { directory, middleware, registrations, notify } = watchedFixture(t, {
        'shared/leaf.js': 'globalThis.shared = "before";',
        'shared/middle.js': '//= require leaf.js\nglobalThis.middle = true;',
        'first.js': '//= require shared/middle.js\nglobalThis.first = true;',
        'second.js': '//= require shared/middle.js\nglobalThis.second = true;',
        'unrelated.js': 'globalThis.unrelated = "cached";',
        'unrelated.txt': 'cached text'
    });
    const leaf = path.join(directory, 'shared/leaf.js');
    const middle = path.join(directory, 'shared/middle.js');

    for (const name of ['first', 'second']) {
        assert.match(responseBody(middleware, `/${name}.js`), /shared = "before"/);
        assert.deepEqual(new Set(registrations.at(-1)), new Set([
            path.join(directory, `${name}.js`), middle, leaf
        ]));
    }
    const unrelated = responseBody(middleware, '/unrelated.js');
    assert.equal(responseBody(middleware, '/unrelated.txt'), 'cached text');
    updateSource(path.join(directory, 'unrelated.js'), 'globalThis.unrelated = "rebuilt";');
    updateSource(leaf, 'globalThis.shared = "after";');
    notify('change', leaf);

    for (const name of ['first', 'second']) {
        const content = responseBody(middleware, `/${name}.js`);
        assert.match(content, /shared = "after"/);
        assert.doesNotMatch(content, /shared = "before"/);
    }
    const builds = registrations.length;
    assert.equal(responseBody(middleware, '/unrelated.js'), unrelated);
    assert.equal(responseBody(middleware, '/unrelated.txt'), 'cached text');
    assert.equal(registrations.length, builds, 'unrelated responses remain cached');
});

test('a fallback response retains known dependencies so restoring a missing source rebuilds its parent', t => {
    const { directory, middleware, registrations, notify } = watchedFixture(t, {
        'leaf.js': 'globalThis.shared = "before";',
        'middle.js': '//= require leaf.js\nglobalThis.middle = true;',
        'main.js': '//= require middle.js\nglobalThis.main = true;'
    });
    const warnings = t.mock.method(console, 'warn', () => {});
    const leaf = path.join(directory, 'leaf.js');
    const previousTime = fs.statSync(leaf).mtimeMs;
    assert.match(responseBody(middleware, '/main.js'), /shared = "before"/);

    fs.unlinkSync(leaf);
    notify('unlink', leaf);
    const fallback = responseBody(middleware, '/main.js');
    assert.match(fallback, /globalThis\.main = true/);
    assert.doesNotMatch(fallback, /globalThis\.shared/);
    assert.ok(warnings.mock.callCount() > 0, 'the missing dependency caused a processing failure');
    assert.ok(registrations.at(-1).includes(leaf), 'the fallback still watches its known dependency');

    updateSource(leaf, 'globalThis.shared = "restored";', previousTime);
    notify('add', leaf);
    const recovered = responseBody(middleware, '/main.js');
    assert.match(recovered, /shared = "restored"/);
    assert.match(recovered, /globalThis\.middle = true/);
    assert.match(recovered, /globalThis\.main = true/);
});

test('deleting a dependency after retargeting its directory symlink invalidates the rebuilt Sass parent', t => {
    let linked;
    const { directory, middleware, registrations, notify, ready } = watchedFixture(t, {
        'first/_palette.scss': '$accent: red;',
        'second/_palette.scss': '$accent: blue;',
        'main.scss': '@use "palette"; body { color: palette.$accent; }'
    }, {
        sass: {
            importers: [{
                findFileUrl(name) {
                    if (name !== 'palette') {
                        return null;
                    }
                    return url.pathToFileURL(path.join(fs.realpathSync(linked), '_palette.scss'));
                }
            }]
        }
    });
    const first = path.join(directory, 'first');
    const second = path.join(directory, 'second');
    linked = path.join(directory, 'linked');
    const dependency = path.join(second, '_palette.scss');
    fs.symlinkSync(first, linked, 'dir');
    ready({
        [directory]: ['first', 'second', 'linked', 'main.scss'],
        [first]: ['_palette.scss'],
        [second]: ['_palette.scss'],
        [linked]: ['_palette.scss']
    });
    assert.equal(responseBody(middleware, '/main.css'), 'body{color:red}');

    fs.unlinkSync(linked);
    fs.symlinkSync(second, linked, 'dir');
    notify('change', linked);
    assert.equal(responseBody(middleware, '/main.css'), 'body{color:blue}');
    assert.ok(registrations.at(-1).includes(fs.realpathSync(dependency)));

    fs.unlinkSync(dependency);
    notify('unlink', path.join(linked, '_palette.scss'));
    let compilationError;
    middleware({ get: () => {}, headers: {}, method: 'GET', path: '/main.css' }, {
        send: () => assert.fail('The deleted import must invalidate the cached CSS'),
        set: () => {}
    }, error => { compilationError = error; });
    assert.ok(compilationError);
    assert.match(compilationError.message, /Can't find stylesheet to import/);
});
