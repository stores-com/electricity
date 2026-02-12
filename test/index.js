const { after, before, describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');

const fse = require('fs-extra');

const electricity = require('../lib/index');

describe('electricity.static', function() {
    it('should default to "public" if a directory isn\'t specified', async function() {
        await new Promise(function(resolve) {
            const middleware = electricity.static();

            const req = {
                method: 'GET',
                path: '/robots.txt'
            };

            const next = function() {
                resolve();
            };

            middleware(req, null, next);
        });
    });

    it('should return a function', function() {
        const middleware = electricity.static('test/public');
        assert.strictEqual(typeof middleware, 'function');
    });

    it('should call next middleware when the specified file can not be found', async function() {
        await new Promise(function(resolve) {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: '/not-found.txt'
            };

            const next = function(err) {
                assert.ifError(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    it('should call next middleware when the specified URL is a directory', async function() {
        await new Promise(function(resolve) {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: '/scripts'
            };

            const next = function(err) {
                assert.ifError(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    it('should call next middleware with an error if the specified URL is too long', async function() {
        await new Promise(function(resolve) {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: crypto.randomBytes(256).toString('hex')
            };

            const next = function(err) {
                assert(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    describe('babel', function() {
        describe('preset-react', function() {
            it('should transform JSX files', async function() {
                await new Promise(function(resolve) {
                    const middleware = electricity.static('test/public', {
                        babel: {},
                        uglifyjs: { enabled: false }
                    });

                    const req = {
                        method: 'GET',
                        path: '/scripts/babel/preset-react.js'
                    };

                    const res = {
                        redirect: function(path) {
                            assert.strictEqual(path, '/scripts/babel/preset-react-50e821151e36c4b7e5c9b831e291df4aa1fb3164.js');

                            const req = {
                                get: function() {},
                                method: 'GET',
                                path
                            };

                            const res = {
                                send: function(body) {
                                    assert.strictEqual(body, 'React.render(/*#__PURE__*/React.createElement("h1", null, "Hello World"), document.body);');
                                    resolve();
                                },
                                set: function() {}
                            };

                            middleware(req, res);
                        },
                        set: function() {}
                    };

                    middleware(req, res);
                });
            });

            describe('errors', function() {
                //eslint-disable-next-line no-console
                let consoleWarn = console.warn;

                before(function() {
                    //eslint-disable-next-line no-console
                    console.warn = function() {};
                });

                it('should return file without transformation on an error', async function() {
                    await new Promise(function(resolve) {
                        const middleware = electricity.static('test/public');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path: '/scripts/babel/invalid-50c332596d0947cd2cc8d126317bbbde753182d2.js'
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/scripts/babel/invalid.js', function(err, expected) {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    });
                });

                after(function() {
                    //eslint-disable-next-line no-console
                    console.warn = consoleWarn;
                });
            });
        });
    });

    describe('css', function() {
        it('should read .css files direcly from disk', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    uglifycss: {
                        enabled: false
                    }
                });

                const req = {
                    method: 'GET',
                    path: '/styles/css/test.css'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/styles/css/test-566c7e6edb86a4700f7f971fef877db61ffc4b43.css');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/styles/css/test.css', function(err, expected) {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should call next middleware with an error if the specified URL is too long', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: `${crypto.randomBytes(256).toString('hex')}.css`
                };

                const next = function(err) {
                    assert(err);
                    resolve();
                };

                middleware(req, null, next);
            });
        });

        it('should update URLs', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    uglifycss: {
                        enabled: false
                    }
                });

                const req = {
                    method: 'GET',
                    path: '/styles/urls/urls.css'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/styles/urls/urls-1099c397162ab5919b081f5f87482f0d76a11893.css');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/styles/urls/urls-expected.css', function(err, expected) {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should update URLs and use a CDN', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    hostname: 'cdn.example.com',
                    uglifycss: {
                        enabled: false
                    }
                });

                const req = {
                    method: 'GET',
                    path: '/styles/urls/urls.css'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/styles/urls/urls-bfa1387489627e7e4798da8d3b83939b8d20dc91.css');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/styles/urls/urls-expected-cdn.css', function(err, expected) {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should call next middleware when the specified file can not be found', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/not-found.css'
                };

                const next = function(err) {
                    assert.ifError(err);
                    resolve();
                };

                middleware(req, null, next);
            });
        });
    });

    describe('gzip', function() {
        it('should gzip TXT files for clients that accept gzip', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function() {},
                    headers: {
                        'accept-encoding': 'gzip, deflate'
                    },
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: function() {},
                    set: function(field, value) {
                        if (field === 'content-encoding' && value === 'gzip') {
                            resolve();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        it('should not gzip TXT files for clients that do not accept gzip', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function() {},
                    headers: {},
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: function() {
                        resolve();
                    },
                    set: function(field, value) {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        it('should not gzip PNG files', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function() {},
                    method: 'GET',
                    path: '/apple-touch-icon-precomposed-217316d510b3122f64bd75f2dc0dcdba6c4786d5.png'
                };

                const res = {
                    send: function() {
                        resolve();
                    },
                    set: function(field, value) {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        it('should not gzip when disabled', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    gzip: {
                        enabled: false
                    }
                });

                const req = {
                    get: function() {},
                    headers: {
                        'accept-encoding': 'gzip, deflate'
                    },
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: function() {
                        resolve();
                    },
                    set: function(field, value) {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });
    });

    describe('hashify', function() {
        it('should hashify by default', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/robots.txt', function(err, expected) {
                                    assert(Buffer.compare(body, expected) === 0);
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should not hashify if disabled', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    hashify: false
                });

                const req = {
                    get: function() {},
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    set: function() {},
                    status: function(code) {
                        assert.strictEqual(code, 200);
                    },
                    send: function(body) {
                        fs.readFile('test/public/robots.txt', function(err, expected) {
                            assert(Buffer.compare(body, expected) === 0);
                            resolve();
                        });
                    }
                };

                middleware(req, res);
            });
        });

        it('should not hashify if enabled', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    hashify: true
                });

                const req = {
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should hashify files without extensions', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/no-extension'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/no-extension-2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
                        resolve();
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });
    });

    describe('HTTP headers', function() {
        it('should allow additional HTTP headers', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    headers: {
                        'access-control-allow-origin': 'https://example.com'
                    }
                });

                const req = {
                    get: function() {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    send: function() {},
                    set: function(value) {
                        if (value['access-control-allow-origin'] === 'https://example.com') {
                            resolve();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        it('should return a 304 for a valid if-none-match header', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function(field) {
                        if (field === 'if-none-match') {
                            return '"423251d722a53966eb9368c65bfd14b39649105d"';
                        }
                    },
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: function() {},
                    sendStatus: function(code) {
                        assert.strictEqual(code, 304);
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        it('should return etag header for invalid if-none-match header', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function(field) {
                        if (field === 'if-none-match') {
                            return '"invalid"';
                        }
                    },
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: function(headers) {
                        if (headers.etag === '423251d722a53966eb9368c65bfd14b39649105d') {
                            resolve();
                        }
                    },
                    send: function() {}
                };

                middleware(req, res);
            });
        });
    });

    describe('HTTP methods', function() {
        it('should handle HEAD requests', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    get: function() {},
                    method: 'HEAD',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    sendStatus: function(code) {
                        assert.strictEqual(code, 200);
                        resolve();
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        it('should not handle POST requests', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'POST',
                    path: '/robots.txt'
                };

                const next = function() {
                    resolve();
                };

                middleware(req, null, next);
            });
        });
    });

    describe('locals', function() {
        it('should register a helper function to generate URLs', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    app: {
                        locals: {}
                    },
                    get: function() {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: function() {},
                    send: function() {
                        assert.strictEqual(typeof req.app.locals.electricity.url, 'function');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        it('should return a hashified URL for a file that was previously requested', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    app: {
                        locals: {}
                    },
                    get: function() {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: function() {},
                    send: function() {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        it('should return original URL path when hashify is disabled', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    hashify: false
                });

                const req = {
                    app: {
                        locals: {}
                    },
                    get: function() {},
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    set: function() {},
                    send: function() {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), '/robots.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        it('should return original URL path when the file could not be found', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const next = function() {
                    assert.strictEqual(req.app.locals.electricity.url('/not-found.txt'), '/not-found.txt');
                    resolve();
                };

                const req = {
                    app: {
                        locals: {}
                    },
                    get: function() {},
                    method: 'GET',
                    path: '/not-found.txt'
                };

                middleware(req, null, next);
            });
        });

        it('should return an absolute URL when the hostname option is specified', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    hostname: 'cdn.example.com'
                });

                const req = {
                    app: {
                        locals: {}
                    },
                    get: function() {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: function() {},
                    send: function() {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), 'https://cdn.example.com/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });
    });

    describe('sass', function() {
        it('should read .scss files', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    sass: {},
                    uglifycss: {
                        enabled: false
                    }
                });

                const req = {
                    method: 'GET',
                    path: '/styles/sass/sass.css'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/styles/sass/sass-72298afd35d449aa2d9a4b4acc6acf66ab14d91a.css');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/styles/sass/sass-expected.css', function(err, expected) {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });
    });

    describe('snockets', function() {
        it('should concatenate files', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    snockets: {
                        async: true
                    },
                    uglifyjs: {
                        enabled: false
                    }
                });

                const req = {
                    method: 'GET',
                    path: '/scripts/snockets/main.js'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/scripts/snockets/main-07bf096ceb205e7ed26ff09542642cd27d4140e4.js');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/scripts/snockets/main-expected.js', function(err, expected) {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });

        describe('errors', function() {
            //eslint-disable-next-line no-console
            let consoleWarn = console.warn;

            before(function() {
                //eslint-disable-next-line no-console
                console.warn = function() {};
            });

            it('should return file without concatenation on an error', async function() {
                await new Promise(function(resolve) {
                    const middleware = electricity.static('test/public', {
                        uglifyjs: { enabled: false },
                        watch: { enabled: true }
                    });

                    const req = {
                        get: function() {},
                        method: 'GET',
                        path: '/scripts/snockets/invalid-71f16629fe6cf3e982d38e87ab81c421e4956c8d.js'
                    };

                    const res = {
                        send: function(body) {
                            fs.readFile('test/public/scripts/snockets/invalid.js', function(err, expected) {
                                assert.ifError(err);
                                assert.strictEqual(body, expected.toString());
                                resolve();
                            });
                        },
                        set: function() {}
                    };

                    middleware(req, res);
                });
            });

            it('should call next middleware with an error if the specified URL is too long', async function() {
                await new Promise(function(resolve) {
                    const middleware = electricity.static('test/public');

                    const req = {
                        method: 'GET',
                        path: `${crypto.randomBytes(256).toString('hex')}.js`
                    };

                    const next = function(err) {
                        assert(err);
                        resolve();
                    };

                    middleware(req, null, next);
                });
            });

            after(function() {
                //eslint-disable-next-line no-console
                console.warn = consoleWarn;
            });
        });
    });

    describe('uglifycss', function() {
        it('should uglify files', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/styles/uglifycss/test.css'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/styles/uglifycss/test-c08394f9bdad595e2e3a7c5e7851b41bd153204f.css');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/styles/uglifycss/test-expected.css', function(err, expected) {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });
    });

    describe('uglifyjs', function() {
        it('should uglify files', async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/scripts/uglifyjs/test.js'
                };

                const res = {
                    redirect: function(path) {
                        assert.strictEqual(path, '/scripts/uglifyjs/test-bd0e73d5c4845f2f4c39219ae7e4248d122f0c5c.js');

                        const req = {
                            get: function() {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: function(body) {
                                fs.readFile('test/public/scripts/uglifyjs/test-expected.js', function(err, expected) {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    },
                    set: function() {}
                };

                middleware(req, res);
            });
        });
    });

    describe('watch', function() {
        before(async function() {
            await fs.promises.rm('test/public/watch', { recursive: true, force: true });
        });

        it('should watch for file changes', { timeout: 3000 }, async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/foo', 'bar', function() {
                    setTimeout(function() {
                        const req = {
                            method: 'GET',
                            path: '/watch/foo'
                        };

                        const res = {
                            redirect: function(path) {
                                assert.strictEqual(path, '/watch/foo-62cdb7020ff920e5aa642c3d4066950dd1f01f4d');

                                const req = {
                                    get: function() {},
                                    method: 'GET',
                                    path
                                };

                                const res = {
                                    send: function(body) {
                                        assert.strictEqual(body.toString(), 'bar');

                                        fse.outputFile('test/public/watch/foo', 'baz', function() {
                                            setTimeout(function() {
                                                const req = {
                                                    method: 'GET',
                                                    path: '/watch/foo'
                                                };

                                                const res = {
                                                    redirect: function(path) {
                                                        assert.strictEqual(path, '/watch/foo-bbe960a25ea311d21d40669e93df2003ba9b90a2');

                                                        const req = {
                                                            get: function() {},
                                                            method: 'GET',
                                                            path
                                                        };

                                                        const res = {
                                                            send: function(body) {
                                                                assert.strictEqual(body.toString(), 'baz');
                                                                resolve();
                                                            },
                                                            set: function() {}
                                                        };

                                                        middleware(req, res);
                                                    },
                                                    set: function() {}
                                                };

                                                middleware(req, res);
                                            }, 1000);
                                        });
                                    },
                                    set: function() {}
                                };

                                middleware(req, res);
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    }, 1000);
                });
            });
        });

        it('should watch for CSS file changes', { timeout: 3000 }, async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/2.scss', 'p{color:red}', function() {
                    fse.outputFile('test/public/watch/1.scss', '@import \'2\';', function() {
                        fse.outputFile('test/public/watch/main.scss', '@import \'1\';', function() {
                            setTimeout(function() {
                                const req = {
                                    method: 'GET',
                                    path: '/watch/main.css'
                                };

                                const res = {
                                    redirect: function(path) {
                                        assert.strictEqual(path, '/watch/main-6f8c504c70c088a326b9973c5e543784625c1a1d.css');

                                        const req = {
                                            get: function() {},
                                            method: 'GET',
                                            path
                                        };

                                        const res = {
                                            send: function(body) {
                                                assert.strictEqual(body.toString(), 'p{color:red}');

                                                fse.outputFile('test/public/watch/2.scss', 'p{color:green}', function() {
                                                    setTimeout(function() {
                                                        const req = {
                                                            method: 'GET',
                                                            path: '/watch/main.css'
                                                        };

                                                        const res = {
                                                            redirect: function(path) {
                                                                assert.strictEqual(path, '/watch/main-4746a8638dcba3d5afe18eef995e31623eb19d4c.css');

                                                                const req = {
                                                                    get: function() {},
                                                                    method: 'GET',
                                                                    path
                                                                };

                                                                const res = {
                                                                    send: function(body) {
                                                                        assert.strictEqual(body.toString(), 'p{color:green}');
                                                                        resolve();
                                                                    },
                                                                    set: function() {}
                                                                };

                                                                middleware(req, res);
                                                            },
                                                            set: function() {}
                                                        };

                                                        middleware(req, res);
                                                    }, 1000);
                                                });
                                            },
                                            set: function() {}
                                        };

                                        middleware(req, res);
                                    },
                                    set: function() {}
                                };

                                middleware(req, res);
                            }, 1000);
                        });
                    });
                });
            });
        });

        it('should handle CSS file deletions', { timeout: 3000 }, async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/to-be-deleted.scss', 'p{color:red}', function() {
                    setTimeout(function() {
                        const req = {
                            method: 'GET',
                            path: '/watch/to-be-deleted.css'
                        };

                        const res = {
                            redirect: function(path) {
                                assert.strictEqual(path, '/watch/to-be-deleted-6f8c504c70c088a326b9973c5e543784625c1a1d.css');

                                const req = {
                                    get: function() {},
                                    method: 'GET',
                                    path
                                };

                                const res = {
                                    send: function(body) {
                                        assert.strictEqual(body.toString(), 'p{color:red}');

                                        fs.rm('test/public/watch/to-be-deleted.scss', function() {
                                            setTimeout(function() {
                                                const req = {
                                                    method: 'GET',
                                                    path: '/watch/to-be-deleted.css'
                                                };

                                                const next = function(err) {
                                                    assert.ifError(err);
                                                    resolve();
                                                };

                                                middleware(req, null, next);
                                            }, 1000);
                                        });
                                    },
                                    set: function() {}
                                };

                                middleware(req, res);
                            },
                            set: function() {}
                        };

                        middleware(req, res);
                    }, 1000);
                });
            });
        });

        it('should watch for JavaScript file changes', { timeout: 3000 }, async function() {
            await new Promise(function(resolve) {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/2.js', 'console.log(\'foo\');', function() {
                    fse.outputFile('test/public/watch/1.js', '//= require 2.js', function() {
                        fse.outputFile('test/public/watch/main.js', '//= require 1.js', function() {
                            setTimeout(function() {
                                const req = {
                                    method: 'GET',
                                    path: '/watch/main.js'
                                };

                                const res = {
                                    redirect: function(path) {
                                        assert.strictEqual(path, '/watch/main-37b45fa05d53a2f9c3677706b4bdf396e5e7547a.js');

                                        const req = {
                                            get: function() {},
                                            method: 'GET',
                                            path
                                        };

                                        const res = {
                                            send: function(body) {
                                                assert.strictEqual(body.toString(), 'console.log(\'foo\');\n//= require 2.js\n//= require 1.js');

                                                fse.outputFile('test/public/watch/2.js', 'console.log(\'bar\');', function() {
                                                    setTimeout(function() {
                                                        const req = {
                                                            method: 'GET',
                                                            path: '/watch/main.js'
                                                        };

                                                        const res = {
                                                            redirect: function(path) {
                                                                assert.strictEqual(path, '/watch/main-d6801be8ba05661e643b005280a2218a857866ab.js');

                                                                const req = {
                                                                    get: function() {},
                                                                    method: 'GET',
                                                                    path
                                                                };

                                                                const res = {
                                                                    send: function(body) {
                                                                        assert.strictEqual(body.toString(), 'console.log(\'bar\');\n//= require 2.js\n//= require 1.js');
                                                                        resolve();
                                                                    },
                                                                    set: function() {}
                                                                };

                                                                middleware(req, res);
                                                            },
                                                            set: function() {}
                                                        };

                                                        middleware(req, res);
                                                    }, 1000);
                                                });
                                            },
                                            set: function() {}
                                        };

                                        middleware(req, res);
                                    },
                                    set: function() {}
                                };

                                middleware(req, res);
                            }, 1000);
                        });
                    });
                });
            });
        });

        after(async function() {
            await fs.promises.rm('test/public/watch', { recursive: true, force: true });
        });
    });
});
