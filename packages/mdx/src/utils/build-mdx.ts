import { createProcessor, type ProcessorOptions } from '@mdx-js/mdx';
import type { VFile } from 'vfile';
import type { Transformer } from 'unified';
import { visit } from 'unist-util-visit';
import type { MdxJsxFlowElement } from 'mdast-util-mdx-jsx';
import type { Literal } from 'mdast';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import matter from 'gray-matter';

type Processor = ReturnType<typeof createProcessor>;

const cache = new Map<string, { processor: Processor; configHash: string }>();

export interface MDXOptions extends ProcessorOptions {
  /**
   * Name of collection
   */
  collection?: string;

  /**
   * Specify a file path for source
   */
  filePath?: string;

  frontmatter?: Record<string, unknown>;

  /**
   * Custom Vfile data
   */
  data?: Record<string, unknown>;

  _compiler?: CompilerOptions;
}

interface CompilerOptions {
  addDependency: (file: string) => void;
}

function cacheKey(group: string, format: string): string {
  return `${group}:${format}`;
}

declare module 'vfile' {
  interface DataMap {
    /**
     * The compiler object from loader
     */
    _compiler?: CompilerOptions;
  }
}

function remarkInclude(this: Processor): Transformer {
  return async (tree, file) => {
    const queue: Promise<void>[] = [];

    visit(tree, 'mdxJsxFlowElement', (node: MdxJsxFlowElement) => {
      if (node.name === 'include') {
        const child = node.children.at(0) as Literal | undefined;

        if (!child || child.type !== 'text') return;
        const specifier = child.value;

        const targetPath = path.resolve(path.dirname(file.path), specifier);

        queue.push(
          fs.readFile(targetPath).then((content) => {
            const parsed = this.parse(matter(content).content);

            if (file.data._compiler) {
              file.data._compiler.addDependency(targetPath);
            }
            Object.assign(node, parsed);
          }),
        );
      }

      return 'skip';
    });

    await Promise.all(queue);
  };
}

/**
 * @param group - The cache group of MDX content, usually the collection name
 * @param configHash - config hash
 * @param source - mdx content
 * @param options - MDX options
 */
export function buildMDX(
  group: string,
  configHash: string,
  source: string,
  options: MDXOptions = {},
): Promise<VFile> {
  const { filePath, frontmatter, data, ...rest } = options;

  let format = options.format;
  if (!format && filePath) {
    format = filePath.endsWith('.mdx') ? 'mdx' : 'md';
  }
  format ??= 'mdx';

  const key = cacheKey(group, format);
  let cached = cache.get(key);

  if (cached === undefined || cached.configHash !== configHash) {
    cached = {
      processor: createProcessor({
        outputFormat: 'program',
        development: process.env.NODE_ENV === 'development',
        ...rest,
        remarkPlugins: [
          // @ts-expect-error -- processor
          remarkInclude,
          ...(rest.remarkPlugins ?? []),
        ],
        format,
      }),

      configHash,
    };

    cache.set(key, cached);
  }

  return cached.processor.process({
    value: source,
    path: filePath,
    data: {
      ...data,
      frontmatter,
      _compiler: options._compiler,
    },
  });
}
