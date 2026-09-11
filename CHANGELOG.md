# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Opt-in background cache warming with `middleware.warmup()` using a worker thread.

### Changed
- Bump Electricity to 4.0.0 and require Node.js 24.11.0 or newer.
- Upgrade to Babel 8, Chokidar 5, MIME 4.1, and Negotiator 1.1. Custom Babel plugins and options must support Babel 8; generated scripts continue to use the classic React runtime.
- Serve JavaScript with the `text/javascript` content type.

### Fixed
- Use UTF-8 byte lengths for response headers and gzip eligibility, including Unicode JavaScript output.

## [3.6.1] - 2025-01-21
### Changed
- Use `module: false` option to uglify-js. Version 3.18.0+ assume ES6 modules.

## [3.6.0] - 2025-01-15
### Changed
- Switch from `sass.renderSync` to `sass.compile`.

## [3.5.1] - 2024-03-20
### Changed
- Bump chokidar from 3.5.0 to 3.6.0

## [3.5.0] - 2022-12-15
### Changed
- Remove option to eagerly fetch all files in the specified directory (recursively).

## [3.4.0] - 2022-06-03
### Changed
- Bump sass from 1.32.13 to 1.52.2 which introduces this breaking change: https://sass-lang.com/documentation/breaking-changes/slash-div

## [3.3.0] - 2022-03-23
### Changed
- Add option to disable gzip.

## [3.2.0] - 2022-03-22
### Changed
- Eagerly fetch all files in the specified directory (recursively) to help improve performance.

## [3.1.0] - 2022-03-18
### Changed
- Resolve symlinks when looking for SASS dependants to remove from local cache.

## [3.0.0] - 2021-11-17
### Changed
- Version 3.0.0 is a complete rewrite designed to improve application startup times by lazily processing files as they are requested (instead of eagerly processing all files at application start).
- Because files are processed lazily as they are requested, many users should experience reduced memory footprints for their apps.
- We dropped support for the `If-Modified-Since` HTTP header due to the complexities in calculating this accurately for Snockets and SASS dependency graphs. The ETag HTTP header is still supported.
- In v2.9.0 we replaced `react-tools` with `@babel/preset-react`. You can now pass along options to babel.
- When using a CDN hostname we always return absolute URLs with the https:// origin (instead of protocol-relative URLs since this is now an anti-pattern: https://www.paulirish.com/2010/the-protocol-relative-url/).
- We no longer GZip content that is less than 1500 bytes (the size of a single TCP packet).

## [2.9.0] - 2021-11-02
### Changed
- Replaced `react-tools` with `@babel/preset-react`.

## [2.8.0] - 2021-05-04
### Changed
- Replaced `uglify-es` with `uglify-js`.
