# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Electricity is an Express middleware for serving static files with built-in optimization features including minification, gzipping, Sass compilation, Snockets concatenation, React JSX transformation, and background cache warming on a worker thread. It follows best practices for web performance without requiring complex build processes. Requires Node.js 24.11.0 or newer.

## Development Commands

### Testing
```bash
# Run full test suite
npm test

# Run tests with coverage and send to Coveralls
npm run coveralls

# Run a specific test file
node --test --test-force-exit --test-reporter=spec test/warmup.js

# Run tests matching a pattern
node --test --test-force-exit --test-reporter=spec --test-name-pattern="pattern" test/*.js
```

### Linting
```bash
# Run ESLint on all files
npx eslint .

# Fix auto-fixable issues
npx eslint . --fix

# Check specific file
npx eslint lib/index.js
```

## Architecture Overview

### Core Components

**Main Module (`lib/index.js`)**
- Exports the `static()` middleware, which owns option defaults, the watcher, cache warming, and HTTP handling
- `staticMiddleware()` handles requests, hash redirects, conditional responses, and gzip, and registers `cache.url` as `app.locals.electricity.url`

**Assets (`lib/assets.js`)**
- `create(directory, options, onFile)` returns the cache that owns processing and its results, with `add()`, `fetch()`, `remove()`, and `url()`
- `fetch()` processes a URL path into a file record (content, content length, content type, SHA1 hash, optional gzip, and dependency paths in watch mode) and memoizes it; CSS URL rewriting recurses through it to resolve sibling hashes
- `add()` adopts a record processed elsewhere, `remove()` evicts entries whose dependencies changed, and `onFile` reports each newly cached file
- `hashify()` and `parse()` are stateless rules for adding and stripping content hashes
- Owns the Snockets instance; the middleware and the warmup worker each create their own cache

**Warmup (`lib/worker.js`)**
- `static()` starts one worker thread running `worker.js`, which walks the public directory, processes every asset, and posts each file record back for `cache.add()`
- The worker posts `{ file, urlPath }` for each asset and `{ error }` for each failure; every failure is reported with `console.warn` and serving continues

**File Processing Pipeline**
1. Request comes in → middleware checks if it's a GET/HEAD request
2. URL is parsed, hash stripped if present
3. File is fetched from cache or processed from disk
4. Transformations applied based on file type:
   - `.scss` → Sass compilation → CSS minification
   - `.js` with JSX → Babel transformation → UglifyJS
   - `.js` with Snockets → Dependency concatenation → minification
   - CSS files → URL rewriting for assets → minification
5. Content is gzipped if applicable
6. Response sent with appropriate headers (Cache-Control, ETag, etc.)

Creating the middleware starts the same pipeline on a worker thread. Requests for assets that have not warmed yet process synchronously.

### Dependencies and Their Roles

- **@babel/core** and **@babel/preset-react**: Transform JSX files for React support using the classic runtime
- **sass**: Compiles SCSS files to CSS and reports loaded files for watch invalidation
- **snockets**: JavaScript concatenation via require directives and dependency chains for watch invalidation
- **uglify-js**: JavaScript minification
- **uglifycss**: CSS minification
- **chokidar**: File watching for development mode
- **mime**: Content-type detection
- **negotiator**: Content negotiation for gzip support

chokidar and mime are ESM-only packages loaded through native `require(esm)`, so their default exports are accessed with `.default`.

### Testing Structure

Tests use `node:test` and run every file in `test/` in its own process:
- `test/index.js`: Middleware functionality, headers, hashing, Sass, Snockets, JSX, minification, gzip, error handling, and watch mode
- `test/dependencies.js`: Watch invalidation of JavaScript and Sass dependency chains and fallbacks
- `test/warmup.js`: Cache warming without watch mode, output parity with lazy processing, option validation, and failure handling
- `test/watch-warmup.js`: Cache warming with watch mode, including invalidation of warmed assets and external imports

Shared test fixtures are in `test/public/` with subdirectories for different asset types. Warmup tests build their own fixtures in temporary directories.

## Configuration Options

The middleware accepts these options:
- `babel`: Babel transformation options
- `gzip.enabled`: Enable/disable gzip (default: true)
- `hashify`: Enable/disable URL hashing (default: true)
- `headers`: Additional HTTP headers
- `hostname`: CDN hostname for URL generation
- `sass`: Sass compilation options
- `snockets`: Snockets concatenation options
- `uglifyjs`: UglifyJS minification options (enabled by default)
- `uglifycss`: UglifyCSS minification options (enabled by default)
- `warmup`: Enable/disable background cache warming (default: true)
- `watch.enabled`: Enable file watching for development

The complete options object is copied into the warmup worker with structured cloning, so options must not contain functions when warming is enabled.

## ESLint Configuration

Located in `eslint.config.js`:
- Uses flat config format (ESLint 9+)
- Node.js globals
- Key rules: single quotes, semicolons required, no trailing spaces, no console
- Ignores: `coverage/` and `test/public/`
