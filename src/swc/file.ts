import slash from "slash";
import { Options, Output } from "@swc/core";
import { dirname, relative } from "path";
import { compile } from "./compile";

import { CliOptions } from "./options";
import { globSources, slitCompilableAndCopyable } from "./sources";
import { SourceMapConsumer, SourceMapGenerator } from "source-map";


async function concatResults(
  file: string,
  results: Map<string, Output>
): Promise<Output> {
  const map = new SourceMapGenerator({
    file,
    sourceRoot: swcOptions.sourceRoot
  });

  let code = "";
  let offset = 0;

  for (const [file, result] of results) {
    code += result.code + "\n";

    if (result.map) {
      const consumer = await new SourceMapConsumer(result.map);
      const sources = new Set<string>();

      consumer.eachMapping(mapping => {
        sources.add(mapping.source);
        map.addMapping({
          generated: {
            line: mapping.generatedLine + offset,
            column: mapping.generatedColumn
          },
          original: {
            line: mapping.originalLine,
            column: mapping.originalColumn
          },
          source: mapping.source
        });
      });

      sources.forEach(source => {
        const content = consumer.sourceContentFor(source, true);
        if (content !== null) {
          map.setSourceContent(source, content);
        }
      });
    }
    offset = code.split("\n").length - 1;
  }

  return {
    code,
    map: JSON.stringify(map)
  };
}

async function outputResults(results: Map<string, Output>) {
  const file = cliOptions.sourceMapTarget || path.basename(cliOptions.outFile || "stdout");

  const result = await concatResults(file, results);

  if (cliOptions.outFile) {
    util.outputFile(result, cliOptions.outFile, swcOptions.sourceMaps);
  } else {
    process.stdout.write(result.code + "\n");
    if (result.map) {
      const map = `//#sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(result.map), 'utf8').toString('base64')}`
      process.stdout.write(map);
    }
  }
}

async function handleCompile(filename: string, outFile: string, sync: boolean, swcOptions: Options) {
  const sourceFileName = slash(relative(dirname(outFile), filename));

  const options = { ...swcOptions, sourceFileName }

  return await compile(
    filename,
    options,
    sync
  );
}

async function initialCompilation(cliOptions: CliOptions, swcOptions: Options) {
  const {
    includeDotfiles,
    filenames,
    copyFiles,
    extensions,
    outFile,
    sync,
    quiet,
    watch,
  } = cliOptions;

  const results = new Map<string, Error | Output>();

  const start = process.hrtime();
  const sourceFiles = await globSources(filenames, includeDotfiles)
  const [
    compilable,
  ] = slitCompilableAndCopyable(sourceFiles, extensions, copyFiles)

  if (sync) {
    for (const filename of compilable) {
      try {
        const result = await handleCompile(filename, outFile, sync, swcOptions);
        if (result) {
          results.set(filename, result);
        }
      } catch (err) {
        console.error(err.message);
        results.set(filename, err);
      }
    }
  } else {
    await Promise.allSettled(compilable.map(file => handleCompile(file, outFile, sync, swcOptions)))
      .then((compiled) => {
        compiled.forEach((result, index) => {
          const filename = compilable[index];
          if (result.status === "fulfilled") {
            if (result.value) {
              results.set(filename, result.value);
            }
          } else {
            results.set(filename, result.reason);
          }
        });
      });
  }
  const end = process.hrtime(start);

  let failed = 0;
  let compiled = 0;
  for (let [_, result] of results) {
    if (result instanceof Error) {
      failed += 1;
    } else {
      compiled += 1;
    }
  }

  if (!quiet && compiled) {
    let message = `Successfully compiled: ${compiled} ${compiled > 1 ? 'files' : 'file'} with swc (%dms)`;
    console.log(message, (end[1] / 1000000).toFixed(2));
  }

  if (failed) {
    console.log(`Failed to compile ${failed} ${failed !== 1 ? "files" : "file"} with swc.`)
    if (!watch) {
      process.exit(1);
    }
  } else {
    await outputResults(results as Map<string, Output>);
  }

  return results
}

export default async function file({
  cliOptions,
  swcOptions
}: {
  cliOptions: CliOptions;
  swcOptions: Options;
}) {
  const {
    watch,
  } = cliOptions;

  const results = await initialCompilation(cliOptions, swcOptions);

  if (watch) {
    await watchCompilation(results, cliOptions, swcOptions);
  }
}
