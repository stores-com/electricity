const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const chokidar = require('chokidar').default;

const electricity = require('../lib');

function watchedFixture(t, assets) {
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
        babel: { comments: false },
        hashify: false,
        uglifyjs: { enabled: false },
        watch: { enabled: true }
    });

    return {
        directory,
        middleware,
        registrations,
        notify(event, filename) {
            handlers.get('all')(event, filename);
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
