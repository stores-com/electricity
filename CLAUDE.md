# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Electricity is an Express middleware for serving static files with built-in optimization features including minification, gzipping, Sass compilation, Snockets concatenation, and React JSX transformation. It follows best practices for web performance without requiring complex build processes.

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
- Exports `static()` middleware function that owns option defaults, the file cache, the watcher, the warmup worker, and HTTP handling
- Key functions:
  - `cacheFile()`: Puts a file in the cache and watches the sources it was built from
  - `fetchFile()`: Retrieves a file from the cache, processing it when absent
  - `removeFile()`: Removes every cached file built from a changed source
  - `urlBuilder()`: View helper registered as `app.locals.electricity.url`

**Processor (`lib/processor.js`)**
- The only code shared with the warmup worker, and it holds no state
- `processFile(urlPath, options)`: Reads a file and returns its content, response metadata, the sources it was built from, and optional gzip content
- `hashifyUrl()`, `parseUrlPath()`, and `toUrl()`: Rules for adding, stripping, and applying content hashes and the CDN hostname
- Every function takes its subject first and `options` last; `options.directory` carries the asset directory

**Warmup Worker (`lib/worker.js`)**
- Started by `static()` when `options.warmup` is enabled, and knows nothing about the cache
- Walks the asset directory, processes each regular file, and posts `{ file, urlPath }` or `{ error }` back to the middleware, which decides what to cache
- Failures are reported with `console.warn` and serving continues

**File Processing Pipeline**
1. Request comes in → middleware checks if it's a GET/HEAD request
2. URL is parsed, hash stripped if present
3. File is fetched from cache, or processed from disk by `lib/processor.js`
4. Transformations applied based on file type:
   - `.scss` → Sass compilation → CSS minification
   - `.js` with JSX → Babel transformation → UglifyJS
   - `.js` with Snockets → Dependency concatenation → minification
   - CSS files → URL rewriting for assets → minification
5. Content is gzipped if applicable
6. Response sent with appropriate headers (Cache-Control, ETag, etc.)

Creating the middleware runs the same processing on a worker thread, so requests are served from a warm cache. A file the worker has not reached yet is processed on demand.

### Dependencies and Their Roles

- **@babel/core**: Transforms JSX files for React support
- **sass**: Compiles SCSS files to CSS and reports the files it loaded, used for cache invalidation
- **snockets**: JavaScript concatenation via require directives, and the dependency chain used for cache invalidation
- **uglify-js**: JavaScript minification
- **uglifycss**: CSS minification
- **chokidar**: File watching for development mode
- **mime**: Content-type detection
- **negotiator**: Content negotiation for gzip support

### Testing Structure

Tests use `node:test`. `test/index.js` covers:
- Basic middleware functionality
- File serving with proper headers
- Hash generation and URL rewriting
- Sass compilation and dependency tracking
- Snockets concatenation
- JSX transformation
- CSS/JS minification
- Gzip compression
- Error handling
- Watch mode functionality

`test/warmup.js` covers cache warming: output parity with lazy processing, opting out, Sass partials, symlinked directories, failure reporting, and uncloneable options.

Test fixtures are in `test/public/` with subdirectories for different asset types. Warmup tests build their own fixtures in temporary directories.

## Configuration Options

The middleware accepts these options:
- `babel`: Babel transformation options
- `hashify`: Enable/disable URL hashing (default: true)
- `headers`: Additional HTTP headers
- `hostname`: CDN hostname for URL generation
- `sass`: Sass compilation options
- `snockets`: Snockets concatenation options
- `uglifyjs`: UglifyJS minification options (enabled by default)
- `uglifycss`: UglifyCSS minification options (enabled by default)
- `warmup`: Enable/disable cache warming on a worker thread (default: true)
- `watch.enabled`: Enable file watching for development

The options are copied to the warmup worker with structured cloning, so they must not contain functions when warming is enabled.

## ESLint Configuration

Located in `eslint.config.js`:
- Uses flat config format (ESLint 9+)
- ECMAScript 2020 with JSX support
- Node.js globals
- Key rules: single quotes, semicolons required, no trailing spaces
- Ignores: `coverage/` and `test/public/`