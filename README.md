# Electricity

[![Build Status](https://github.com/stores-com/electricity/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/stores-com/electricity/actions?query=workflow%3Abuild+branch%3Amain)
[![Coverage Status](https://coveralls.io/repos/github/stores-com/electricity/badge.svg?branch=main&t=El8a2K)](https://coveralls.io/github/stores-com/electricity?branch=main)
[![npm version](https://img.shields.io/npm/v/electricity)](https://www.npmjs.com/package/electricity)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An alternative to the built-in Express middleware for serving static files.
Electricity follows a number of best practices for making web pages fast.

Requires Node.js 24.11.0 or newer.

The built-in Express middleware for serving static files is great if you need basic support for serving static files.
But if you want to follow [Best Practices for Speeding Up Your Web Site](http://developer.yahoo.com/performance/rules.html) you need something that can concat, gzip, and minify your static files. Electricity does all this and more without the need to create a complicated build process using Grunt or a similar build tool.

## Basic Usage

Typically, in an Express app you'd serve static files using the built-in middleware. Like this:

```javascript
const express = require('express');

app.use(express.static('public'));
```

To begin using Electricity simply replace the default static middleware:

```javascript
const express = require('express');
const electricity = require('electricity');

app.use(electricity.static('public'));
```

## Background Cache Warming

Electricity v4 automatically starts building assets in the background when you create the middleware:

```javascript
const assets = electricity.static('public');
app.use(assets);
```

One Node.js worker thread scans the public directory and runs Electricity's existing compilation, hashing, and gzip pipeline. It builds assets sequentially and sends each completed asset into the serving process's cache, so compilation does not block the HTTP event loop. No additional dependencies or worker pool configuration are needed. The worker exits when the batch finishes; repeated calls to `warmup()` return the same promise.

The scan includes nested directories, directory symlinks, and static assets such as images and fonts. Sass entry points are warmed at their `.css` URLs; underscore-prefixed Sass partials are compiled through their entry points. An existing `.css` file takes precedence over a matching `.scss` file, just as it does for normal requests. Every middleware instance has its own cache and warmup worker; warming is local to that Node.js process.

Warming loads the public assets into memory, with an additional copy held by the worker until it exits. Account for the size of the public directory when using it with large media files.

Requests and the synchronous `electricity.url()` helper continue working while warming runs. An asset requested before it is ready still uses the normal synchronous compilation path. To ensure even the first page uses a warm cache, await completion before accepting traffic:

```javascript
await assets.warmup();
app.listen(3000);
```

To disable automatic warming and build assets only as they are requested:

```javascript
app.use(electricity.static('public', {
    warmup: { enabled: false }
}));
```

You can still call `warmup()` manually when automatic warming is disabled. Warming is intended for assets that stay unchanged for the lifetime of the process. When `watch.enabled` is true, automatic warming is skipped so development keeps its existing lazy compilation and dependency tracking. Calling `warmup()` manually in watch mode rejects.

Asset processing options must be [structured-cloneable](https://nodejs.org/download/release/v24.11.0/docs/api/worker_threads.html#considerations-when-cloning-objects-with-prototypes-classes-and-accessors). Babel plugins can be specified by module path, but inline plugin functions, Sass importer callbacks, and other function-valued asset processing options cannot cross the worker boundary. Disable automatic warming if you need these callbacks. Unsupported options reject the promise without changing normal lazy serving. HTTP headers are not sent to the worker.

If an asset fails to build, warming continues for the remaining files and then rejects with an `AggregateError`; its `errors` array identifies the failed paths. Successfully warmed files remain cached. Compiler warnings and fallback behavior are the same as during a normal request. Worker startup failures or unexpected exits also reject the promise. Automatic warming logs failures with `console.warn` and lets normal serving continue. Calling `warmup()` returns the same promise, including its rejection, so awaiting it before `app.listen()` can prevent startup on failure. When starting warming manually, await the promise or attach a rejection handler.

## View Helper

A common best practice for serving static files is to set a far future `Expires` header: http://developer.yahoo.com/performance/rules.html#expires

When you set a far future `Expires` header you have to change the file name whenever the contents of the file change.
Electricity makes this easy for you by automatically adding an MD5 hash of the file's contents to the file name.
You have access to this file name using a view helper method that builds URLs for you.
If you're using EJS it looks something like this:

```ejs
<img src="<%= electricity.url('/images/image.png') %>" />
<link href="<%= electricity.url('/styles/style.css') %>" rel="stylesheet" />
<script src="<%= electricity.url('/scripts/script.js') %>"></script>
```

Which ultimately gets rendered as something like this:

```html
<img src="/images/image-423251d722a53966eb9368c65bfd14b39649105d.png" />
<link href="/styles/style-22a53914b39649105d66eb9368c65b423251d7fd.css" rel="stylesheet" />
<script src="/scripts/script-5d66eb9368c22a53914b39d7fd6491065b423251.js"></script>
```

## Features

Electricity comes with a variety of features to help make your web pages fast without the need to setup a complicated build process.

- **HTTP Headers:** Electricity sets proper `Cache-Control`, `ETag`, and `Expires`, headers to help avoid unnecessary HTTP requests on subsequent page views.
- **Minification of JavaScript and CSS:** Electricity minifies JavaScript and CSS files in order to improve response time by reducing file sizes.
- **Gzip:** Electricity gzips many content types (CSS, HTML, JavaScript, JSON, plaintext, XML) to reduce response sizes.
- **Background Cache Warming:** Electricity builds and caches assets on a worker thread by default. Disable it with `warmup: { enabled: false }`; watch mode skips it automatically.
- **Snockets:** Electricity supports Snockets (A JavaScript concatenation tool for Node.js inspired by Sprockets). You can use Snockets to combine multiple JavaScript files into a single JavaScript file which helps minimize HTTP requests.
- **Sass:** Electricity supports Sass (Sassy CSS). Among other features, Sass can be used to combine multiple CSS files into a single CSS file which helps minimize HTTP requests. NOTE: We currently only support .scss files (not .sass files written in the older syntax).
- **React JSX:** Electricity transforms JSX using [Babel 8](https://babeljs.io/docs/) with the classic React runtime and development output disabled. Generated scripts use the global `React` object. Custom Babel plugins and options must support Babel 8.
- **CDN Hostname:** If you're using a CDN (Content Delivery Network) that supports a custom origin (like Amazon CloudFront) you can specify the hostname you'd like Electricity to use when generating URLs.
- **Watch:** Electricity watches for changes to your static files and automatically serves the latest content without the need to restart your web server (useful during development). Electricity also understands Sass and Snockets dependency graphs to ensure the parent file contents are updated if a child file has been modified.

## Advanced Usage

Default options look like this:

```javascript
const options = {
    babel: {},
    hashify: true,
    headers: {},
    hostname: '',
    sass: {},
    snockets: {},
    uglifyjs: {
        enabled: true
    },
    uglifycss: {
        enabled: true
    },
    warmup: {
        enabled: true
    },
    watch: {
        enabled: false
    }
};
```

You can override the default options to look something like this:

```javascript
var options = {
    babel: { // Object passed straight to @babel/core options: https://babeljs.io/docs/en/options
        generatorOpts: {
            compact: true
        },
        parserOpts: {
            errorRecovery: true
        }
    },
    hashify: false, // Do not generate hashes for URLs
    headers: { // Any additional headers you want a specify
        'Access-Control-Allow-Origin': 'https://example.com'
    },
    hostname: 'cdn.example.com', // CDN hostname
    sass: { // Object passed straight to node-sass options
        outputStyle: 'compressed',
        quietDeps: true
    },
    snockets: { // Object passed straight to snockets options: https://www.npmjs.com/package/snockets
    },
    uglifyjs: { // Object passed straight to uglify-js options: https://github.com/mishoo/UglifyJS#minify-options
        enabled: false // Do not minify Javascript
    },
    uglifycss: { // Object passed straight to uglifycss options: https://github.com/fmarcia/uglifycss
        enabled: false // Do not minify CSS
    },
    warmup: {
        enabled: false // Build assets only when requested
    }
};
```

Pass options to the middleware like this:

```javascript
app.use(electricity.static('public', options));
```

## HTTP Headers

Electricity sets proper `Cache-Control`, `ETag`, and `Expires` headers to help avoid unnecessary HTTP requests on subsequent page views. If you'd like to specify literal values for specific HTTP headers you can set them in the `headers` option. This is useful if you need to specify a `Access-Control-Allow-Origin` header when loading fonts or JSON data off a CDN.

```
app.use(electricity.static('public', {
    headers: { 'Access-Control-Allow-Origin': '*' }
}));
```

## CSS URI Values

Electricity will automatically rewrite URIs in CSS to use SHA1 hashes (if a matching file is found). For example:

```css
background-image: url(/background.png);
```

becomes this to allow caching and avoid unnecessary redirects:

```css
background-image: url(/background-423251d722a53966eb9368c65bfd14b39649105d.png);
```

## CDN Hostname

If you specify a hostname like this:
```javascript
const express = require('express');
const electricity = require('electricity');

const options = {
    hostname: 'cdn.example.com'
};

app.use(electricity.static('public'), options);
```

Then render URLs using the view helper like this:
```ejs
<img src="<%= electricity.url('/images/image.png') %>" />
<link href="<%= electricity.url('/styles/style.css') %>" rel="stylesheet" />
<script src="<%= electricity.url('/scripts/script.js') %>"></script>
```

Your HTML will ultimately get rendered using absolute URLs like this:
```html
<img src="https://cdn.example.com/images/image-423251d722a53966eb9368c65bfd14b39649105d.png" />
<link href="https://cdn.example.com/styles/style-22a53914b39649105d66eb9368c65b423251d7fd.css" rel="stylesheet" />
<script src="http://cdn.example.com/scripts/script-5d66eb9368c22a53914b39d7fd6491065b423251.js"></script>
```
