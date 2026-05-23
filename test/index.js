const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');

const fse = require('fs-extra');

const electricity = require('../lib/index');

test('electricity.static', { concurrency: true }, async (t) => {
    t.test('should default to "public" if a directory isn\'t specified', async () => {
        await new Promise((resolve) => {
            const middleware = electricity.static();

            const req = {
                method: 'GET',
                path: '/robots.txt'
            };

            const next = () => {
                resolve();
            };

            middleware(req, null, next);
        });
    });

    t.test('should return a function', () => {
        const middleware = electricity.static('test/public');
        assert.strictEqual(typeof middleware, 'function');
    });

    t.test('should call next middleware when the specified file can not be found', async () => {
        await new Promise((resolve) => {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: '/not-found.txt'
            };

            const next = (err) => {
                assert.ifError(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    t.test('should call next middleware when the specified URL is a directory', async () => {
        await new Promise((resolve) => {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: '/scripts'
            };

            const next = (err) => {
                assert.ifError(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    t.test('should call next middleware with an error if the specified URL is too long', async () => {
        await new Promise((resolve) => {
            const middleware = electricity.static('test/public');

            const req = {
                method: 'GET',
                path: crypto.randomBytes(256).toString('hex')
            };

            const next = (err) => {
                assert(err);
                resolve();
            };

            middleware(req, null, next);
        });
    });

    t.test('should not throw when options can not be cloned to the warm worker', async () => {
        // A Sass importer is a function, which can't be structured-cloned to
        // the background warm worker. static() must not throw; warming is
        // simply skipped for this instance and the synchronous read still
        // serves the file.
        await new Promise((resolve) => {
            const middleware = electricity.static('test/public', {
                sass: { importers: [() => null] }
            });

            const req = {
                get: () => {},
                method: 'GET',
                path: '/robots.txt'
            };

            const res = {
                redirect: (path) => {
                    assert.strictEqual(path, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                    resolve();
                },
                set: () => {}
            };

            middleware(req, res);
        });
    });

    t.test('babel', async (t) => {
        t.test('preset-react', { concurrency: true }, async (t) => {
            t.test('should transform JSX files', async () => {
                await new Promise((resolve) => {
                    const middleware = electricity.static('test/public', {
                        babel: {},
                        uglifyjs: { enabled: false }
                    });

                    const req = {
                        method: 'GET',
                        path: '/scripts/babel/preset-react.js'
                    };

                    const res = {
                        redirect: (path) => {
                            assert.strictEqual(path, '/scripts/babel/preset-react-50e821151e36c4b7e5c9b831e291df4aa1fb3164.js');

                            const req = {
                                get: () => {},
                                method: 'GET',
                                path
                            };

                            const res = {
                                send: (body) => {
                                    assert.strictEqual(body, 'React.render(/*#__PURE__*/React.createElement("h1", null, "Hello World"), document.body);');
                                    resolve();
                                },
                                set: () => {}
                            };

                            middleware(req, res);
                        },
                        set: () => {}
                    };

                    middleware(req, res);
                });
            });

            t.test('errors', async (t) => {
                //eslint-disable-next-line no-console
                let consoleWarn = console.warn;

                //eslint-disable-next-line no-console
                console.warn = () => {};

                t.after(() => {
                    //eslint-disable-next-line no-console
                    console.warn = consoleWarn;
                });

                t.test('should return file without transformation on an error', async () => {
                    await new Promise((resolve) => {
                        const middleware = electricity.static('test/public');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path: '/scripts/babel/invalid-50c332596d0947cd2cc8d126317bbbde753182d2.js'
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/scripts/babel/invalid.js', (err, expected) => {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    });
                });
            });
        });
    });

    t.test('css', { concurrency: true }, async (t) => {
        t.test('should read .css files direcly from disk', async () => {
            await new Promise((resolve) => {
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
                    redirect: (path) => {
                        assert.strictEqual(path, '/styles/css/test-566c7e6edb86a4700f7f971fef877db61ffc4b43.css');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/styles/css/test.css', (err, expected) => {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should call next middleware with an error if the specified URL is too long', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: `${crypto.randomBytes(256).toString('hex')}.css`
                };

                const next = (err) => {
                    assert(err);
                    resolve();
                };

                middleware(req, null, next);
            });
        });

        t.test('should update URLs', async () => {
            await new Promise((resolve) => {
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
                    redirect: (path) => {
                        assert.strictEqual(path, '/styles/urls/urls-1099c397162ab5919b081f5f87482f0d76a11893.css');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/styles/urls/urls-expected.css', (err, expected) => {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should update URLs and use a CDN', async () => {
            await new Promise((resolve) => {
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
                    redirect: (path) => {
                        assert.strictEqual(path, '/styles/urls/urls-bfa1387489627e7e4798da8d3b83939b8d20dc91.css');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/styles/urls/urls-expected-cdn.css', (err, expected) => {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should call next middleware when the specified file can not be found', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/not-found.css'
                };

                const next = (err) => {
                    assert.ifError(err);
                    resolve();
                };

                middleware(req, null, next);
            });
        });
    });

    t.test('gzip', { concurrency: true }, async (t) => {
        t.test('should gzip TXT files for clients that accept gzip', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: () => {},
                    headers: {
                        'accept-encoding': 'gzip, deflate'
                    },
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: () => {},
                    set: (field, value) => {
                        if (field === 'content-encoding' && value === 'gzip') {
                            resolve();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should not gzip TXT files for clients that do not accept gzip', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: () => {},
                    headers: {},
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: () => {
                        resolve();
                    },
                    set: (field, value) => {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should not gzip PNG files', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: () => {},
                    method: 'GET',
                    path: '/apple-touch-icon-precomposed-217316d510b3122f64bd75f2dc0dcdba6c4786d5.png'
                };

                const res = {
                    send: () => {
                        resolve();
                    },
                    set: (field, value) => {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should not gzip when disabled', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    gzip: {
                        enabled: false
                    }
                });

                const req = {
                    get: () => {},
                    headers: {
                        'accept-encoding': 'gzip, deflate'
                    },
                    method: 'GET',
                    path: '/lorem-ipsum-1866425c51a663f0e9c1b8214c2ba186f6c827e4.txt'
                };

                const res = {
                    send: () => {
                        resolve();
                    },
                    set: (field, value) => {
                        if (field === 'content-encoding' && value === 'gzip') {
                            assert.fail();
                        }
                    }
                };

                middleware(req, res);
            });
        });
    });

    t.test('hashify', { concurrency: true }, async (t) => {
        t.test('should hashify by default', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    redirect: (path) => {
                        assert.strictEqual(path, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/robots.txt', (err, expected) => {
                                    assert(Buffer.compare(body, expected) === 0);
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should not hashify if disabled', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    hashify: false
                });

                const req = {
                    get: () => {},
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    set: () => {},
                    status: (code) => {
                        assert.strictEqual(code, 200);
                    },
                    send: (body) => {
                        fs.readFile('test/public/robots.txt', (err, expected) => {
                            assert(Buffer.compare(body, expected) === 0);
                            resolve();
                        });
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should not hashify if enabled', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    hashify: true
                });

                const req = {
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    redirect: (path) => {
                        assert.strictEqual(path, '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should hashify files without extensions', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/no-extension'
                };

                const res = {
                    redirect: (path) => {
                        assert.strictEqual(path, '/no-extension-2aae6c35c94fcfb415dbe95f408b9ce91ee846ed');
                        resolve();
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });
    });

    t.test('HTTP headers', { concurrency: true }, async (t) => {
        t.test('should allow additional HTTP headers', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    headers: {
                        'access-control-allow-origin': 'https://example.com'
                    }
                });

                const req = {
                    get: () => {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    send: () => {},
                    set: (value) => {
                        if (value['access-control-allow-origin'] === 'https://example.com') {
                            resolve();
                        }
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should return a 304 for a valid if-none-match header', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: (field) => {
                        if (field === 'if-none-match') {
                            return '"423251d722a53966eb9368c65bfd14b39649105d"';
                        }
                    },
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: () => {},
                    sendStatus: (code) => {
                        assert.strictEqual(code, 304);
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should return etag header for invalid if-none-match header', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: (field) => {
                        if (field === 'if-none-match') {
                            return '"invalid"';
                        }
                    },
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: (headers) => {
                        if (headers.etag === '423251d722a53966eb9368c65bfd14b39649105d') {
                            resolve();
                        }
                    },
                    send: () => {}
                };

                middleware(req, res);
            });
        });
    });

    t.test('HTTP methods', { concurrency: true }, async (t) => {
        t.test('should handle HEAD requests', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    get: () => {},
                    method: 'HEAD',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    sendStatus: (code) => {
                        assert.strictEqual(code, 200);
                        resolve();
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('should not handle POST requests', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'POST',
                    path: '/robots.txt'
                };

                const next = () => {
                    resolve();
                };

                middleware(req, null, next);
            });
        });
    });

    t.test('locals', { concurrency: true }, async (t) => {
        t.test('should register a helper function to generate URLs', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    app: {
                        locals: {}
                    },
                    get: () => {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: () => {},
                    send: () => {
                        assert.strictEqual(typeof req.app.locals.electricity.url, 'function');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should return a hashified URL for a file that was previously requested', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    app: {
                        locals: {}
                    },
                    get: () => {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: () => {},
                    send: () => {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should return original URL path when hashify is disabled', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    hashify: false
                });

                const req = {
                    app: {
                        locals: {}
                    },
                    get: () => {},
                    method: 'GET',
                    path: '/robots.txt'
                };

                const res = {
                    set: () => {},
                    send: () => {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), '/robots.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });

        t.test('should return original URL path when the file could not be found', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const next = () => {
                    assert.strictEqual(req.app.locals.electricity.url('/not-found.txt'), '/not-found.txt');
                    resolve();
                };

                const req = {
                    app: {
                        locals: {}
                    },
                    get: () => {},
                    method: 'GET',
                    path: '/not-found.txt'
                };

                middleware(req, null, next);
            });
        });

        t.test('should return an absolute URL when the hostname option is specified', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    hostname: 'cdn.example.com'
                });

                const req = {
                    app: {
                        locals: {}
                    },
                    get: () => {},
                    method: 'GET',
                    path: '/robots-423251d722a53966eb9368c65bfd14b39649105d.txt'
                };

                const res = {
                    set: () => {},
                    send: () => {
                        assert.strictEqual(req.app.locals.electricity.url('/robots.txt'), 'https://cdn.example.com/robots-423251d722a53966eb9368c65bfd14b39649105d.txt');
                        resolve();
                    }
                };

                middleware(req, res);
            });
        });
    });

    t.test('sass', async (t) => {
        t.test('should read .scss files', async () => {
            await new Promise((resolve) => {
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
                    redirect: (path) => {
                        assert.strictEqual(path, '/styles/sass/sass-72298afd35d449aa2d9a4b4acc6acf66ab14d91a.css');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/styles/sass/sass-expected.css', (err, expected) => {
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });
    });

    t.test('snockets', { concurrency: true }, async (t) => {
        t.test('should concatenate files', async () => {
            await new Promise((resolve) => {
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
                    redirect: (path) => {
                        assert.strictEqual(path, '/scripts/snockets/main-07bf096ceb205e7ed26ff09542642cd27d4140e4.js');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/scripts/snockets/main-expected.js', (err, expected) => {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });

        t.test('errors', async (t) => {
            //eslint-disable-next-line no-console
            let consoleWarn = console.warn;

            //eslint-disable-next-line no-console
            console.warn = () => {};

            t.after(() => {
                //eslint-disable-next-line no-console
                console.warn = consoleWarn;
            });

            t.test('should return file without concatenation on an error', async () => {
                await new Promise((resolve) => {
                    const middleware = electricity.static('test/public', {
                        uglifyjs: { enabled: false },
                        watch: { enabled: true }
                    });

                    const req = {
                        get: () => {},
                        method: 'GET',
                        path: '/scripts/snockets/invalid-71f16629fe6cf3e982d38e87ab81c421e4956c8d.js'
                    };

                    const res = {
                        send: (body) => {
                            fs.readFile('test/public/scripts/snockets/invalid.js', (err, expected) => {
                                assert.ifError(err);
                                assert.strictEqual(body, expected.toString());
                                resolve();
                            });
                        },
                        set: () => {}
                    };

                    middleware(req, res);
                });
            });

            t.test('should call next middleware with an error if the specified URL is too long', async () => {
                await new Promise((resolve) => {
                    const middleware = electricity.static('test/public');

                    const req = {
                        method: 'GET',
                        path: `${crypto.randomBytes(256).toString('hex')}.js`
                    };

                    const next = (err) => {
                        assert(err);
                        resolve();
                    };

                    middleware(req, null, next);
                });
            });
        });
    });

    t.test('uglifycss', async (t) => {
        t.test('should uglify files', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/styles/uglifycss/test.css'
                };

                const res = {
                    redirect: (path) => {
                        assert.strictEqual(path, '/styles/uglifycss/test-c08394f9bdad595e2e3a7c5e7851b41bd153204f.css');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/styles/uglifycss/test-expected.css', (err, expected) => {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });
    });

    t.test('uglifyjs', async (t) => {
        t.test('should uglify files', async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public');

                const req = {
                    method: 'GET',
                    path: '/scripts/uglifyjs/test.js'
                };

                const res = {
                    redirect: (path) => {
                        assert.strictEqual(path, '/scripts/uglifyjs/test-bd0e73d5c4845f2f4c39219ae7e4248d122f0c5c.js');

                        const req = {
                            get: () => {},
                            method: 'GET',
                            path
                        };

                        const res = {
                            send: (body) => {
                                fs.readFile('test/public/scripts/uglifyjs/test-expected.js', (err, expected) => {
                                    assert.ifError(err);
                                    assert.strictEqual(body, expected.toString());
                                    resolve();
                                });
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    },
                    set: () => {}
                };

                middleware(req, res);
            });
        });
    });

    t.test('watch', async (t) => {
        await fs.promises.rm('test/public/watch', { recursive: true, force: true });

        t.after(async () => {
            await fs.promises.rm('test/public/watch', { recursive: true, force: true });
        });

        t.test('should watch for file changes', { timeout: 3000 }, async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/foo', 'bar', () => {
                    setTimeout(() => {
                        const req = {
                            method: 'GET',
                            path: '/watch/foo'
                        };

                        const res = {
                            redirect: (path) => {
                                assert.strictEqual(path, '/watch/foo-62cdb7020ff920e5aa642c3d4066950dd1f01f4d');

                                const req = {
                                    get: () => {},
                                    method: 'GET',
                                    path
                                };

                                const res = {
                                    send: (body) => {
                                        assert.strictEqual(body.toString(), 'bar');

                                        fse.outputFile('test/public/watch/foo', 'baz', () => {
                                            setTimeout(() => {
                                                const req = {
                                                    method: 'GET',
                                                    path: '/watch/foo'
                                                };

                                                const res = {
                                                    redirect: (path) => {
                                                        assert.strictEqual(path, '/watch/foo-bbe960a25ea311d21d40669e93df2003ba9b90a2');

                                                        const req = {
                                                            get: () => {},
                                                            method: 'GET',
                                                            path
                                                        };

                                                        const res = {
                                                            send: (body) => {
                                                                assert.strictEqual(body.toString(), 'baz');
                                                                resolve();
                                                            },
                                                            set: () => {}
                                                        };

                                                        middleware(req, res);
                                                    },
                                                    set: () => {}
                                                };

                                                middleware(req, res);
                                            }, 1000);
                                        });
                                    },
                                    set: () => {}
                                };

                                middleware(req, res);
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    }, 1000);
                });
            });
        });

        t.test('should watch for CSS file changes', { timeout: 3000 }, async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/2.scss', 'p{color:red}', () => {
                    fse.outputFile('test/public/watch/1.scss', '@import \'2\';', () => {
                        fse.outputFile('test/public/watch/main.scss', '@import \'1\';', () => {
                            setTimeout(() => {
                                const req = {
                                    method: 'GET',
                                    path: '/watch/main.css'
                                };

                                const res = {
                                    redirect: (path) => {
                                        assert.strictEqual(path, '/watch/main-6f8c504c70c088a326b9973c5e543784625c1a1d.css');

                                        const req = {
                                            get: () => {},
                                            method: 'GET',
                                            path
                                        };

                                        const res = {
                                            send: (body) => {
                                                assert.strictEqual(body.toString(), 'p{color:red}');

                                                fse.outputFile('test/public/watch/2.scss', 'p{color:green}', () => {
                                                    setTimeout(() => {
                                                        const req = {
                                                            method: 'GET',
                                                            path: '/watch/main.css'
                                                        };

                                                        const res = {
                                                            redirect: (path) => {
                                                                assert.strictEqual(path, '/watch/main-4746a8638dcba3d5afe18eef995e31623eb19d4c.css');

                                                                const req = {
                                                                    get: () => {},
                                                                    method: 'GET',
                                                                    path
                                                                };

                                                                const res = {
                                                                    send: (body) => {
                                                                        assert.strictEqual(body.toString(), 'p{color:green}');
                                                                        resolve();
                                                                    },
                                                                    set: () => {}
                                                                };

                                                                middleware(req, res);
                                                            },
                                                            set: () => {}
                                                        };

                                                        middleware(req, res);
                                                    }, 1000);
                                                });
                                            },
                                            set: () => {}
                                        };

                                        middleware(req, res);
                                    },
                                    set: () => {}
                                };

                                middleware(req, res);
                            }, 1000);
                        });
                    });
                });
            });
        });

        t.test('should handle CSS file deletions', { timeout: 3000 }, async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/to-be-deleted.scss', 'p{color:red}', () => {
                    setTimeout(() => {
                        const req = {
                            method: 'GET',
                            path: '/watch/to-be-deleted.css'
                        };

                        const res = {
                            redirect: (path) => {
                                assert.strictEqual(path, '/watch/to-be-deleted-6f8c504c70c088a326b9973c5e543784625c1a1d.css');

                                const req = {
                                    get: () => {},
                                    method: 'GET',
                                    path
                                };

                                const res = {
                                    send: (body) => {
                                        assert.strictEqual(body.toString(), 'p{color:red}');

                                        fs.rm('test/public/watch/to-be-deleted.scss', () => {
                                            setTimeout(() => {
                                                const req = {
                                                    method: 'GET',
                                                    path: '/watch/to-be-deleted.css'
                                                };

                                                const next = (err) => {
                                                    assert.ifError(err);
                                                    resolve();
                                                };

                                                middleware(req, null, next);
                                            }, 1000);
                                        });
                                    },
                                    set: () => {}
                                };

                                middleware(req, res);
                            },
                            set: () => {}
                        };

                        middleware(req, res);
                    }, 1000);
                });
            });
        });

        t.test('should watch for JavaScript file changes', { timeout: 3000 }, async () => {
            await new Promise((resolve) => {
                const middleware = electricity.static('test/public', {
                    uglifyjs: { enabled: false },
                    watch: { enabled: true }
                });

                fse.outputFile('test/public/watch/2.js', 'console.log(\'foo\');', () => {
                    fse.outputFile('test/public/watch/1.js', '//= require 2.js', () => {
                        fse.outputFile('test/public/watch/main.js', '//= require 1.js', () => {
                            setTimeout(() => {
                                const req = {
                                    method: 'GET',
                                    path: '/watch/main.js'
                                };

                                const res = {
                                    redirect: (path) => {
                                        assert.strictEqual(path, '/watch/main-37b45fa05d53a2f9c3677706b4bdf396e5e7547a.js');

                                        const req = {
                                            get: () => {},
                                            method: 'GET',
                                            path
                                        };

                                        const res = {
                                            send: (body) => {
                                                assert.strictEqual(body.toString(), 'console.log(\'foo\');\n//= require 2.js\n//= require 1.js');

                                                fse.outputFile('test/public/watch/2.js', 'console.log(\'bar\');', () => {
                                                    setTimeout(() => {
                                                        const req = {
                                                            method: 'GET',
                                                            path: '/watch/main.js'
                                                        };

                                                        const res = {
                                                            redirect: (path) => {
                                                                assert.strictEqual(path, '/watch/main-d6801be8ba05661e643b005280a2218a857866ab.js');

                                                                const req = {
                                                                    get: () => {},
                                                                    method: 'GET',
                                                                    path
                                                                };

                                                                const res = {
                                                                    send: (body) => {
                                                                        assert.strictEqual(body.toString(), 'console.log(\'bar\');\n//= require 2.js\n//= require 1.js');
                                                                        resolve();
                                                                    },
                                                                    set: () => {}
                                                                };

                                                                middleware(req, res);
                                                            },
                                                            set: () => {}
                                                        };

                                                        middleware(req, res);
                                                    }, 1000);
                                                });
                                            },
                                            set: () => {}
                                        };

                                        middleware(req, res);
                                    },
                                    set: () => {}
                                };

                                middleware(req, res);
                            }, 1000);
                        });
                    });
                });
            });
        });
    });
});
