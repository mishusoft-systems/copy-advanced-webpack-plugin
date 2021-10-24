import crypto from "crypto";
import path from "path";

import fastGlob from "fast-glob";

import { validate } from "schema-utils";

import { version } from "../package.json";

import normalizePath from "./utils/normalize-path";

import { globby } from "./utils/globby/main";

import schema from "./options.json";
import globParent from "./utils/glob-parent";
import serialize from "./utils/serialize-javascript";
import { readFile, stat } from "./utils/promisify";

// Internal variables
const template = /\[\\*([\w:]+)\\*\]/i;

const isCopied = [];

export default class CopyAdvancedPlugin {
    // Any options should be passed in the constructor of your plugin,
    // (this is a public API of your plugin).
    constructor(options = []) {
        validate(schema, options, {
            name: "Copy Advanced Plugin",
            baseDataPath: "options",
        });

        this.patterns = options.patterns;
        // this.options = options.options || {};
        // Applying user-specified options over the default options
        // and making merged options further available to the plugin methods.
        // You should probably validate all the options here as well.
        this.options = options || {};
    }

    static async createSnapshot(compilation, startTime, dependency) {
        // eslint-disable-next-line consistent-return
        return new Promise((resolve, reject) => {
            compilation.fileSystemInfo.createSnapshot(
                startTime,
                [dependency],
                // eslint-disable-next-line no-undefined
                undefined,
                // eslint-disable-next-line no-undefined
                undefined,
                null,
                (error, snapshot) => {
                    if (error) {
                        reject(error);

                        return;
                    }
                    resolve(snapshot);
                }
            );
        });
    }

    static async checkSnapshotValid(compilation, snapshot) {
        // eslint-disable-next-line consistent-return
        return new Promise((resolve, reject) => {
            compilation.fileSystemInfo.checkSnapshotValid(
                snapshot,
                (error, isValid) => {
                    if (error) {
                        reject(error);

                        return;
                    }
                    resolve(isValid);
                }
            );
        });
    }

    static getContentHash(compiler, compilation, source) {
        const { outputOptions } = compilation;
        const { hashDigest, hashDigestLength, hashFunction, hashSalt } =
            outputOptions;
        const hash = compiler.webpack.util.createHash(hashFunction);

        if (hashSalt) {
            hash.update(hashSalt);
        }

        hash.update(source);

        const fullContentHash = hash.digest(hashDigest);

        return fullContentHash.slice(0, hashDigestLength);
    }

    static async walk(fs, dir, done) {
        fs.readdir(dir, (err, list) => {
            if (err) return done(err);
            return list;
        });
    }

    static async runPattern(
        compiler,
        compilation,
        logger,
        cache,
        inputPattern,
        index
    ) {
        const { RawSource } = compiler.webpack.sources;
        const pattern =
            typeof inputPattern === "string"
                ? { from: inputPattern }
                : { ...inputPattern };

        pattern.fromOrigin = pattern.from;
        pattern.from = path.normalize(pattern.from);
        pattern.context =
            typeof pattern.context === "undefined"
                ? compiler.context
                : path.isAbsolute(pattern.context)
                ? pattern.context
                : path.join(compiler.context, pattern.context);

        logger.log(
            `starting to process a pattern from '${pattern.from}' using '${pattern.context}' context`
        );

        if (path.isAbsolute(pattern.from)) {
            pattern.absoluteFrom = pattern.from;
        } else {
            pattern.absoluteFrom = path.resolve(pattern.context, pattern.from);
        }

        logger.debug(`getting stats for '${pattern.absoluteFrom}'...`);

        const { inputFileSystem } = compiler;

        let stats;

        try {
            stats = await stat(inputFileSystem, pattern.absoluteFrom);
        } catch (error) {
            // Nothing
        }

        // console.log(stats);

        if (stats) {
            if (stats.isDirectory()) {
                pattern.fromType = "dir";
                logger.debug(
                    `determined '${pattern.absoluteFrom}' is a directory`
                );
            } else if (stats.isFile()) {
                pattern.fromType = "file";
                logger.debug(`determined '${pattern.absoluteFrom}' is a file`);
            } else {
                logger.debug(`determined '${pattern.absoluteFrom}' is a glob`);
            }
        }

        // eslint-disable-next-line no-param-reassign
        pattern.globOptions = {
            ...{ followSymbolicLinks: true },
            ...(pattern.globOptions || {}),
            ...{ cwd: pattern.context, objectMode: true },
        };

        pattern.globOptions.fs = inputFileSystem;

        switch (pattern.fromType) {
            case "dir":
                compilation.contextDependencies.add(pattern.absoluteFrom);

                logger.debug(
                    `added '${pattern.absoluteFrom}' as a context dependency`
                );

                /* eslint-disable no-param-reassign */
                pattern.context = pattern.absoluteFrom;
                pattern.glob = path.posix.join(
                    fastGlob.escapePath(
                        normalizePath(path.resolve(pattern.absoluteFrom))
                    ),
                    "**/*"
                );
                pattern.absoluteFrom = path.join(pattern.absoluteFrom, "**/*");

                if (typeof pattern.globOptions.dot === "undefined") {
                    pattern.globOptions.dot = true;
                }
                /* eslint-enable no-param-reassign */
                break;
            case "file":
                compilation.fileDependencies.add(pattern.absoluteFrom);

                logger.debug(
                    `added '${pattern.absoluteFrom}' as a file dependency`
                );

                /* eslint-disable no-param-reassign */
                pattern.context = path.dirname(pattern.absoluteFrom);
                pattern.glob = fastGlob.escapePath(
                    normalizePath(path.resolve(pattern.absoluteFrom))
                );

                if (typeof pattern.globOptions.dot === "undefined") {
                    pattern.globOptions.dot = true;
                }
                /* eslint-enable no-param-reassign */
                break;
            default: {
                const contextDependencies = path.normalize(
                    globParent(pattern.absoluteFrom)
                );

                compilation.contextDependencies.add(contextDependencies);

                logger.debug(
                    `added '${contextDependencies}' as a context dependency`
                );

                /* eslint-disable no-param-reassign */
                pattern.fromType = "glob";
                pattern.glob = path.isAbsolute(pattern.fromOrigin)
                    ? pattern.fromOrigin
                    : path.posix.join(
                          fastGlob.escapePath(
                              normalizePath(path.resolve(pattern.context))
                          ),
                          pattern.fromOrigin
                      );
                /* eslint-enable no-param-reassign */
            }
        }

        logger.log(`begin globbing '${pattern.glob}'...`);

        let paths;

        try {
            // console.log(data);
            paths = await globby(pattern.glob, pattern.globOptions);
        } catch (error) {
            compilation.errors.push(error);

            return;
        }

        // console.log("path");
        // console.log(paths);
        // console.log("pattern");
        // console.log(pattern);

        if (paths.length === 0) {
            if (pattern.noErrorOnMissing) {
                logger.log(
                    `finished to process a pattern from '${pattern.from}' using '${pattern.context}' context to '${pattern.to}'`
                );

                return;
            }

            const missingError = new Error(
                `unable to locate '${pattern.glob}' glob`
            );

            compilation.errors.push(missingError);

            return;
        }

        const filteredPaths = (
            await Promise.all(
                paths.map(async (item) => {
                    // Exclude directories
                    if (!item.dirent.isFile()) {
                        return false;
                    }

                    if (pattern.filter) {
                        let isFiltered;

                        try {
                            isFiltered = await pattern.filter(item.path);
                        } catch (error) {
                            compilation.errors.push(error);

                            return false;
                        }

                        if (!isFiltered) {
                            logger.log(
                                `skip '${item.path}', because it was filtered`
                            );
                        }

                        return isFiltered ? item : false;
                    }

                    return item;
                })
            )
        ).filter((item) => item);

        if (filteredPaths.length === 0) {
            if (pattern.noErrorOnMissing) {
                logger.log(
                    `finished to process a pattern from '${pattern.from}' using '${pattern.context}' context to '${pattern.to}'`
                );

                return;
            }

            const missingError = new Error(
                `unable to locate '${pattern.glob}' glob after filtering paths`
            );

            compilation.errors.push(missingError);

            return;
        }

        const files = await Promise.all(
            filteredPaths.map(async (item) => {
                const from = item.path;

                logger.debug(`found '${from}'`);

                // `globby`/`fast-glob` return the relative path when the path contains special characters on windows
                const absoluteFilename = path.resolve(pattern.context, from);

                pattern.to =
                    typeof pattern.to === "function"
                        ? await pattern.to({
                              context: pattern.context,
                              absoluteFilename,
                          })
                        : path.normalize(
                              typeof pattern.to !== "undefined"
                                  ? pattern.to
                                  : ""
                          );

                const isToDirectory =
                    path.extname(pattern.to) === "" ||
                    pattern.to.slice(-1) === path.sep;

                const toType = pattern.toType
                    ? pattern.toType
                    : template.test(pattern.to)
                    ? "template"
                    : isToDirectory
                    ? "dir"
                    : "file";

                logger.log(
                    `'to' option '${pattern.to}' determinated as '${toType}'`
                );

                const relativeFrom = path.relative(
                    pattern.context,
                    absoluteFilename
                );
                let filename =
                    toType === "dir"
                        ? path.join(pattern.to, relativeFrom)
                        : pattern.to;

                if (path.isAbsolute(filename)) {
                    filename = path.relative(
                        compiler.options.output.path,
                        filename
                    );
                }

                logger.log(
                    `determined that '${from}' should write to '${filename}'`
                );

                const sourceFilename = normalizePath(
                    path.relative(compiler.context, absoluteFilename)
                );

                return {
                    absoluteFilename,
                    sourceFilename,
                    filename,
                    toType,
                };
            })
        );

        let assets;

        try {
            assets = await Promise.all(
                files.map(async (file) => {
                    const {
                        absoluteFilename,
                        sourceFilename,
                        filename,
                        toType,
                    } = file;
                    const info =
                        typeof pattern.info === "function"
                            ? pattern.info(file) || {}
                            : pattern.info || {};
                    const result = {
                        absoluteFilename,
                        sourceFilename,
                        filename,
                        force: pattern.force,
                        info,
                    };

                    // If this came from a glob or dir, add it to the file dependencies
                    if (
                        pattern.fromType === "dir" ||
                        pattern.fromType === "glob"
                    ) {
                        compilation.fileDependencies.add(absoluteFilename);

                        logger.debug(
                            `added '${absoluteFilename}' as a file dependency`
                        );
                    }

                    let cacheEntry;

                    logger.debug(`getting cache for '${absoluteFilename}'...`);

                    try {
                        cacheEntry = await cache.getPromise(
                            `${sourceFilename} | ${index}`,
                            null
                        );
                    } catch (error) {
                        compilation.errors.push(error);

                        return;
                    }

                    if (cacheEntry) {
                        logger.debug(
                            `found cache for '${absoluteFilename}'...`
                        );

                        let isValidSnapshot;

                        logger.debug(
                            `checking snapshot on valid for '${absoluteFilename}'...`
                        );

                        try {
                            isValidSnapshot =
                                await CopyAdvancedPlugin.checkSnapshotValid(
                                    compilation,
                                    cacheEntry.snapshot
                                );
                        } catch (error) {
                            compilation.errors.push(error);

                            return;
                        }

                        if (isValidSnapshot) {
                            logger.debug(
                                `snapshot for '${absoluteFilename}' is valid`
                            );

                            result.source = cacheEntry.source;
                        } else {
                            logger.debug(
                                `snapshot for '${absoluteFilename}' is invalid`
                            );
                        }
                    } else {
                        logger.debug(`missed cache for '${absoluteFilename}'`);
                    }

                    if (!result.source) {
                        const startTime = Date.now();

                        logger.debug(`reading '${absoluteFilename}'...`);

                        let data;

                        try {
                            data = await readFile(
                                inputFileSystem,
                                absoluteFilename
                            );
                        } catch (error) {
                            compilation.errors.push(error);

                            return;
                        }

                        logger.debug(`read '${absoluteFilename}'`);

                        result.source = new RawSource(data);

                        let snapshot;

                        logger.debug(
                            `creating snapshot for '${absoluteFilename}'...`
                        );

                        try {
                            snapshot = await CopyAdvancedPlugin.createSnapshot(
                                compilation,
                                startTime,
                                absoluteFilename
                            );
                        } catch (error) {
                            compilation.errors.push(error);

                            return;
                        }

                        if (snapshot) {
                            logger.debug(
                                `created snapshot for '${absoluteFilename}'`
                            );
                            logger.debug(
                                `storing cache for '${absoluteFilename}'...`
                            );

                            try {
                                await cache.storePromise(
                                    `${sourceFilename} | ${index}`,
                                    null,
                                    {
                                        source: result.source,
                                        snapshot,
                                    }
                                );
                            } catch (error) {
                                compilation.errors.push(error);

                                return;
                            }

                            logger.debug(
                                `stored cache for '${absoluteFilename}'`
                            );
                        }
                    }

                    if (pattern.transform) {
                        const transform =
                            typeof pattern.transform === "function"
                                ? { transformer: pattern.transform }
                                : pattern.transform;

                        if (transform.transformer) {
                            logger.log(
                                `transforming content for '${absoluteFilename}'...`
                            );

                            const buffer = result.source.buffer();

                            if (transform.cache) {
                                const defaultCacheKeys = {
                                    version,
                                    sourceFilename,
                                    transform: transform.transformer,
                                    contentHash: crypto
                                        .createHash("md4")
                                        .update(buffer)
                                        .digest("hex"),
                                    index,
                                };
                                const cacheKeys = `transform | ${serialize(
                                    typeof transform.cache.keys === "function"
                                        ? await transform.cache.keys(
                                              defaultCacheKeys,
                                              absoluteFilename
                                          )
                                        : {
                                              ...defaultCacheKeys,
                                              ...pattern.transform.cache.keys,
                                          }
                                )}`;

                                logger.debug(
                                    `getting transformation cache for '${absoluteFilename}'...`
                                );

                                const cacheItem = cache.getItemCache(
                                    cacheKeys,
                                    cache.getLazyHashedEtag(result.source)
                                );

                                result.source = await cacheItem.getPromise();

                                logger.debug(
                                    result.source
                                        ? `found transformation cache for '${absoluteFilename}'`
                                        : `no transformation cache for '${absoluteFilename}'`
                                );

                                if (!result.source) {
                                    const transformed =
                                        await transform.transformer(
                                            buffer,
                                            absoluteFilename
                                        );

                                    result.source = new RawSource(transformed);

                                    logger.debug(
                                        `caching transformation for '${absoluteFilename}'...`
                                    );

                                    await cacheItem.storePromise(result.source);

                                    logger.debug(
                                        `cached transformation for '${absoluteFilename}'`
                                    );
                                }
                            } else {
                                result.source = new RawSource(
                                    await transform.transformer(
                                        buffer,
                                        absoluteFilename
                                    )
                                );
                            }
                        }
                    }

                    if (toType === "template") {
                        logger.log(
                            `interpolating template '${filename}' for '${sourceFilename}'...`
                        );

                        const contentHash = CopyAdvancedPlugin.getContentHash(
                            compiler,
                            compilation,
                            result.source.buffer()
                        );
                        const ext = path.extname(result.sourceFilename);
                        const base = path.basename(result.sourceFilename);
                        const name = base.slice(0, base.length - ext.length);
                        const data = {
                            filename: normalizePath(
                                path.relative(pattern.context, absoluteFilename)
                            ),
                            contentHash,
                            chunk: {
                                name,
                                id: result.sourceFilename,
                                hash: contentHash,
                                contentHash,
                            },
                        };
                        const { path: interpolatedFilename, info: assetInfo } =
                            compilation.getPathWithInfo(
                                normalizePath(result.filename),
                                data
                            );

                        result.info = { ...result.info, ...assetInfo };
                        result.filename = interpolatedFilename;

                        logger.log(
                            `interpolated template '${filename}' for '${sourceFilename}'`
                        );
                    } else {
                        // eslint-disable-next-line no-param-reassign
                        result.filename = normalizePath(result.filename);
                    }

                    // eslint-disable-next-line consistent-return
                    return result;
                })
            );
        } catch (error) {
            compilation.errors.push(error);

            return;
        }

        logger.log(
            `finished to process a pattern from '${pattern.from}' using '${pattern.context}' context to '${pattern.to}'`
        );

        // eslint-disable-next-line consistent-return
        return assets;
    }

    async run(compiler, compilation, inputPattern, index) {
        if (!isCopied.includes(inputPattern)) {
            isCopied.push(inputPattern);

            // const { RawSource } = compiler.webpack.sources;

            // destruct source destination from input pattern
            const pattern =
                typeof inputPattern === "string"
                    ? { from: inputPattern }
                    : { ...inputPattern };

            pattern.fromOrigin = pattern.from;
            pattern.from = path.normalize(pattern.from);
            pattern.context =
                typeof pattern.context === "undefined"
                    ? compiler.context
                    : path.isAbsolute(pattern.context)
                    ? pattern.context
                    : path.join(compiler.context, pattern.context);
            if (path.isAbsolute(pattern.from)) {
                pattern.absoluteFrom = pattern.from;
            } else {
                pattern.absoluteFrom = path.resolve(
                    pattern.context,
                    pattern.from
                );
            }

            const { inputFileSystem } = compiler;
            let stats;

            try {
                stats = await stat(inputFileSystem, pattern.absoluteFrom);
            } catch (error) {
                // Nothing
            }

            if (stats) {
                if (stats.isDirectory()) {
                    pattern.fromType = "dir";
                } else if (stats.isFile()) {
                    pattern.fromType = "file";
                } else {
                    pattern.fromType = "glob";
                }
            }

            console.log(pattern);
            console.log(stats);
            console.log(isCopied);

            const filteredPaths = (
                await Promise.all(
                    paths.map(async (item) => {
                        // Exclude directories
                        if (!item.dirent.isFile()) {
                            return false;
                        }

                        if (pattern.filter) {
                            let isFiltered;

                            try {
                                isFiltered = await pattern.filter(item.path);
                            } catch (error) {
                                compilation.errors.push(error);

                                return false;
                            }

                            if (!isFiltered) {
                                logger.log(
                                    `skip '${item.path}', because it was filtered`
                                );
                            }

                            return isFiltered ? item : false;
                        }

                        return item;
                    })
                )
            ).filter((item) => item);

            if (filteredPaths.length === 0) {
                if (pattern.noErrorOnMissing) {
                    logger.log(
                        `finished to process a pattern from '${pattern.from}' using '${pattern.context}' context to '${pattern.to}'`
                    );

                    return;
                }

                const missingError = new Error(
                    `unable to locate '${pattern.glob}' glob after filtering paths`
                );

                compilation.errors.push(missingError);

                return;
            }
            const files = await Promise.all(
                filteredPaths.map(async (item) => {
                    const from = item.path;

                    logger.debug(`found '${from}'`);

                    // `globby`/`fast-glob` return the relative path when the path contains special characters on windows
                    const absoluteFilename = path.resolve(
                        pattern.context,
                        from
                    );

                    pattern.to =
                        typeof pattern.to === "function"
                            ? await pattern.to({
                                  context: pattern.context,
                                  absoluteFilename,
                              })
                            : path.normalize(
                                  typeof pattern.to !== "undefined"
                                      ? pattern.to
                                      : ""
                              );

                    const isToDirectory =
                        path.extname(pattern.to) === "" ||
                        pattern.to.slice(-1) === path.sep;

                    const toType = pattern.toType
                        ? pattern.toType
                        : template.test(pattern.to)
                        ? "template"
                        : isToDirectory
                        ? "dir"
                        : "file";

                    logger.log(
                        `'to' option '${pattern.to}' determinated as '${toType}'`
                    );

                    const relativeFrom = path.relative(
                        pattern.context,
                        absoluteFilename
                    );
                    let filename =
                        toType === "dir"
                            ? path.join(pattern.to, relativeFrom)
                            : pattern.to;

                    if (path.isAbsolute(filename)) {
                        filename = path.relative(
                            compiler.options.output.path,
                            filename
                        );
                    }

                    logger.log(
                        `determined that '${from}' should write to '${filename}'`
                    );

                    const sourceFilename = normalizePath(
                        path.relative(compiler.context, absoluteFilename)
                    );

                    return {
                        absoluteFilename,
                        sourceFilename,
                        filename,
                        toType,
                    };
                })
            );

            // console.log(stats);

            // console.log(compiler);
            // console.log(compilation);
            // console.log(item);
            // console.log(index);

            return [compiler, compilation, inputPattern, index];
        }

        return [];
    }

    apply(compiler) {
        const self = this;
        const pluginName = this.constructor.name;
        // const pluginWebpackName = "CopyAdvancedWebpackPlugin";
        // const pluginFullName = "copy-advanced-webpack-plugin";
        // const limit = Limit(this.options.concurrency || 100);

        const { compilation } = compiler;

        compiler.hooks.assetEmitted.tap(pluginName, async () => {
            // console.log(file);
            // // // console.log(info.source);
            // console.log(info.outputPath);
            // console.log(info.targetPath);

            // const allAssetMap = new Map();
            await Promise.all(
                this.patterns.map(async (item, index) => {
                    try {
                        const data = await self.run(
                            compiler,
                            compilation,
                            item,
                            index
                        );
                        console.log(data);
                    } catch (error) {
                        compilation.errors.push(error);
                    }
                })
            );
        });
    }
}
