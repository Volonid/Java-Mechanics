import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

import { Molang } from '@bridge-editor/molang';
import Ajv from 'ajv';
import {
    Node as JsonNode,
    ParseError,
    parse,
    parseTree,
    printParseErrorCode,
} from 'jsonc-parser';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const resourcePackRoot = resolve(repositoryRoot, 'packs/RP');
const errors: string[] = [];

function repositoryPath(path: string): string {
    return relative(repositoryRoot, path).split(sep).join('/');
}

function trackedAndUntrackedFiles(...patterns: string[]): string[] {
    const result = spawnSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
        { cwd: repositoryRoot, encoding: 'utf8' },
    );

    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || 'git ls-files failed');
    }

    return result.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((path) => resolve(repositoryRoot, path))
        .filter(existsSync);
}

function parseJsonc(path: string): unknown {
    const source = readFileSync(path, 'utf8');
    const parseErrors: ParseError[] = [];
    const value = parse(source, parseErrors, {
        allowTrailingComma: true,
        disallowComments: false,
    });

    for (const error of parseErrors) {
        errors.push(
            `${repositoryPath(path)}:${error.offset} ${printParseErrorCode(error.error)}`,
        );
    }

    const treeErrors: ParseError[] = [];
    const tree = parseTree(source, treeErrors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (tree) checkDuplicateKeys(path, tree);

    return value;
}

function checkDuplicateKeys(path: string, node: JsonNode): void {
    if (node.type === 'object' && node.children) {
        const keys = new Set<string>();
        for (const property of node.children) {
            const keyNode = property.children?.[0];
            if (!keyNode || typeof keyNode.value !== 'string') continue;

            if (keys.has(keyNode.value)) {
                errors.push(
                    `${repositoryPath(path)}:${keyNode.offset} duplicate key "${keyNode.value}"`,
                );
            }
            keys.add(keyNode.value);
        }
    }

    for (const child of node.children ?? []) checkDuplicateKeys(path, child);
}

function walk(
    value: unknown,
    visitor: (value: unknown, key: string | undefined, jsonPath: string) => void,
    key?: string,
    jsonPath = '$',
): void {
    visitor(value, key, jsonPath);
    if (Array.isArray(value)) {
        value.forEach((entry, index) => walk(entry, visitor, undefined, `${jsonPath}[${index}]`));
    } else if (value && typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(value)) {
            walk(childValue, visitor, childKey, `${jsonPath}.${childKey}`);
        }
    }
}

const jsonFiles = trackedAndUntrackedFiles('*.json', '*.jsonc');
const parsedJson = new Map<string, unknown>();
for (const path of jsonFiles) parsedJson.set(path, parseJsonc(path));

function validateJsonUi(): void {
    const uiPrefix = `${resolve(resourcePackRoot, 'ui')}${sep}`;
    const uiFiles = jsonFiles.filter((path) => path.startsWith(uiPrefix));
    const definitionsPath = resolve(resourcePackRoot, 'ui/_ui_defs.json');
    const definitions = parsedJson.get(definitionsPath) as { ui_defs?: unknown } | undefined;

    if (!definitions || !Array.isArray(definitions.ui_defs)) {
        errors.push('packs/RP/ui/_ui_defs.json must contain a ui_defs array');
    } else {
        for (const definition of definitions.ui_defs) {
            if (typeof definition !== 'string' || !definition.startsWith('ui/')) {
                errors.push(`packs/RP/ui/_ui_defs.json has invalid entry: ${String(definition)}`);
                continue;
            }

            const target = resolve(resourcePackRoot, definition);
            if (!existsSync(target)) {
                errors.push(`packs/RP/ui/_ui_defs.json references missing file: ${definition}`);
            }
        }
    }

    const schemaPath = resolve(
        import.meta.dirname,
        '../node_modules/@minecraft/bedrock-schemas/schemas/rp/ui/index.schema.json',
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as object;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

    for (const path of uiFiles) {
        if (path === definitionsPath) continue;
        const value = parsedJson.get(path);
        const file = repositoryPath(path);

        if (!validate(value)) {
            for (const error of validate.errors ?? []) {
                errors.push(`${file}${error.instancePath}: ${error.message ?? 'schema error'}`);
            }
        }

        if (
            !file.endsWith('_global_variables.json') &&
            (!value ||
                typeof value !== 'object' ||
                typeof (value as { namespace?: unknown }).namespace !== 'string')
        ) {
            errors.push(`${file} must declare a JSON UI namespace`);
        }

        walk(value, (entry, key, jsonPath) => {
            if (key !== 'texture' || typeof entry !== 'string' || !entry.startsWith('textures/')) {
                return;
            }

            const texturePath = resolve(resourcePackRoot, `${entry}.png`);
            if (!existsSync(texturePath)) {
                errors.push(`${file}${jsonPath} references missing texture ${entry}.png`);
            }
        });
    }
}

function validateMolang(): void {
    const molang = new Molang();
    const molangDirectories = [
        '/animations/',
        '/animation_controllers/',
        '/attachables/',
        '/entity/',
        '/particles/',
        '/render_controllers/',
    ];
    const molangMarker =
        /(?:\b(?:query|variable|temp|context|math|q|v|t|c)\.|[;?]|&&|\|\||==|!=|<=|>=)/u;

    for (const [path, value] of parsedJson) {
        const file = repositoryPath(path);
        if (!file.startsWith('packs/RP/') || !molangDirectories.some((part) => file.includes(part))) {
            continue;
        }

        walk(value, (entry, key, jsonPath) => {
            if (
                (key !== 'pre_animation' && key !== 'initialize') ||
                !Array.isArray(entry) ||
                !entry.every((part) => typeof part === 'string')
            ) {
                return;
            }

            try {
                molang.parse(entry.join(''));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${file}${jsonPath}: invalid combined Molang script: ${message}`);
            }
        });

        walk(value, (entry, _key, jsonPath) => {
            if (
                typeof entry !== 'string' ||
                !molangMarker.test(entry) ||
                /\.scripts\.(?:pre_animation|initialize)\[/u.test(jsonPath)
            ) {
                return;
            }
            try {
                molang.parse(entry);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${file}${jsonPath}: invalid Molang: ${message}`);
            }
        });
    }
}

function validateJavaScript(): void {
    for (const path of trackedAndUntrackedFiles('*.js', '*.cjs', '*.mjs')) {
        const result = spawnSync(process.execPath, ['--check', path], {
            cwd: repositoryRoot,
            encoding: 'utf8',
        });
        if (result.status !== 0) {
            errors.push(`${repositoryPath(path)}: ${result.stderr.trim() || 'JavaScript syntax error'}`);
        }
    }
}

validateJsonUi();
validateMolang();
validateJavaScript();

if (errors.length > 0) {
    console.error(`Content validation failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(
    `Content validation passed: ${jsonFiles.length} JSON/JSONC files, JSON UI links/schema, Molang, and JavaScript syntax.`,
);
