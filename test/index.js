const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const timers = require('node:timers/promises');

const fse = require('fs-extra');

const electricity = require('../lib/index');

function request(middleware, urlPath, options = {}) {
    const result = { headers: {} };
    const headers = options.headers || {};

    middleware({
        method: 'GET',
        ...options,
        path: urlPath,
        headers,
        get: name => headers[name]
    }, {
        redirect: url => { result.redirect = url; },
        send: body => { result.body = body; },
        sendStatus: status => { result.status = status; },
        set: (name, value) => {
            const values = typeof name === 'string' ? { [name]: value } : name;
            for (const [field, contents] of Object.entries(values)) {
                result.headers[field.toLowerCase()] = contents;
            }
        }
    }, error => {
        result.next = true;
        result.error = error;
    });

    if (result.next) {
        assert.deepStrictEqual(result, { headers: {}, next: true, error: result.error }, 'middleware must leave the response untouched when calling next');
    }

    return result;
}

// Exercise lazy requests here; automatic warming is covered in warmup.js.
test('electricity.static', { concurrency: true }, async (t) => {
    await t.test('should default to "public" if a directory isn\'t specified', () => {
        const middleware = electricity.static(undefined, { warmup: false });
        const response = request(middleware, '/robots.txt');
        assert.strictEqual(response.next, true);
        assert.ifError(response.error);
    });

    await t.test('should return a function', () => {
        const middleware = electricity.static('test/public', { warmup: false });
        assert.strictEqual(typeof middleware, 'function');
    });

    await t.test('should call next middleware when the specified file can not be found', () => {
        const middleware = electricity.static('test/public', { warmup: false });
        const response = request(middleware, '/not-found.txt');
        assert.strictEqual(response.next, true);
        assert.ifError(response.error);
    });

    await t.test('should call next middleware when the specified URL is a directory', () => {
        const middleware = electricity.static('test/public', { warmup: false });
        const response = request(middleware, '/scripts');
        assert.strictEqual(response.next, true);
        assert.ifError(response.error);
    });

    await t.test('should call next middleware with an error if the specified URL is too long', () => {
        const middleware = electricity.static('test/public', { warmup: false });
        const response = request(middleware, crypto.randomBytes(256).toString('hex'));
        assert.strictEqual(response.next, true);
        assert(response.error);
    });

    await t.test('babel', async (t) => {
        await t.test('preset-react', { concurrency: true }, async (t) => {
            await t.test('should transform JSX files', () => {
                const middleware = electricity.static('test/public', {
                    warmup: false,
                    babel: {},
                    uglifyjs: { enabled: false }
                });
                const redirect = request(middleware, '/scripts/babel/preset-react.js');
                assert.strictEqual(redirect.redirect, '/scripts/babel/preset-react-50e821151e36c4b7e5c9b831e291df4aa1fb3164.js');
                const response = request(middleware, redirect.redirect);
                assert.strictEqual(response.body, 'React.render(/*#__PURE__*/React.createElement("h1", null, "Hello World"), document.body);');
            });

            await t.test('errors', async (t) => {
                t.mock.method(console, 'warn', () => {});

                await t.test('should return file without transformation on an error', async () => {
                    const middleware = electricity.static('test/public', { warmup: false });
                    const response = request(middleware, '/scripts/babel/invalid-50c332596d0947cd2cc8d126317bbbde753182d2.js');
                    const expected = await fs.readFile('test/public/scripts/babel/invalid.js', 'utf8');
                    assert.strictEqual(response.body, expected);
                });
            });
        });
    });

    await t.test('css', { concurrency: true }, async (t) => {
        await t.test('should read .css files direcly from disk', async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                uglifycss: { enabled: false }
            });
            const redirect = request(middleware, '/styles/css/test.css');
            assert.strictEqual(redirect.redirect, '/styles/css/test-566c7e6edb86a4700f7f971fef877db61ffc4b43.css');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/styles/css/test.css', 'utf8');
            assert.strictEqual(response.body, expected);
        });

        await t.test('should call next middleware with an error if the specified URL is too long', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, `${crypto.randomBytes(256).toString('hex')}.css`);
            assert.strictEqual(response.next, true);
            assert(response.error);
        });

        await t.test('should update URLs', async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                uglifycss: { enabled: false }
            });
            const redirect = request(middleware, '/styles/urls/urls.css');
            assert.strictEqual(redirect.redirect, '/styles/urls/urls-1099c397162ab5919b081f5f87482f0d76a11893.css');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/styles/urls/urls-expected.css', 'utf8');
            assert.strictEqual(response.body, expected);
        });

        await t.test('should update URLs and use a CDN', async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                hostname: 'cdn.example.com',
                uglifycss: { enabled: false }
            });
            const redirect = request(middleware, '/styles/urls/urls.css');
            assert.strictEqual(redirect.redirect, '/styles/urls/urls-bfa1387489627e7e4798da8d3b83939b8d20dc91.css');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/styles/urls/urls-expected-cdn.css', 'utf8');
            assert.strictEqual(response.body, expected);
        });

        await t.test('should call next middleware when the specified file can not be found', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/not-found.css');
            assert.strictEqual(response.next, true);
            assert.ifError(response.error);
        });
    });

    await t.test('gzip', { concurrency: true }, async (t) => {
        await t.test('should gzip TXT files for clients that accept gzip', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt', {
                headers: { 'accept-encoding': 'gzip, deflate' }
            });
            assert.strictEqual(response.headers['content-encoding'], 'gzip');
            assert(Buffer.isBuffer(response.body));
        });

        await t.test('should not gzip TXT files for clients that do not accept gzip', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt');
            assert.strictEqual(response.headers['content-encoding'], undefined);
            assert(Buffer.isBuffer(response.body));
        });

        await t.test('should not gzip PNG files', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/apple-touch-icon-precomposed-217316d510b3122f64bd75f2dc0dcdba6c4786d5.png');
            assert.strictEqual(response.headers['content-encoding'], undefined);
            assert(Buffer.isBuffer(response.body));
        });

        await t.test('should not gzip when disabled', () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                gzip: { enabled: false }
            });
            const response = request(middleware, '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt', {
                headers: { 'accept-encoding': 'gzip, deflate' }
            });
            assert.strictEqual(response.headers['content-encoding'], undefined);
            assert(Buffer.isBuffer(response.body));
        });
    });

    await t.test('hashify', { concurrency: true }, async (t) => {
        await t.test('should hashify by default', async () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const redirect = request(middleware, '/robots.txt');
            assert.strictEqual(redirect.redirect, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/robots.txt');
            assert(Buffer.compare(response.body, expected) === 0);
        });

        await t.test('should not hashify if disabled', async () => {
            const middleware = electricity.static('test/public', { warmup: false, hashify: false });
            const response = request(middleware, '/robots.txt');
            assert.strictEqual(response.redirect, undefined);
            const expected = await fs.readFile('test/public/robots.txt');
            assert(Buffer.compare(response.body, expected) === 0);
        });

        await t.test('should not hashify if enabled', () => {
            const middleware = electricity.static('test/public', { warmup: false, hashify: true });
            const response = request(middleware, '/robots.txt');
            assert.strictEqual(response.redirect, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
        });

        await t.test('should hashify files without extensions', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/no-extension');
            assert.strictEqual(response.redirect, '/no-extension-2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
        });
    });

    await t.test('HTTP headers', { concurrency: true }, async (t) => {
        await t.test('should allow additional HTTP headers', () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                headers: { 'access-control-allow-origin': 'https://example.com' }
            });
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
            assert.strictEqual(response.headers['access-control-allow-origin'], 'https://example.com');
        });

        await t.test('should return a 304 for a valid if-none-match header', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', {
                headers: { 'if-none-match': '"423251d722a53966eb9368c65bfd14b39649105d"' }
            });
            assert.strictEqual(response.status, 304);
            assert.strictEqual(response.body, undefined);
        });

        await t.test('should return etag header for invalid if-none-match header', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', {
                headers: { 'if-none-match': '"invalid"' }
            });
            assert.strictEqual(response.headers.etag, '423251d722a53966eb9368c65bfd14b39649105d');
            assert.strictEqual(response.status, undefined);
            assert(Buffer.isBuffer(response.body));
        });
    });

    await t.test('HTTP methods', { concurrency: true }, async (t) => {
        await t.test('should handle HEAD requests', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', { method: 'HEAD' });
            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body, undefined);
        });

        await t.test('should not handle POST requests', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const response = request(middleware, '/robots.txt', { method: 'POST' });
            assert.strictEqual(response.next, true);
            assert.ifError(response.error);
        });
    });

    await t.test('locals', { concurrency: true }, async (t) => {
        await t.test('should register a helper function to generate URLs', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const app = { locals: {} };
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', { app });
            assert(Buffer.isBuffer(response.body));
            assert.strictEqual(typeof app.locals.electricity.url, 'function');
        });

        await t.test('should return a hashified URL for a file that was previously requested', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const app = { locals: {} };
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', { app });
            assert(Buffer.isBuffer(response.body));
            assert.strictEqual(app.locals.electricity.url('/robots.txt'), '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
        });

        await t.test('should return original URL path when hashify is disabled', () => {
            const middleware = electricity.static('test/public', { warmup: false, hashify: false });
            const app = { locals: {} };
            const response = request(middleware, '/robots.txt', { app });
            assert(Buffer.isBuffer(response.body));
            assert.strictEqual(app.locals.electricity.url('/robots.txt'), '/robots.txt');
        });

        await t.test('should return original URL path when the file could not be found', () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const app = { locals: {} };
            const response = request(middleware, '/not-found.txt', { app });
            assert.strictEqual(response.next, true);
            assert.ifError(response.error);
            assert.strictEqual(app.locals.electricity.url('/not-found.txt'), '/not-found.txt');
        });

        await t.test('should return an absolute URL when the hostname option is specified', () => {
            const middleware = electricity.static('test/public', { warmup: false, hostname: 'cdn.example.com' });
            const app = { locals: {} };
            const response = request(middleware, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt', { app });
            assert(Buffer.isBuffer(response.body));
            assert.strictEqual(app.locals.electricity.url('/robots.txt'), 'https://cdn.example.com/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
        });
    });

    await t.test('sass', async (t) => {
        await t.test('should read .scss files', async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                sass: {},
                uglifycss: { enabled: false }
            });
            const redirect = request(middleware, '/styles/sass/sass.css');
            assert.strictEqual(redirect.redirect, '/styles/sass/sass-72298afd35d449aa2d9a4b4acc6acf66ab14d91a.css');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/styles/sass/sass-expected.css', 'utf8');
            assert.strictEqual(response.body, expected);
        });
    });

    await t.test('snockets', { concurrency: true }, async (t) => {
        await t.test('should concatenate files', async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                snockets: { async: true },
                uglifyjs: { enabled: false }
            });
            const redirect = request(middleware, '/scripts/snockets/main.js');
            assert.strictEqual(redirect.redirect, '/scripts/snockets/main-07bf096ceb205e7ed26ff09542642cd27d4140e4.js');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/scripts/snockets/main-expected.js', 'utf8');
            assert.strictEqual(response.body, expected);
        });

        await t.test('errors', async (t) => {
            t.mock.method(console, 'warn', () => {});

            await t.test('should return file without concatenation on an error', async () => {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    warmup: false,
                    watch: { enabled: true }
                });
                const response = request(middleware, '/scripts/snockets/invalid-71f16629fe6cf3e982d38e87ab81c421e4956c8d.js');
                const expected = await fs.readFile('test/public/scripts/snockets/invalid.js', 'utf8');
                assert.strictEqual(response.body, expected);
            });

            await t.test('should call next middleware with an error if the specified URL is too long', () => {
                const middleware = electricity.static('test/public', { warmup: false });
                const response = request(middleware, `${crypto.randomBytes(256).toString('hex')}.js`);
                assert.strictEqual(response.next, true);
                assert(response.error);
            });
        });
    });

    await t.test('uglifycss', async (t) => {
        await t.test('should uglify files', async () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const redirect = request(middleware, '/styles/uglifycss/test.css');
            assert.strictEqual(redirect.redirect, '/styles/uglifycss/test-c08394f9bdad595e2e3a7c5e7851b41bd153204f.css');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/styles/uglifycss/test-expected.css', 'utf8');
            assert.strictEqual(response.body, expected);
        });
    });

    await t.test('uglifyjs', async (t) => {
        await t.test('should uglify files', async () => {
            const middleware = electricity.static('test/public', { warmup: false });
            const redirect = request(middleware, '/scripts/uglifyjs/test.js');
            assert.strictEqual(redirect.redirect, '/scripts/uglifyjs/test-bd0e73d5c4845f2f4c39219ae7e4248d122f0c5c.js');
            const response = request(middleware, redirect.redirect);
            const expected = await fs.readFile('test/public/scripts/uglifyjs/test-expected.js', 'utf8');
            assert.strictEqual(response.body, expected);
        });
    });

    await t.test('watch', async (t) => {
        await fs.rm('test/public/watch', { recursive: true, force: true });

        t.after(async () => {
            await fs.rm('test/public/watch', { recursive: true, force: true });
        });

        await t.test('should watch for file changes', { timeout: 3000 }, async () => {
            const middleware = electricity.static('test/public', {
                warmup: false,
                watch: { enabled: true }
            });

            await fse.outputFile('test/public/watch/foo', 'bar');
            await timers.setTimeout(1000);

            let response = request(middleware, '/watch/foo');
            assert.strictEqual(response.redirect, '/watch/foo-62cdb7020ff920e5aa642c3d4066950dd1f01f4d');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'bar');

            await fse.outputFile('test/public/watch/foo', 'baz');
            await timers.setTimeout(1000);

            response = request(middleware, '/watch/foo');
            assert.strictEqual(response.redirect, '/watch/foo-bbe960a25ea311d21d40669e93df2003ba9b90a2');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'baz');
        });

        await t.test('should watch for CSS file changes', { timeout: 3000 }, async () => {
            const middleware = electricity.static('test/public', {
                uglifyjs: { enabled: false },
                warmup: false,
                watch: { enabled: true }
            });

            await fse.outputFile('test/public/watch/2.scss', 'p{color:red}');
            await fse.outputFile('test/public/watch/1.scss', '@import \'2\';');
            await fse.outputFile('test/public/watch/main.scss', '@import \'1\';');
            await timers.setTimeout(1000);

            let response = request(middleware, '/watch/main.css');
            assert.strictEqual(response.redirect, '/watch/main-6f8c504c70c088a326b9973c5e543784625c1a1d.css');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'p{color:red}');

            await fse.outputFile('test/public/watch/2.scss', 'p{color:green}');
            await timers.setTimeout(1000);

            response = request(middleware, '/watch/main.css');
            assert.strictEqual(response.redirect, '/watch/main-4746a8638dcba3d5afe18eef995e31623eb19d4c.css');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'p{color:green}');
        });

        await t.test('should handle CSS file deletions', { timeout: 3000 }, async () => {
            const middleware = electricity.static('test/public', {
                uglifyjs: { enabled: false },
                warmup: false,
                watch: { enabled: true }
            });

            await fse.outputFile('test/public/watch/to-be-deleted.scss', 'p{color:red}');
            await timers.setTimeout(1000);

            let response = request(middleware, '/watch/to-be-deleted.css');
            assert.strictEqual(response.redirect, '/watch/to-be-deleted-6f8c504c70c088a326b9973c5e543784625c1a1d.css');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'p{color:red}');

            await fs.rm('test/public/watch/to-be-deleted.scss');
            await timers.setTimeout(1000);

            response = request(middleware, '/watch/to-be-deleted.css');
            assert.ifError(response.error);
            assert.strictEqual(response.next, true);
        });

        await t.test('should watch for JavaScript file changes', { timeout: 3000 }, async () => {
            const middleware = electricity.static('test/public', {
                uglifyjs: { enabled: false },
                warmup: false,
                watch: { enabled: true }
            });

            await fse.outputFile('test/public/watch/2.js', 'console.log(\'foo\');');
            await fse.outputFile('test/public/watch/1.js', '//= require 2.js');
            await fse.outputFile('test/public/watch/main.js', '//= require 1.js');
            await timers.setTimeout(1000);

            let response = request(middleware, '/watch/main.js');
            assert.strictEqual(response.redirect, '/watch/main-37b45fa05d53a2f9c3677706b4bdf396e5e7547a.js');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'console.log(\'foo\');\n//= require 2.js\n//= require 1.js');

            await fse.outputFile('test/public/watch/2.js', 'console.log(\'bar\');');
            await timers.setTimeout(1000);

            response = request(middleware, '/watch/main.js');
            assert.strictEqual(response.redirect, '/watch/main-d6801be8ba05661e643b005280a2218a857866ab.js');
            response = request(middleware, response.redirect);
            assert.strictEqual(response.body.toString(), 'console.log(\'bar\');\n//= require 2.js\n//= require 1.js');
        });
    });
});
